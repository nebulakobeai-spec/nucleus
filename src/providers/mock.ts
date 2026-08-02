import type { FetchLike } from './openai-compat.js'

/**
 * 进程内 mock provider（OpenAI 兼容响应）。
 *
 * 用途：在没有网络/没有 API key 的环境下把整条链路真正跑起来 ——
 * 工具调用、委派、wake、timeline、成本核算全部走真实代码路径，
 * 只有模型的"想法"是脚本化的。
 *
 * 这台开发机对 Node 进程禁止一切出网（含 localhost），所以本地演示只能靠它。
 * 部署机上把 provider 换成真实模型即可，其余代码不变。
 */

export interface MockTurn {
  /** 纯文本回复 */
  text?: string
  /** 发起工具调用 */
  tool?: { name: string; args: unknown }
  /**
   * 一次回复里发起**多个**工具调用。
   *
   * 这不是锦上添花：`delegate` 会挂起当轮 attempt，所以「同时委派给
   * 多个专家」只可能靠模型在一次回复里返回多个 delegate。
   * 只支持单个 tool 的话，多专家并发这条路连测都测不了。
   */
  tools?: Array<{ name: string; args: unknown }>
  /** 提交结果 */
  submit?: Record<string, unknown>
  usage?: { in?: number; out?: number }
}

export interface MockScript {
  /** 按 agent id 分派；每个 agent 一串按序消费的回合 */
  [agentId: string]: MockTurn[]
}

/**
 * 从 system prompt 里识别是哪个 agent。
 * 约定：identity 段首行形如 `# <agentId>`。
 *
 * **直接把 id 抽出来，而不是在已知列表里匹配。** 原来匹配不到就退回
 * `known[0]`，于是脚本里没写的 agent 会拿到别人的剧本 —— `agent try` 试一个
 * 新专家时正好撞上这个：它拿到编排者的 delegate 剧本，而那个工具根本没注册。
 *
 * 抽不出来的 agent 会走到 turns 为空的分支，拿到默认的 submit 兜底，
 * 这才是「脚本里没写这个 agent」该有的行为。
 */
function whichAgent(system: string, known: string[]): string {
  const m = /^#\s*([a-z][a-z0-9-]*)\s*$/im.exec(system)
  if (m) return m[1]!
  return known[0] ?? 'unknown'
}

/**
 * 按 JSON Schema 合成一份能过校验的结果。
 *
 * 只处理这个项目的结果 schema 会用到的形状（对象 / 数组 / 标量），
 * 够用即止 —— 目标是「满足契约」，不是通用的 schema 伪造器。
 */
export function synthesizeResult(schema: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { status: 'ok', summary: '(mock 合成的结果)' }
  const s = schema as
    | { properties?: Record<string, Record<string, unknown>>; required?: string[] }
    | undefined
  if (!s?.properties) return base

  for (const [name, decl] of Object.entries(s.properties)) {
    if (name in base) continue
    base[name] = fake(decl, name)
  }
  return base
}

function fake(decl: Record<string, unknown>, name: string): unknown {
  switch (decl['type']) {
    case 'string':
      // enum 存在时必须取其中一个，否则过不了校验
      return Array.isArray(decl['enum']) ? decl['enum'][0] : `mock-${name}`
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array': {
      const items = decl['items'] as Record<string, unknown> | undefined
      // 一个元素就够：`a[].b` 的语义是「每一个元素的 b 都非空」，
      // 给一个满足的元素即可验证契约可满足
      return items ? [fake(items, name)] : [`mock-${name}`]
    }
    case 'object': {
      const props = (decl['properties'] ?? {}) as Record<string, Record<string, unknown>>
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fake(v, k)]))
    }
    default:
      return `mock-${name}`
  }
}

/**
 * 合成一份摘要。
 *
 * 刻意从提示词里**真的抄出用户说过的话**，而不是回一句固定文本 ——
 * 「约束必须活过压缩」是这块唯一要紧的性质，mock 要能让它被测到。
 * 回固定文本的话，测试就只能验「压缩跑通了」，验不了「压缩没丢东西」。
 */
export function synthesizeSummary(
  messages: Array<{ role: string; content: string }>,
): Record<string, unknown> {
  const text = messages.map((m) => m.content).join('\n')
  const constraints: string[] = []
  const add = (x: string) => {
    const v = x.trim().slice(0, 200)
    if (v && !constraints.includes(v)) constraints.push(v)
  }
  const LOOKS_LIKE_CONSTRAINT = /不要|必须|不能|别|禁止/

  /**
   * **只扫两个位置，不扫整段提示词。**
   *
   * 提示词里我自己那段「## 要求」也写满了「不要写空话」「必须保留」，
   * 全文乱扫会把它们当成用户约束 —— 于是测试可能因为**错误的原因**通过
   * （断言「约束活下来了」，而活下来的其实是提示词自己的话）。
   */
  let inRetiring = false
  let inPrevConstraints = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()

    // ① 退役消息区：只取 `[user] …` 那些行
    if (line.startsWith('## 这次要退役的对话')) {
      inRetiring = true
      inPrevConstraints = false
      continue
    }
    if (line.startsWith('## 要求')) {
      inRetiring = false
      continue
    }
    // ② 已有摘要里的约束段 —— 增量摘要必须继承它，否则第二代就丢了
    if (line.startsWith('### 用户明确提过的要求')) {
      inPrevConstraints = true
      inRetiring = false
      continue
    }
    if (inPrevConstraints && line.startsWith('###')) {
      inPrevConstraints = false
      continue
    }

    if (inRetiring) {
      const m = /^\[user\]\s*(.+)$/.exec(line)
      if (m && LOOKS_LIKE_CONSTRAINT.test(m[1]!)) add(m[1]!)
    } else if (inPrevConstraints) {
      const m = /^-\s+(.+)$/.exec(line)
      if (m) add(m[1]!)
    }
  }

  return {
    constraints,
    decisions: [],
    open: [],
    artifacts: [],
    context: '（mock 压缩）',
  }
}

function mockJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

export function mockProviderFetch(script: MockScript): FetchLike {
  const cursors = new Map<string, number>()
  const agents = Object.keys(script)

  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
      stream?: boolean
      tools?: Array<{ function?: { name?: string; parameters?: unknown } }>
    }
    /**
     * 压缩请求单独认出来。
     *
     * 两个理由：
     *  1. 它**没有 system 消息**，所以 whichAgent 认不出来，会随便挑一个 agent
     *  2. 更要紧的是它**不该消耗 agent 的脚本游标** —— 一次压缩会把后面的剧本
     *     全错位，而症状是「某个专家突然走了别人的分支」，极难追
     */
    const summaryTool = body.tools?.find((t) => t.function?.name === 'submit_summary')
    if (summaryTool) {
      return mockJson({
        id: 'chatcmpl-mock-compact',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_compact',
                  type: 'function',
                  function: {
                    name: 'submit_summary',
                    arguments: JSON.stringify(synthesizeSummary(body.messages)),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 300, completion_tokens: 60 },
      })
    }

    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const agent = whichAgent(system, agents)

    const i = cursors.get(agent) ?? 0
    cursors.set(agent, i + 1)
    const turns = script[agent] ?? []
    // 脚本用尽（或这个 agent 根本没写脚本）时，**照着请求里的 submit_result
    // schema 合成一份满足契约的结果**。
    //
    // 原来只回一个固定的 { status, summary }，于是任何声明了 requiredFields
    // 的专家（analyst 要 metrics[].source）在 mock 下必然被退回、必然失败 ——
    // 而 `agent try --mock` 恰恰是给这类专家用的：它想验的是「契约可满足、
    // 管线跑得通」，不是「模型答得好」。
    const submitSchema = body.tools?.find((t) => t.function?.name === 'submit_result')?.function
      ?.parameters
    const turn: MockTurn = turns[i] ?? { submit: synthesizeResult(submitSchema) }

    const usage = {
      prompt_tokens: turn.usage?.in ?? 200 + i * 50,
      completion_tokens: turn.usage?.out ?? 40,
    }

    const message: Record<string, unknown> = { role: 'assistant', content: turn.text ?? '' }
    let finish = 'stop'

    const calls = turn.tools ?? (turn.tool ? [turn.tool] : null)
    if (calls) {
      message['tool_calls'] = calls.map((t, k) => ({
        id: `call_${agent}_${i}_${k}`,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }))
      finish = 'tool_calls'
    } else if (turn.submit) {
      message['tool_calls'] = [
        {
          id: `call_${agent}_${i}`,
          type: 'function',
          function: { name: 'submit_result', arguments: JSON.stringify(turn.submit) },
        },
      ]
      finish = 'tool_calls'
    }

    const payload = {
      id: `chatcmpl-mock-${agent}-${i}`,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    }

    if (body.stream) {
      const chunks: string[] = []
      const text = turn.text ?? ''
      for (const piece of text.match(/.{1,8}/gs) ?? []) {
        chunks.push(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`,
        )
      }
      for (const [k, call] of (
        (message['tool_calls'] as Array<Record<string, unknown>> | undefined) ?? []
      ).entries()) {
        chunks.push(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: k, ...call }] } }],
          })}\n\n`,
        )
      }
      chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
      chunks.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
      chunks.push('data: [DONE]\n\n')
      return new Response(chunks.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
