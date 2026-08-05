import { describe, expect, it, afterEach } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate, loadMigrations, schemaHash, appliedSchemaHash } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

describe('migrate', () => {
  it('applies all migrations and is idempotent', async () => {
    db = await PgliteDb.open()

    const first = await migrate(db)
    expect(first.applied.length).toBeGreaterThan(0)
    expect(first.alreadyApplied).toEqual([])

    const second = await migrate(db)
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toEqual(first.applied)
    expect(second.schemaHash).toBe(first.schemaHash)
  })

  it('records applied hash matching code expectation', async () => {
    db = await PgliteDb.open()
    const r = await migrate(db)
    expect(await appliedSchemaHash(db)).toBe(r.schemaHash)
    expect(r.schemaHash).toBe(schemaHash(loadMigrations()))
  })

  it('refuses to run when an applied migration file was modified', async () => {
    db = await PgliteDb.open()
    await migrate(db)
    const name = loadMigrations()[0]!.name
    await db.query(`update _migrations set sha = 'tampered' where name = $1`, [name])
    await expect(migrate(db)).rejects.toThrow(/内容已变更/)
  })
})

describe('schema invariants', () => {
  it('terminal attempts cannot be reopened', async () => {
    db = await PgliteDb.open()
    await migrate(db)

    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    await db.query(
      `insert into runs(id, root_run_id, agent_id) values ($1, $1, 'a')`,
      [runId],
    )
    await db.query(
      `insert into run_attempts(id, run_id, attempt_no, status) values ($1, $2, 1, 'running')`,
      [attemptId, runId],
    )

    await db.query(`update run_attempts set status = 'succeeded' where id = $1`, [attemptId])

    await expect(
      db.query(`update run_attempts set status = 'running' where id = $1`, [attemptId]),
    ).rejects.toThrow(/终态/)

    // 非状态字段仍可更新（例如补写 cost）
    await db.query(`update run_attempts set cost_usd = 1.5 where id = $1`, [attemptId])
    const r = await db.query<{ status: string }>(
      `select status from run_attempts where id = $1`,
      [attemptId],
    )
    expect(r.rows[0]!.status).toBe('succeeded')
  })

  it('rejects tool invocations without a side_effect_class', async () => {
    db = await PgliteDb.open()
    await migrate(db)
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    await db.query(`insert into runs(id, root_run_id, agent_id) values ($1,$1,'a')`, [runId])
    await db.query(
      `insert into run_attempts(id, run_id, attempt_no) values ($1,$2,1)`,
      [attemptId, runId],
    )
    await expect(
      db.query(
        `insert into tool_invocations(id, run_attempt_id, seq, tool_name, args_hash, intent_at)
         values ($1,$2,1,'t','h', now())`,
        [crypto.randomUUID(), attemptId],
      ),
    ).rejects.toThrow()
  })

  it('rolls back the whole transaction on failure', async () => {
    db = await PgliteDb.open()
    await migrate(db)
    const runId = crypto.randomUUID()
    await expect(
      db.tx(async (q) => {
        await q.query(`insert into runs(id, root_run_id, agent_id) values ($1,$1,'a')`, [runId])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const r = await db.query(`select 1 from runs where id = $1`, [runId])
    expect(r.rowCount).toBe(0)

    // 事务链未被毒死：后续事务仍可用
    await db.tx(async (q) => {
      await q.query(`insert into runs(id, root_run_id, agent_id) values ($1,$1,'a')`, [
        crypto.randomUUID(),
      ])
    })
  })
})

/**
 * ── 并发迁移 ────────────────────────────────────────
 *
 * pglite 是单进程，所以这件事一直看不见。而 postgres 上「常驻 daemon +
 * 一条 CLI 命令同时启动」是**常态** —— 两边都会跑 migrate，同一个
 * `create table` 撞在一起：一边成功，另一边报 42P07 而整个 boot 失败，
 * 而错误看起来像「schema 坏了」。
 *
 * 真正的并发只能在 postgres 上验，而我的沙箱连不上任何网络（包括 localhost）。
 * 所以这里验的是**能验的那部分**：锁只对 postgres 取、pglite 上不取、
 * 而且同一个库连着迁移两次是幂等的。
 */
describe('并发迁移', () => {
  it('pglite 上不去取 advisory lock —— 那个函数在它那儿不存在', async () => {
    const db = await PgliteDb.open()
    const calls: string[] = []
    const spy = {
      ...db,
      kind: db.kind,
      query: async (sql: string, params?: unknown[]) => {
        calls.push(sql)
        return db.query(sql, params ?? [])
      },
      exec: (sql: string) => db.exec(sql),
      tx: <T>(fn: Parameters<typeof db.tx<T>>[0]) => db.tx(fn),
      listen: db.listen.bind(db),
      notify: db.notify.bind(db),
      close: db.close.bind(db),
    } as unknown as Parameters<typeof migrate>[0]

    await migrate(spy)
    expect(calls.some((s) => s.includes('pg_advisory_lock'))).toBe(false)
    await db.close()
  })

  it('同一个库迁移两次是幂等的 —— 第二次一条都不应用', async () => {
    const db = await PgliteDb.open()
    const first = await migrate(db)
    expect(first.applied.length).toBeGreaterThan(0)
    const second = await migrate(db)
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied.length).toBe(first.applied.length)
    await db.close()
  })
})
