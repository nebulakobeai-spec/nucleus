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
 */
function whichAgent(system: string, known: string[]): string {
  for (const id of known) {
    if (new RegExp(`^#\\s*${id}\\b`, 'im').test(system)) return id
  }
  return known[0] ?? 'unknown'
}

export function mockProviderFetch(script: MockScript): FetchLike {
  const cursors = new Map<string, number>()
  const agents = Object.keys(script)

  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
      stream?: boolean
    }
    const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
    const agent = whichAgent(system, agents)

    const i = cursors.get(agent) ?? 0
    cursors.set(agent, i + 1)
    const turns = script[agent] ?? []
    const turn: MockTurn = turns[i] ?? { submit: { status: 'ok', summary: '(mock 脚本已用尽)' } }

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
