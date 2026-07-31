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
export async function migrate(db: Db, dir?: string): Promise<MigrateResult> {
  const ms = loadMigrations(dir)
  await db.exec(BOOTSTRAP)

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
