/**
 * 数据库抽象。
 *
 * 本地开发与测试走 PGlite（进程内 WASM Postgres），部署机走真 Postgres。
 * 两者共用同一套 SQL —— 因此 SQL 必须按 **PG 14 基线** 写，
 * 不使用 15+ 的新特性（本地 PGlite 是 18，会掩盖不兼容）。
 */

export interface QueryResult<R> {
  rows: R[]
  rowCount: number
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>
  /**
   * 执行多语句 SQL（DDL 脚本）。不支持参数化。
   * 参数化查询走 prepared statement 路径，无法接受多条语句。
   */
  exec(sql: string): Promise<void>
}

export interface Db extends Queryable {
  /**
   * 事务。回调内的所有写入要么全成功要么全回滚。
   *
   * 可靠性契约的多处依赖它（§3.5 wake 与子 run 终态必须同事务），
   * 所以这是唯一的事务入口，不允许手写 BEGIN/COMMIT。
   */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  /** 跨进程事件：部署机用 LISTEN/NOTIFY */
  listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>
  notify(channel: string, payload: string): Promise<void>
  close(): Promise<void>
  readonly kind: 'pglite' | 'postgres'
}

/** 把 $1,$2 风格的参数化查询原样透传；两种驱动都支持。 */
export function one<R>(res: QueryResult<R>): R | undefined {
  return res.rows[0]
}

export function exactlyOne<R>(res: QueryResult<R>, what = 'row'): R {
  const r = res.rows[0]
  if (!r) throw new Error(`expected exactly one ${what}, got ${res.rows.length}`)
  return r
}
