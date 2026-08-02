/**
 * 领域类型。
 *
 * 与 migrations/0001_init.sql 一一对应。字段命名保持 snake_case → camelCase 的
 * 机械映射，store 层负责转换。
 */

// ── 状态机（DESIGN.md §3.3）─────────────────────────────

/** 物理尝试的状态。终态不可变，由 DB trigger 强制。 */
export type AttemptStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'lost'
  | 'cancelled'

export const TERMINAL_ATTEMPT_STATUSES = [
  'succeeded',
  'failed',
  'timed_out',
  'lost',
  'cancelled',
] as const satisfies readonly AttemptStatus[]

export function isTerminalAttempt(s: AttemptStatus): boolean {
  return (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(s)
}

/** 逻辑执行的状态。可推进，不受终态约束。 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_children'
  | 'waiting_retry'
  | 'succeeded'
  | 'failed'
  | 'needs_human_confirmation'
  | 'cancelled'

export const TERMINAL_RUN_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[]

export function isTerminalRun(s: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(s)
}

/**
 * attempt 终态 → 逻辑 run 状态的默认映射。
 * 调用方可以覆盖（例如 failed 但还有重试预算 → waiting_retry）。
 */
export function runStatusForAttempt(s: AttemptStatus): RunStatus {
  switch (s) {
    case 'succeeded':
      return 'succeeded'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
    case 'timed_out':
    case 'lost':
      return 'failed'
    case 'queued':
    case 'running':
      return 'running'
  }
}

// ── 副作用分级（DESIGN.md §3.2）─────────────────────────

export type SideEffectClass = 'pure' | 'idempotent' | 'non_idempotent'

/** 崩溃恢复时对 outcome=NULL 的调用如何处置。 */
export type RecoveryAction = 'rerun' | 'rerun_with_key' | 'escalate'

export function recoveryFor(c: SideEffectClass): RecoveryAction {
  switch (c) {
    case 'pure':
      return 'rerun'
    case 'idempotent':
      return 'rerun_with_key'
    case 'non_idempotent':
      // 无法判断外部副作用是否已发生 → 绝不自动重跑
      return 'escalate'
  }
}

// ── 实体 ────────────────────────────────────────────────

export interface Run {
  id: string
  parentRunId: string | null
  rootRunId: string
  conversationId: string | null
  taskId: string | null
  agentId: string
  depth: number
  status: RunStatus
  errorCode: string | null
  errorDetail: unknown
  idempotencyKey: string | null
  /** 来自哪条定时任务；手工发起的 run 是 null */
  scheduleId: string | null
  input: unknown
  result: unknown
  resultRef: string | null
  resultSchemaVersion: string | null
  deadlineAt: Date | null
  createdAt: Date
  endedAt: Date | null
}

export interface RunAttempt {
  id: string
  runId: string
  attemptNo: number
  status: AttemptStatus
  workerId: string | null
  leaseExpiresAt: Date | null
  fenceToken: string | null
  promptVersionId: string | null
  configHash: string | null
  toolSnapshotId: string | null
  model: string | null
  provider: string | null
  heartbeatAt: Date | null
  cancelRequestedAt: Date | null
  startedAt: Date | null
  endedAt: Date | null
  errorCode: string | null
  errorDetail: unknown
  stepsUsed: number
  tokensIn: number | null
  tokensOut: number | null
  cacheRead: number | null
  costUsd: number | null
  contextBreakdown: unknown
  createdAt: Date
}

export interface ToolInvocation {
  id: string
  runAttemptId: string
  seq: number
  toolName: string
  argsHash: string
  argsRef: string | null
  sideEffectClass: SideEffectClass
  idempotencyKey: string | null
  intentAt: Date
  outcome: 'ok' | 'error' | null
  outcomeAt: Date | null
  resultRef: string | null
  errorCode: string | null
}

export type WakeKind = 'children_done' | 'approval' | 'retry_timer'
export type WakeStatus = 'waiting' | 'fired' | 'superseded'

export interface WakeRecord {
  id: string
  kind: WakeKind
  parentRunId: string
  parentConversationId: string | null
  parentAgentId: string
  waitOnRunIds: string[]
  pendingCount: number
  resumePayload: unknown
  status: WakeStatus
  fireAt: Date | null
  firedAttemptId: string | null
  createdAt: Date
  firedAt: Date | null
}

export interface RunEvent {
  id: number
  runAttemptId: string
  runId: string
  seq: number
  kind: string
  payload: unknown
  createdAt: Date
}
