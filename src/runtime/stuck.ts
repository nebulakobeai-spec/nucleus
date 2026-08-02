import type { Db } from '../db/types.js'

/**
 * 「有 run 挂住了吗」。
 *
 * ── 为什么这不是测试代码，而是产品功能 ────────────────────
 *
 * 「任务挂住却看不出来」是这个项目要修的第一个问题。既然如此，判据本身就该
 * 是可以随时问的一句话，而不是只存在于某个测试文件里的 SQL。
 *
 * 它此前确实只存在于 live 测试里 —— 而那个文件在开发机上跑不了，于是那段
 * SQL 引用了两个**不存在的列**（`tool_invocations.args`，真名是 `args_json`；
 * `run_queue.run_attempt_id`，那张表的键是 `(run_id, attempt_no)`），
 * 一路带到部署机才炸，而且炸了两轮。放进 src 之后由普通测试覆盖，
 * 这类错在本地就会红。
 *
 * ── 判据：非终态不是问题，「没有东西会推动它」才是 ───────────
 *
 * 直觉上会写成「队列必须是空的」「不能有 waiting 的 wake」，但那是错的：
 *
 *  - run 在 `waiting_retry` 时，队列里**本来就该有**一条 `available_at`
 *    在未来的记录 —— 那是重试被正确排上了
 *  - run 在 `waiting_children` 时，**本来就该有**一条 waiting 的 wake
 *
 * 按那两条判，会把**正确的行为**报成故障。真正的故障形状只有一个：
 * 非终态，但既没有排队、也没有在等还活着的子 run —— 那就没有任何东西
 * 会再碰它了。
 */

export interface StuckRun {
  id: string
  agentId: string
  status: string
  rootRunId: string
  createdAt: Date
  /** 最后一次 attempt 的错误码 —— 「为什么停在这」的第一条线索 */
  lastErrorCode: string | null
}

const TERMINAL = `('succeeded','failed','cancelled')`

/**
 * 找出挂住的 run。
 *
 * `rootRunId` 给了就只看那一棵树（测试用），不给就扫全库（doctor 用）。
 */
export async function findStuckRuns(db: Db, rootRunId?: string): Promise<StuckRun[]> {
  const params: unknown[] = []
  let scope = ''
  if (rootRunId) {
    params.push(rootRunId)
    scope = `and r.root_run_id = $1`
  }

  const q = await db.query<{
    id: string
    agent_id: string
    status: string
    root_run_id: string
    created_at: string
    last_error_code: string | null
  }>(
    `select r.id, r.agent_id, r.status, r.root_run_id, r.created_at,
            (select a.error_code from run_attempts a
              where a.run_id = r.id order by a.attempt_no desc limit 1) as last_error_code
       from runs r
      where r.status not in ${TERMINAL}
        ${scope}
        -- 队列里有它（available_at 在未来也算 —— 那是已排好的重试）。
        -- run_queue 的键是 (run_id, attempt_no)，没有 run_attempt_id 这一列
        and not exists (
          select 1 from run_queue q where q.run_id = r.id
        )
        -- 或者它在等还活着的子 run
        and not exists (
          select 1 from runs c
           where c.parent_run_id = r.id and c.status not in ${TERMINAL}
        )
      order by r.created_at`,
    params,
  )

  return q.rows.map((x) => ({
    id: x.id,
    agentId: x.agent_id,
    status: x.status,
    rootRunId: x.root_run_id,
    createdAt: new Date(x.created_at),
    lastErrorCode: x.last_error_code,
  }))
}

/**
 * 结果未知的工具调用。
 *
 * 与重试无关，无条件成立：`outcome is null` 表示「已经写了意图但不知道结果」。
 * 对 `non_idempotent` 的工具，这是**绝不能自动重跑**的那一类，必须转人工。
 */
export async function findUnknownToolOutcomes(
  db: Db,
  rootRunId?: string,
): Promise<Array<{ toolName: string; sideEffectClass: string; runId: string }>> {
  const params: unknown[] = []
  let scope = ''
  if (rootRunId) {
    params.push(rootRunId)
    scope = `and r.root_run_id = $1`
  }
  const q = await db.query<{ tool_name: string; side_effect_class: string; run_id: string }>(
    `select i.tool_name, i.side_effect_class, r.id as run_id
       from tool_invocations i
       join run_attempts a on a.id = i.run_attempt_id
       join runs r on r.id = a.run_id
      where i.outcome is null
        -- run 还在跑时，工具调用正处于「意图已写、结果未回」是正常的
        and r.status in ${TERMINAL}
        ${scope}`,
    params,
  )
  return q.rows.map((x) => ({
    toolName: x.tool_name,
    sideEffectClass: x.side_effect_class,
    runId: x.run_id,
  }))
}
