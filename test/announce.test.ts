import { afterEach, describe, expect, it } from 'vitest'
import { ask, boot, type Nucleus } from '../src/boot.js'
import { defaultConfig, type NucleusConfig } from '../src/config.js'
import { withExampleAgents } from '../src/examples/agents.js'
import { FakeClock, FakeIds } from '../src/seams.js'
import { announceText } from '../src/runtime/worker.js'
import type { MockScript } from '../src/providers/mock.js'

/**
 * 结果怎么呈现给用户，以及 artifact 到底存不存在。
 *
 * 两个都是实测撞出来的问题：
 *
 *  1. 回写会话时只发 summary。status='partial' 看起来和完成一样，
 *     open_questions 里「没查到 2026 年的实测数据」这种话直接消失 ——
 *     而那恰恰是用户判断能不能采信的依据。
 *  2. artifact 的**内容从未被保存**：writeArtifact 只把 content.length 存进
 *     bytes 就丢掉原文。一次真实运行产出 17081 字节的报告，落库只剩
 *     「17081」和一句摘要。而整套 context 策略正建立在「完整内容进 artifact
 *     后引用」之上 —— 引用指向的东西不存在，策略就是空的。
 */

function config(): NucleusConfig {
  const c = withExampleAgents(structuredClone(defaultConfig))
  c.defaults.modelChain = ['mock:local']
  c.defaults.entryAgent = 'researcher'
  return c
}

let n: Nucleus | null = null
afterEach(async () => {
  await n?.close()
  n = null
})

async function bootWith(script: MockScript): Promise<Nucleus> {
  return boot({ config: config(), deps: { clock: new FakeClock(), ids: new FakeIds() }, mock: script })
}

// ═══════════════════════════════════════════════════════
// announceText：纯函数，先钉住渲染规则
// ═══════════════════════════════════════════════════════

describe('announceText', () => {
  it('一切正常时就是 summary 本身，不加噪音', () => {
    expect(announceText({ status: 'ok', summary: '调研完成', open_questions: [] })).toBe('调研完成')
  })

  it('partial 必须标出来 —— 否则看起来和完成一样', () => {
    const t = announceText({ status: 'partial', summary: '查到三个候选', open_questions: [] })
    expect(t).toContain('部分完成')
    expect(t).toContain('查到三个候选')
  })

  it('failed 也标出来', () => {
    expect(announceText({ status: 'failed', summary: '拿不到数据', open_questions: [] })).toContain('未完成')
  })

  it('未解决项必须出现 —— 静默丢掉是最糟的情况', () => {
    const t = announceText({
      status: 'ok',
      summary: '有结论',
      open_questions: ['缺 2026 年实测数据', '未验证 32G 内存下的表现'],
    })
    expect(t).toContain('未解决')
    expect(t).toContain('缺 2026 年实测数据')
    expect(t).toContain('未验证 32G 内存下的表现')
  })

  it('空白的未决项不占版面', () => {
    expect(announceText({ status: 'ok', summary: 'x', open_questions: ['', '  '] })).toBe('x')
  })

  it('把握不大时说出来，高把握时不啰嗦', () => {
    expect(announceText({ status: 'ok', summary: 'x', confidence: 0.3, open_questions: [] })).toContain('把握不大')
    expect(announceText({ status: 'ok', summary: 'x', confidence: 0.9, open_questions: [] })).toBe('x')
  })

  it('缺字段不炸 —— 结果来自模型，不能假定齐全', () => {
    expect(() => announceText({ summary: 'x' })).not.toThrow()
    expect(announceText({ summary: 'x' })).toBe('x')
  })
})

// ═══════════════════════════════════════════════════════
// 端到端：会话里真的看得到
// ═══════════════════════════════════════════════════════

describe('回写会话', () => {
  it('未解决项进了会话消息本身，而不是只在数据库里', async () => {
    n = await bootWith({
      researcher: [
        {
          submit: {
            status: 'partial',
            summary: '找到两个候选',
            findings: [{ claim: 'A 可行', sources: ['s1'] }],
            open_questions: ['缺 2026 年的实测数据'],
            artifacts: [],
          },
        },
      ],
    })
    const conv = await n.conversations.create({ agentId: 'researcher' })
    await ask(n, conv.id, '调研')

    const msgs = await n.conversations.recent(conv.id, 10)
    const last = msgs[msgs.length - 1]!
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('部分完成')
    expect(last.content).toContain('缺 2026 年的实测数据')
  })

  it('结构化原文进 meta，客户端不必反解那段文本', async () => {
    n = await bootWith({
      researcher: [
        {
          submit: {
            status: 'ok',
            summary: '完成',
            findings: [{ claim: 'A', sources: ['s'] }],
            confidence: 0.42,
            artifacts: [],
          },
        },
      ],
    })
    const conv = await n.conversations.create({ agentId: 'researcher' })
    await ask(n, conv.id, '调研')

    const r = await n.db.query<{ meta: { result?: { confidence?: number } } }>(
      `select meta from messages where conversation_id = $1 and role = 'assistant'`,
      [conv.id],
    )
    expect(r.rows[0]!.meta.result?.confidence).toBe(0.42)
  })

  it('会话历史会回灌下一轮，所以未决项下一轮看得见', async () => {
    n = await bootWith({
      researcher: [
        {
          submit: {
            status: 'partial',
            summary: '第一轮',
            findings: [{ claim: 'c1', sources: ['s'] }],
            open_questions: ['待确认 X'],
            artifacts: [],
          },
        },
        {
          submit: {
            status: 'ok',
            summary: '第二轮',
            findings: [{ claim: 'c2', sources: ['s'] }],
            artifacts: [],
          },
        },
      ],
    })
    const conv = await n.conversations.create({ agentId: 'researcher' })
    await ask(n, conv.id, '第一问')
    await ask(n, conv.id, '第二问')

    const msgs = await n.conversations.recent(conv.id, 10)
    // 第一轮的未决项仍然在历史里，装配时会进上下文
    expect(msgs.some((m) => m.content.includes('待确认 X'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════
// artifact 的内容必须真的存在
// ═══════════════════════════════════════════════════════

describe('artifact 落库', () => {
  it('内容原样存下来，不是只记长度', async () => {
    const body = '# 报告\n\n' + '这是正文。'.repeat(200)
    n = await bootWith({
      researcher: [
        { tool: { name: 'write_report', args: { title: '选型调研', content: body } } },
        { submit: { status: 'ok', summary: '完成', artifacts: ['reports/选型调研.md'] } },
      ],
    })
    const conv = await n.conversations.create({ agentId: 'researcher' })
    await ask(n, conv.id, '调研')

    const r = await n.db.query<{ content: string | null; bytes: number; sha256: string | null }>(
      `select content, bytes, sha256 from artifacts`,
    )
    expect(r.rows).toHaveLength(1)
    const row = r.rows[0]!
    // 这里曾经是 null —— 只有 bytes 被存下来
    expect(row.content).not.toBeNull()
    expect(row.content).toContain('这是正文。')
    expect(row.content!.length).toBe(row.bytes)
    // sha256 列一开始就声明了，也一直没人写
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同一 ref 覆盖写时内容与 sha 都更新', async () => {
    n = await bootWith({
      researcher: [
        { tool: { name: 'write_report', args: { title: '同名', content: '第一版' } } },
        { tool: { name: 'write_report', args: { title: '同名', content: '第二版内容更长' } } },
        { submit: { status: 'ok', summary: '完成', findings: [{ claim: 'c', sources: ['s'] }], artifacts: [] } },
      ],
    })
    const conv = await n.conversations.create({ agentId: 'researcher' })
    await ask(n, conv.id, '调研')

    const r = await n.db.query<{ content: string; bytes: number }>(`select content, bytes from artifacts`)
    expect(r.rows).toHaveLength(1)
    // write_report 会在正文前加 `# 标题`，所以比对时带上
    expect(r.rows[0]!.content).toBe('# 同名\n\n第二版内容更长')
    expect(r.rows[0]!.bytes).toBe('# 同名\n\n第二版内容更长'.length)
  })

  it('完整内容进 artifact 而不是 summary —— 这是整套 context 策略的前提', async () => {
    const body = '正文内容'.repeat(1000)
    n = await bootWith({
      researcher: [
        { tool: { name: 'write_report', args: { title: '长报告', content: body } } },
        {
          submit: {
            status: 'ok',
            summary: '结论见报告',
            findings: [{ claim: 'A 可行', sources: ['s1'] }],
            artifacts: ['reports/长报告.md'],
          },
        },
      ],
    })
    const conv = await n.conversations.create({ agentId: 'researcher' })
    await ask(n, conv.id, '调研')

    const msgs = await n.conversations.recent(conv.id, 10)
    const last = msgs[msgs.length - 1]!
    // 会话里只有摘要与引用
    expect(last.content.length).toBeLessThan(200)
    expect(last.artifacts).toContain('reports/长报告.md')
    // 而引用指向的东西真的存在，且是全文
    const r = await n.db.query<{ content: string }>(`select content from artifacts`)
    expect(r.rows[0]!.content.length).toBeGreaterThan(body.length - 10)
  })
})
