import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import type { Db, Queryable, QueryResult } from './types.js'

/**
 * PGlite 后端：进程内 WASM Postgres。
 *
 * 用于本地开发与全部 tier 0-3 测试。这台开发机上 Docker 被禁、
 * 本机 Postgres 的 socket 被安全策略拦截，所以 PGlite 是唯一可用的库。
 *
 * 已实测可用：pg_trgm / uuid-ossp / tsvector 全文检索 / LISTEN-NOTIFY /
 * 事务 / jsonb / array / generated column。
 * **不可用：pgvector** —— 因此 v1 的 migration 里不得出现 vector 类型。
 */
export class PgliteDb implements Db {
  readonly kind = 'pglite' as const
  #pg: PGlite
  /** PGlite 是单连接的，事务必须串行化，否则会交错 */
  #txChain: Promise<unknown> = Promise.resolve()

  private constructor(pg: PGlite) {
    this.#pg = pg
  }

  static async open(dataDir?: string): Promise<PgliteDb> {
    if (dataDir) {
      // PGlite 不会自建父目录
      await mkdir(dataDir, { recursive: true })
    }
    const pg = await PGlite.create({
      ...(dataDir ? { dataDir } : {}),
      extensions: { pg_trgm, uuid_ossp },
    })
    await pg.exec(`create extension if not exists pg_trgm; create extension if not exists "uuid-ossp";`)
    return new PgliteDb(pg)
  }

  async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    const r = await this.#pg.query<R>(sql, params as never[])
    // PGlite: SELECT 的 affectedRows=0、rows 有值；无 RETURNING 的 UPDATE 反之。
    // 用 rows.length 会让「改了几行」的判断恒为 0，用 affectedRows 会让 SELECT 计数为 0。
    return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) }
  }

  async exec(sql: string): Promise<void> {
    await this.#pg.exec(sql)
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    // 串行化：PGlite 单连接，并发事务会互相污染
    const run = this.#txChain.then(async () => {
      await this.#pg.exec('begin')
      try {
        const out = await fn(this)
        await this.#pg.exec('commit')
        return out
      } catch (e) {
        try {
          await this.#pg.exec('rollback')
        } catch {
          /* rollback 失败不掩盖原始错误 */
        }
        throw e
      }
    })
    // 链上不传播失败，否则一次事务失败会毒死后续所有事务
    this.#txChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run as Promise<T>
  }

  async listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>> {
    const unsub = await this.#pg.listen(channel, handler)
    return async () => {
      await unsub()
    }
  }

  async notify(channel: string, payload: string): Promise<void> {
    // pg_notify 而非 NOTIFY 字面量，避免 payload 转义问题
    await this.#pg.query('select pg_notify($1, $2)', [channel, payload])
  }

  async close(): Promise<void> {
    await this.#pg.close()
  }
}
