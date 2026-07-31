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
