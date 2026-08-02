/**
 * 错误分类学（DESIGN.md §3.8）。
 *
 * 每个 error_code 声明 `recovery`，UI 直接渲染这个字段 ——
 * 让用户在异常时立刻知道系统会不会自己恢复，而不是从 status 里推断。
 */

export type Recovery =
  /** 系统会自己重试/切换，用户不用管 */
  | 'automatic'
  /** 卡住了，需要人介入 */
  | 'needs_user'
  /** 到此为止，不会再动 */
  | 'terminal'

export interface ErrorSpec {
  code: string
  recovery: Recovery
  /** 是否可以就地重试（不换 attempt） */
  retryable: boolean
  /**
   * 整个 run 值得等一会儿再来。
   *
   * 与 `retryable` **不是一回事**：`contract.postcondition_failed` 是就地
   * 可重试的（让模型重写），但整个 run 重来是同样的 prompt → 同样的结果，
   * 只是慢四倍。而 `rate_limited` 反过来 —— 等一会儿真的会好。
   *
   * 混用这两个概念会把「模型答不对」变成「任务反复重跑」。
   */
  runRetryable: boolean
  /** 面向用户的一句话 */
  message: string
}

/**
 * @param retryable    **就地**可重试（同一次调用内重试，router 用它）
 * @param runRetryable **整个 run** 值得等一会儿再来。两者不是一回事：
 *   `contract.postcondition_failed` 是就地可重试的（让模型重写），但整个 run
 *   重来是同样的 prompt → 同样的结果，只是慢四倍。而 `rate_limited` 反过来 ——
 *   等一会儿真的会好。
 *   混用这两个概念会让「模型答不对」变成「任务反复重跑」。
 */
function spec(
  code: string,
  recovery: Recovery,
  retryable: boolean,
  message: string,
  runRetryable = false,
): [string, ErrorSpec] {
  return [code, { code, recovery, retryable, message, runRetryable }]
}

export const ERRORS = new Map<string, ErrorSpec>([
  // ── provider ──────────────────────────────────────────
  spec('provider.rate_limited', 'automatic', true, '被限流，正在等待重试', true),
  spec('provider.quota_exhausted', 'automatic', false, '该模型额度用尽，正在切换', true),
  spec('provider.all_exhausted', 'needs_user', false, '所有模型都不可用，等待额度恢复', true),
  spec('provider.auth_failed', 'needs_user', false, '凭据无效，需要检查配置'),
  spec('provider.server_error', 'automatic', true, '模型服务异常，正在重试', true),
  spec('provider.timeout', 'automatic', true, '模型响应超时', true),
  // 与 timeout 分开：连接被拒 / DNS 失败 / 被网络策略拦截，重试永远不会成功。
  // 归成 timeout 会让界面说「系统会自动重试」，把人往错的方向引 ——
  // 实际要做的是启动服务、改 baseUrl 或放开网络。
  spec('provider.unreachable', 'needs_user', false, '连不上模型服务，需要检查服务与网络'),
  spec('provider.degenerate_output', 'automatic', true, '模型输出退化（重复），已中断并重试'),
  spec('provider.bad_request', 'terminal', false, '请求不被模型接受'),
  spec('provider.output_truncated', 'needs_user', false, '模型输出被截断，需要提高 maxTokens'),

  // ── tool ──────────────────────────────────────────────
  spec('tool.not_found', 'terminal', false, '工具不存在'),
  // 与 not_found 区分：工具注册了、agent 也有权，只是这台机器上跑不了
  //（无网络、缺依赖、外部服务未配置）。说成「工具不存在」会把人引向错误的方向。
  spec('tool.unavailable', 'needs_user', false, '工具在当前环境不可用'),
  // 配置问题，不是运行时内部错误 —— 报成 runtime.internal 会让人去查代码
  spec('config.agent_not_found', 'needs_user', false, '配置里找不到该 agent'),
  // mock 模型在没装 mock fetch 时会真的去解析 mock.invalid，然后报
  // provider.unreachable +「检查 DNS」—— 把人指向完全错误的方向。
  // 真正的原因是「还没配置任何真实模型」，所以它自己一个码
  spec('config.no_real_model', 'needs_user', false, '模型链里只有 mock，还没配置真实模型'),
  spec('tool.denied', 'needs_user', false, '该 agent 无权使用此工具'),
  spec('tool.timeout', 'automatic', true, '工具执行超时'),
  spec('tool.crashed', 'automatic', true, '工具崩溃'),
  spec('tool.output_too_large', 'automatic', false, '工具输出过大，已截断'),
  spec('tool.side_effect_unknown', 'needs_user', false, '可能已执行，需要你确认'),

  // ── mcp ───────────────────────────────────────────────
  spec('mcp.server_unavailable', 'automatic', true, 'MCP 服务不可用'),
  spec('mcp.server_crashed', 'automatic', true, 'MCP 服务崩溃，正在重启'),
  spec('mcp.tool_missing', 'needs_user', false, 'MCP 工具已消失，可能是服务升级了'),
  spec('mcp.schema_invalid', 'terminal', false, 'MCP 工具定义无法转换'),
  spec('mcp.auto_disabled', 'needs_user', false, 'MCP 服务连续失败已被自动禁用'),

  // ── contract ──────────────────────────────────────────
  spec('contract.schema_invalid', 'automatic', true, '输出格式不合规，正在要求重写'),
  spec('contract.postcondition_failed', 'automatic', true, '产出未通过校验，正在重做'),
  spec('contract.plan_invalid', 'automatic', true, '计划不合法，正在要求修正'),

  // ── budget ────────────────────────────────────────────
  spec('budget.steps_exceeded', 'needs_user', false, '步数超出上限'),
  spec('budget.cost_exceeded', 'needs_user', false, '成本超出上限'),
  spec('budget.no_progress', 'needs_user', false, '连续多步没有进展'),
  spec('budget.loop_detected', 'needs_user', false, '检测到重复调用循环'),
  spec('budget.context_overflow', 'needs_user', false, '上下文超出预算且无法降级'),

  // ── runtime ───────────────────────────────────────────
  spec('runtime.lease_expired', 'automatic', false, '执行进程失联，正在重新调度'),
  spec('runtime.deadline_exceeded', 'needs_user', false, '超过截止时间'),
  spec('runtime.max_attempts', 'needs_user', false, '重试次数已用尽'),
  spec('runtime.cancelled', 'terminal', false, '已取消'),
  spec('runtime.worker_died', 'automatic', false, '执行进程异常退出，正在重新调度'),
  spec('runtime.internal', 'needs_user', false, '内部错误'),
])

export function errorSpec(code: string | null | undefined): ErrorSpec | null {
  if (!code) return null
  return ERRORS.get(code) ?? null
}

export function recoveryOf(code: string | null | undefined): Recovery | null {
  return errorSpec(code)?.recovery ?? null
}

/** 带 error_code 的运行时错误。所有内部抛出都应该用它，便于 UI 一致渲染。 */
export class NucleusError extends Error {
  readonly code: string
  readonly detail: unknown
  /** 供 provider 层判断是否值得就地重试 */
  readonly retryAfterMs: number | null

  constructor(
    code: string,
    message?: string,
    opts: { detail?: unknown; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    const s = ERRORS.get(code)
    super(message ?? s?.message ?? code, opts.cause ? { cause: opts.cause } : undefined)
    this.name = 'NucleusError'
    this.code = code
    this.detail = opts.detail
    this.retryAfterMs = opts.retryAfterMs ?? null
    if (!s) {
      // 未注册的 code 会让 UI 无法判断恢复性 —— 早暴露
      this.message += ` [未注册的 error_code: ${code}]`
    }
  }

  get recovery(): Recovery {
    return recoveryOf(this.code) ?? 'needs_user'
  }

  get retryable(): boolean {
    return errorSpec(this.code)?.retryable ?? false
  }
}
