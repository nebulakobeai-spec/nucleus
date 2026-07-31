import { PgliteDb } from '../../src/db/pglite.js'
import { migrate } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'

/**
 * 测试用数据库：进程内 PGlite + 已应用全部 migration。
 *
 * 每个测试文件建一个，用完 close。内存模式，无磁盘残留。
 */
export async function testDb(): Promise<Db> {
  const db = await PgliteDb.open()
  await migrate(db)
  return db
}

/** 常用：建一个会话，返回 id */
export async function seedConversation(
  db: Db,
  opts: { id?: string; agentId?: string; title?: string } = {},
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID()
  await db.query(
    `insert into conversations(id, title, agent_id) values ($1, $2, $3)`,
    [id, opts.title ?? 'test', opts.agentId ?? 'orchestrator'],
  )
  return id
}
