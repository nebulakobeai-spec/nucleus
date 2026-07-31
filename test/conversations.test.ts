import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgliteDb } from '../src/db/pglite.js'
import { migrate } from '../src/db/migrate.js'
import type { Db } from '../src/db/types.js'
import { FakeClock, FakeIds, type Deps } from '../src/seams.js'
import { ConversationStore, ConversationBusyError } from '../src/store/conversations.js'

let db: Db
let deps: Deps
let store: ConversationStore

beforeEach(async () => {
  db = await PgliteDb.open()
  await migrate(db)
  deps = { clock: new FakeClock(), ids: new FakeIds() }
  store = new ConversationStore(db, deps)
})

afterEach(async () => {
  await db.close()
})

describe('会话与消息', () => {
  it('追加消息时 seq 单调递增', async () => {
    const c = await store.create({ agentId: 'orchestrator', title: '测试' })
    const a = await store.append({ conversationId: c.id, role: 'user', content: '第一条' })
    const b = await store.append({ conversationId: c.id, role: 'assistant', content: '第二条' })

    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect((await store.get(c.id))!.lastSeq).toBe(2)
  })

  it('并发追加不会产生重号', async () => {
    const c = await store.create({ agentId: 'a' })
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        store.append({ conversationId: c.id, role: 'user', content: `并发 ${i}` }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    const seqs = ok.map((r) => (r as PromiseFulfilledResult<{ seq: number }>).value.seq)
    expect(new Set(seqs).size).toBe(seqs.length) // 无重号
  })

  it('recent 返回正序的最近 N 条', async () => {
    const c = await store.create({ agentId: 'a' })
    for (let i = 1; i <= 10; i++) {
      await store.append({ conversationId: c.id, role: 'user', content: `第${i}条` })
    }
    const recent = await store.recent(c.id, 3)
    expect(recent.map((m) => m.content)).toEqual(['第8条', '第9条', '第10条'])
  })

  it('beforeSeq 支持向上翻页', async () => {
    const c = await store.create({ agentId: 'a' })
    for (let i = 1; i <= 10; i++) {
      await store.append({ conversationId: c.id, role: 'user', content: `第${i}条` })
    }
    const page = await store.recent(c.id, 3, 8)
    expect(page.map((m) => m.content)).toEqual(['第5条', '第6条', '第7条'])
  })

  it('artifacts 与 meta 往返不丢', async () => {
    const c = await store.create({ agentId: 'a' })
    const m = await store.append({
      conversationId: c.id,
      role: 'assistant',
      content: '报告已生成',
      artifacts: ['run-1/report.md'],
      meta: { model: 'glm-4.7' },
    })
    expect(m.artifacts).toEqual(['run-1/report.md'])
    const back = await store.recent(c.id, 1)
    expect(back[0]!.artifacts).toEqual(['run-1/report.md'])
    expect(back[0]!.meta).toEqual({ model: 'glm-4.7' })
  })

  it('往不存在的会话追加会报错', async () => {
    await expect(
      store.append({ conversationId: crypto.randomUUID(), role: 'user', content: 'x' }),
    ).rejects.toThrow(/不存在/)
  })
})

describe('会话内串行化', () => {
  const RUN_1 = '11111111-1111-4111-8111-111111111111'
  const RUN_2 = '22222222-2222-4222-8222-222222222222'
  const RUN_3 = '33333333-3333-4333-8333-333333333333'

  it('已有活跃 run 时抢占失败', async () => {
    const c = await store.create({ agentId: 'a' })
    await store.acquire(c.id, RUN_1)
    await expect(store.acquire(c.id, RUN_2)).rejects.toBeInstanceOf(ConversationBusyError)
  })

  it('同一 run 重复抢占是幂等的', async () => {
    const c = await store.create({ agentId: 'a' })
    await store.acquire(c.id, RUN_1)
    await expect(store.acquire(c.id, RUN_1)).resolves.toBeUndefined()
  })

  it('释放后可被其他 run 抢占', async () => {
    const c = await store.create({ agentId: 'a' })
    await store.acquire(c.id, RUN_1)
    await store.release(c.id, RUN_1)
    await expect(store.acquire(c.id, RUN_2)).resolves.toBeUndefined()
  })

  it('非持有者的释放无效', async () => {
    const c = await store.create({ agentId: 'a' })
    await store.acquire(c.id, RUN_1)
    await store.release(c.id, RUN_2)
    expect((await store.get(c.id))!.activeRunId).toBe(RUN_1)
  })

  it('并发抢占只有一个成功', async () => {
    const c = await store.create({ agentId: 'a' })
    const results = await Promise.allSettled([
      store.acquire(c.id, RUN_1),
      store.acquire(c.id, RUN_2),
      store.acquire(c.id, RUN_3),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })
})

describe('分支（编辑重发）', () => {
  it('从指定 seq 分叉，复制之前的消息', async () => {
    const c = await store.create({ agentId: 'a', title: '原会话' })
    for (let i = 1; i <= 5; i++) {
      await store.append({ conversationId: c.id, role: 'user', content: `第${i}条` })
    }

    const fork = await store.fork(c.id, 3)
    expect(fork.parentConversationId).toBe(c.id)
    expect(fork.forkedAtSeq).toBe(3)
    expect(fork.lastSeq).toBe(3)

    const msgs = await store.recent(fork.id, 100)
    expect(msgs.map((m) => m.content)).toEqual(['第1条', '第2条', '第3条'])

    // 原会话不受影响
    expect((await store.recent(c.id, 100))).toHaveLength(5)
  })

  it('分支后续追加从分叉点继续编号', async () => {
    const c = await store.create({ agentId: 'a' })
    for (let i = 1; i <= 5; i++) {
      await store.append({ conversationId: c.id, role: 'user', content: `第${i}条` })
    }
    const fork = await store.fork(c.id, 2)
    const next = await store.append({ conversationId: fork.id, role: 'user', content: '改过的第3条' })
    expect(next.seq).toBe(3)
  })
})

describe('列表与转换', () => {
  it('归档的会话默认不出现在列表中', async () => {
    const a = await store.create({ agentId: 'x', title: '活跃' })
    const b = await store.create({ agentId: 'x', title: '归档' })
    await store.archive(b.id)

    const list = await store.list()
    expect(list.map((c) => c.id)).toEqual([a.id])
    expect((await store.list({ includeArchived: true }))).toHaveLength(2)
  })

  it('置顶排在前面', async () => {
    const a = await store.create({ agentId: 'x', title: '普通' })
    const b = await store.create({ agentId: 'x', title: '置顶' })
    await db.query(`update conversations set pinned = true where id = $1`, [b.id])
    expect((await store.list())[0]!.id).toBe(b.id)
    expect(a.id).toBeDefined()
  })

  it('system_note 转成带标注的 user 消息 —— 多数 provider 不接受中段 system', async () => {
    const c = await store.create({ agentId: 'a' })
    await store.append({ conversationId: c.id, role: 'user', content: '问题' })
    await store.append({ conversationId: c.id, role: 'system_note', content: '专家结果已回流' })

    const chat = store.toChatMessages(await store.recent(c.id, 10))
    expect(chat.map((m) => m.role)).toEqual(['user', 'user'])
    expect(chat[1]!.content).toBe('[系统] 专家结果已回流')
  })
})
