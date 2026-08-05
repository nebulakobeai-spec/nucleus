import pg from 'pg'
import type { Db, Queryable, QueryResult } from './types.js'

/**
 * 真 Postgres 后端（部署机）。
 *
 * SQL 与 PGlite 完全共用，因此必须保持 PG 14 兼容。
 */
export class PostgresDb implements Db {
  readonly kind = 'postgres' as const
  #pool: pg.Pool
  #listenClient: pg.Client | null = null
  #handlers = new Map<string, Set<(p: string) => void>>()

  private constructor(pool: pg.Pool) {
    this.#pool = pool
  }

  static async open(connectionString: string): Promise<PostgresDb> {
    const pool = new pg.Pool({ connectionString, max: 10 })
    // fail fast：连不上就别启动
    const c = await pool.connect()
    c.release()
    return new PostgresDb(pool)
  }

  async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    const r = await this.#pool.query(sql, params)
    return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length }
  }

  async exec(sql: string): Promise<void> {
    await this.#pool.query(sql)
  }

  /**
   * 钉一条连接，不开事务。
   *
   * `query()` 每次从池里借一条 —— 会话级的 `pg_advisory_lock` 因此串不起来。
   * 这里把同一条 client 交给回调，锁与解锁就落在同一个会话上。
   */
  async session<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    try {
      return await fn({
        query: async <R>(sql: string, params: unknown[] = []) => {
          const r = await client.query(sql, params)
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length }
        },
        exec: async (sql: string) => {
          await client.query(sql)
        },
      })
    } finally {
      /**
       * `release(true)` **销毁**这条连接而不是还回池子。
       *
       * 会话锁如果因为任何原因没解开（比如中途抛异常、或者解锁语句本身失败），
       * 还回池子就意味着**下一个借到它的人带着一把别人的锁** ——
       * 而那把锁再也不会被解开。销毁掉是唯一干净的收尾。
       */
      client.release(true)
    }
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('begin')
      const q: Queryable = {
        query: async <R>(sql: string, params: unknown[] = []) => {
          const r = await client.query(sql, params)
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length }
        },
        exec: async (sql: string) => {
          await client.query(sql)
        },
      }
      const out = await fn(q)
      await client.query('commit')
      return out
    } catch (e) {
      try {
        await client.query('rollback')
      } catch {
        /* 不掩盖原始错误 */
      }
      throw e
    } finally {
      client.release()
    }
  }

  async #ensureListenClient(): Promise<pg.Client> {
    if (this.#listenClient) return this.#listenClient
    const c = new pg.Client({ connectionString: (this.#pool as never as { options: { connectionString: string } }).options.connectionString })
    await c.connect()
    c.on('notification', (msg) => {
      const hs = this.#handlers.get(msg.channel)
      if (hs) for (const h of hs) h(msg.payload ?? '')
    })
    this.#listenClient = c
    return c
  }

  async listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>> {
    const c = await this.#ensureListenClient()
    let set = this.#handlers.get(channel)
    if (!set) {
      set = new Set()
      this.#handlers.set(channel, set)
      // 标识符不能参数化；channel 由代码内部提供，非用户输入
      await c.query(`listen ${pg.escapeIdentifier(channel)}`)
    }
    set.add(handler)
    return async () => {
      set!.delete(handler)
      if (set!.size === 0) {
        this.#handlers.delete(channel)
        await c.query(`unlisten ${pg.escapeIdentifier(channel)}`)
      }
    }
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.#pool.query('select pg_notify($1, $2)', [channel, payload])
  }

  async close(): Promise<void> {
    if (this.#listenClient) await this.#listenClient.end()
    await this.#pool.end()
  }
}
