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
  /**
   * 钉住**一条连接**跑一段，不开事务。
   *
   * ── 为什么需要它 ────────────────────────────────
   *
   * `pg_advisory_lock` 是**会话级**的 —— 锁属于那条连接。而 `query()` 走连接池：
   * 加锁的语句借一条连接、查完就还回去，后面的语句可能换了另一条。
   * 于是锁看起来加上了，实际上什么都没串起来；而 `pg_advisory_unlock`
   * 从另一条连接调还会失败，锁一直留到那条池连接被关掉。
   *
   * 这是实测抓到的：三个进程同时 `nucleus migrate`，两个挂在
   * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
   * —— 两个 `CREATE TABLE` 撞在一起的样子。**会话锁和连接池不能这么配。**
   *
   * 与 `tx` 的区别是它**不开事务** —— 迁移要「每条一个事务」（失败时前面的
   * 保持已应用），所以不能整个包进一个 tx 里。
   */
  session<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
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

