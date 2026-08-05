import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './types.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

export interface Migration {
  name: string
  sql: string
  sha: string
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8')
      return { name, sql, sha: createHash('sha256').update(sql).digest('hex').slice(0, 16) }
    })
}

/**
 * 已应用 migration 集合的指纹。
 *
 * `doctor` 用它检测 schema drift —— 最常见的部署事故是「忘了跑 migrate」，
 * 这个 hash 能在启动时就抓住，而不是等到运行时报出莫名其妙的列不存在。
 */
export function schemaHash(ms: Migration[]): string {
  const h = createHash('sha256')
  for (const m of ms) h.update(m.name).update(m.sha)
  return h.digest('hex').slice(0, 16)
}

const BOOTSTRAP = `
create table if not exists _migrations (
  name        text primary key,
  sha         text not null,
  applied_at  timestamptz not null default now()
);`

export interface MigrateResult {
  applied: string[]
  alreadyApplied: string[]
  schemaHash: string
}

/**
 * Forward-only migration。不支持 down —— 回滚靠重建库或写新的 forward migration。
 * 个人部署场景下 down migration 的维护成本远高于收益。
 */
/**
 * 迁移用的 advisory lock id。
 *
 * 任意常数，只要全项目唯一。用 `pg_advisory_lock` 而不是自己建一张锁表：
 * 它**跟着连接自动释放** —— 进程在迁移中途被 kill 掉时锁不会留下来，
 * 而一张锁表会，然后下一次启动会永远等一个不存在的持有者。
 */
const MIGRATE_LOCK = 0x6e75636c // 'nucl'

export async function migrate(db: Db, dir?: string): Promise<MigrateResult> {
  const ms = loadMigrations(dir)
  await db.exec(BOOTSTRAP)

  /**
   * **并发迁移要串起来。**
   *
   * pglite 是单进程，所以这件事一直看不见。而 postgres 上「常驻 daemon +
   * 一条 CLI 命令同时启动」是**常态** —— 两边都会跑 migrate，于是同一个
   * `create table` 撞在一起：一边成功，另一边报 42P07（已存在）而整个 boot 失败，
   * 而错误看起来像「schema 坏了」。
   *
   * `pg_advisory_lock` 是会话级的，pglite 上不存在 —— 那边不需要，
   * 所以拿不到函数时直接跳过（`kind` 判一下比 try/catch 清楚：
   * 后者会把真正的权限错误也一起吞掉）。
   */
  const needsLock = db.kind === 'postgres'
  if (needsLock) await db.query('select pg_advisory_lock($1)', [MIGRATE_LOCK])
  try {
    return await applyAll(db, ms)
  } finally {
    if (needsLock) {
      await db.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {
        // 连接已断时解锁会失败 —— 而那时锁本来就随连接释放了
      })
    }
  }
}

async function applyAll(db: Db, ms: Migration[]): Promise<MigrateResult> {

  /**
   * 拿到锁**之后**才读已应用清单。
   *
   * 等锁期间另一个进程可能已经把全部迁移跑完了 —— 在锁之前读的话这里会拿到
   * 一份过期的清单，然后重跑那些迁移并撞 42P07。
   */
  const existing = await db.query<{ name: string; sha: string }>('select name, sha from _migrations')
  const seen = new Map(existing.rows.map((r) => [r.name, r.sha]))

  const applied: string[] = []
  const alreadyApplied: string[] = []

  for (const m of ms) {
    const prev = seen.get(m.name)
    if (prev !== undefined) {
      if (prev !== m.sha) {
        throw new Error(
          `migration ${m.name} 内容已变更（已应用 sha=${prev}，当前 sha=${m.sha}）。` +
            `已应用的 migration 不可修改，请新增一个 forward migration。`,
        )
      }
      alreadyApplied.push(m.name)
      continue
    }
    // 每个 migration 单独一个事务：失败时前面的保持已应用
    await db.tx(async (q) => {
      await q.exec(m.sql)
      await q.query('insert into _migrations(name, sha) values ($1, $2)', [m.name, m.sha])
    })
    applied.push(m.name)
  }

  return { applied, alreadyApplied, schemaHash: schemaHash(ms) }
}

/** 读取库中已应用集合的 hash，用于与代码期望比对。 */
export async function appliedSchemaHash(db: Db): Promise<string | null> {
  const r = await db.query<{ name: string; sha: string }>(
    `select name, sha from _migrations order by name`,
  )
  if (r.rows.length === 0) return null
  const h = createHash('sha256')
  for (const row of r.rows) h.update(row.name).update(row.sha)
  return h.digest('hex').slice(0, 16)
}
