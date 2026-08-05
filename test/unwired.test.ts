import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「声明了但没接线」的自动检查。
 *
 * ── 为什么需要这个 ────────────────────────────────────
 *
 * 这是这个项目**出现次数最多的一类缺陷**：代码里声明了某个东西，
 * 但没有任何地方使用它。已经记下的实例（backlog 已经数到「第 9 处」）：
 *
 *  · `runtime.requestTimeoutMs`  配置里有，boot 从来不传 → gemma4 超时后
 *    重试，花两倍时间再同样超时
 *  · `conversations.acquire()`   会话锁做好了，只有它自己的测试在调用
 *  · `validateRules`             rule-new 只 import 了，从来没调用 ——
 *    于是上一轮加的同名字段冲突检查在创建规则时根本不跑
 *  · `resultFieldsForAgent().conflicts`  算出来、返回，全仓没人读 ——
 *    两条规则声明同名字段时静默取一个
 *  · `config.rulesDir`           rule add / rm 完全无视，规则写进另一个目录
 *  · `TERMINAL_RUN_STATUSES`     声明了，而同一份清单硬编码在 5 处 SQL 里
 *  · 6 张表                      迁移里建了，src 从来不碰
 *
 * 共同点是**都不报错**。类型检查过、测试绿、功能看起来在，
 * 只是那件事实际没发生。
 *
 * `noUnusedLocals`（已开）只管**同一个文件内**的未引用声明。跨文件的
 * ——「导出了没人调」「配置字段没人读」「建了表没人写」—— 它一个都看不见，
 * 而上面一半属于这一类。
 *
 * ── 允许清单就是这条检查的全部意义 ──────────────────────
 *
 * 判据必然有合理的例外（测试替身、给外部用的 API）。所以不是放宽判据，
 * 而是要求**每个例外写下理由**。「为什么这个导出没人调」写不出来的时候，
 * 通常就是真的忘了接线。
 */

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.nucleus-data'])

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (p.endsWith(ext)) out.push(p)
  }
  return out
}

const SRC = walk('src', '.ts')
const TEST = walk('test', '.ts')
const text = new Map<string, string>([...SRC, ...TEST].map((f) => [f, readFileSync(f, 'utf8')]))
const srcText = SRC.map((f) => text.get(f)!).join('\n')

function count(name: string, files: string[]): number {
  const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`, 'g')
  return files.reduce((n, f) => n + (text.get(f)!.match(re)?.length ?? 0), 0)
}

// ─────────────────────────────────────────────────────────
// ① 导出了值，但 src 里除了声明本身没有任何引用
// ─────────────────────────────────────────────────────────

/**
 * 允许清单。**每一条都要写为什么**。
 *
 * 只列**值**导出（函数 / const / class）—— 类型出现在签名里是正常的，
 * 拿它当判据只会得到一百多条噪音。
 */
const ALLOW_UNCALLED: Record<string, string> = {
  // 测试替身，故意住在 src 里：seams.ts 与 events.ts 就是为「可替换」存在的模块
  'src/seams.ts FakeIds': '测试替身。seams.ts 的全部意义就是让运行时依赖可替换',
  'src/runtime/events.ts MemoryEventSink': '测试用的事件收集器，与 DbEventSink 同实现同一个接口',
  // 供测试调用内部函数的入口
  'src/cli/chat.ts runChatCommand': 'handleCommand 是内部函数，这是给测试的调用入口',
  // 下面每一条都是**真的没接线**，各自记在 backlog F 段，逐条处理
  'src/cli/auth.ts makeSecretResolver':
    '没接线：boot 只在启动时解析一次凭据（boot.ts:93），OAuth token 过期不会续。见 BACKLOG F',
  'src/cli/agent-propose.ts toAgentConfig': '没接线：agent new 另有一条路径。见 BACKLOG F',
  'src/runtime/user-rules.ts indexedRulesForAgent':
    '没接线：boot.ts:122 内联算且不按 agent 过滤，read_rule 拿到的是全部规则。见 BACKLOG F',
  'src/db/migrate.ts appliedSchemaHash': '没接线：schema 漂移检测没有调用点。见 BACKLOG F',
  'src/providers/discover.ts parseWindowFromError': '没接线：providers probe 没用它。见 BACKLOG F',
  'src/providers/types.ts hasPricing': '没接线：成本计算另有判断。见 BACKLOG F',
  'src/auth/oauth-auth-code.ts accountIdFromToken': '没接线：账号身份没有落地。见 BACKLOG F',
  'src/db/types.ts one': '没接线：src 里 23 处用 rows[0]，而 one() 会在缺行时抛。见 BACKLOG F',
}

const VALUE_EXPORT = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_][A-Za-z0-9_$]*)/gm

describe('导出了但 src 里没人用', () => {
  it('每一处都在允许清单里，且写了理由', () => {
    const found: string[] = []
    for (const f of SRC) {
      for (const m of text.get(f)!.matchAll(VALUE_EXPORT)) {
        const name = m[1]!
        // 减 1：声明本身。同文件内被调用也算接上了线
        if (count(name, SRC) - 1 > 0) continue
        const key = `${f} ${name}`
        if (!ALLOW_UNCALLED[key]) found.push(key)
      }
    }
    expect(
      found,
      '这些导出在 src 里没有任何调用点。要么接上线，要么在 ALLOW_UNCALLED 里写下为什么',
    ).toEqual([])
  })

  it('允许清单里没有已经失效的条目 —— 否则它会掩盖真正的新问题', () => {
    const stale = Object.keys(ALLOW_UNCALLED).filter((key) => {
      const [f, name] = key.split(' ') as [string, string]
      if (!text.has(f)) return true
      return count(name, SRC) - 1 > 0
    })
    expect(stale, '这些已经接上线（或文件没了），从清单里删掉').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────
// ② 只有测试在调用的方法
// ─────────────────────────────────────────────────────────

/**
 * **这一条信号最强。**
 *
 * 一个有通过测试、而生产代码里零调用者的方法，看起来是做完了的 ——
 * 而它实际上什么都没参与。`conversations.acquire()` 就是这样：
 * 会话锁用条件更新写好了、测试 10 次调用它，而运行时从来不加锁。
 * 今天没出问题只是因为 CLI 与 REPL 都是串行的。
 */
const ALLOW_TEST_ONLY: Record<string, string> = {
  'src/store/conversations.ts archive': '归档没有入口。见 BACKLOG F',
  'src/store/conversations.ts fork': '分叉会话没有入口。见 BACKLOG F',
  'src/store/runs.ts getAttempt': '只有测试在查单个 attempt。见 BACKLOG F',
  'src/store/runs.ts getWake': '同上。见 BACKLOG F',
}

const METHOD = /^ {2}(?:async\s+)?([a-z][A-Za-z0-9_]*)\s*\(/gm
const NOT_METHODS = new Set(['constructor', 'if', 'for', 'while', 'catch', 'switch', 'return'])

describe('只有测试在调用', () => {
  it('store 的方法都有生产调用点，否则要写下理由', () => {
    const found: string[] = []
    for (const f of SRC.filter((x) => x.includes('store'))) {
      for (const m of text.get(f)!.matchAll(METHOD)) {
        const name = m[1]!
        if (NOT_METHODS.has(name)) continue
        const call = new RegExp(`\\.${name}\\s*\\(`, 'g')
        const inSrc = SRC.filter((g) => g !== f).reduce(
          (n, g) => n + (text.get(g)!.match(call)?.length ?? 0),
          0,
        )
        const inTest = TEST.reduce((n, g) => n + (text.get(g)!.match(call)?.length ?? 0), 0)
        if (inSrc > 0 || inTest === 0) continue
        const key = `${f} ${name}`
        if (!ALLOW_TEST_ONLY[key]) found.push(key)
      }
    }
    expect(
      found,
      '这些方法只有测试在调用 —— 有通过的测试、没有生产调用点，看起来做完了其实没参与',
    ).toEqual([])
  })

  /**
   * **这份清单也要有失效检查。**
   *
   * `ALLOW_UNCALLED` 一开始就有，而这份没有 —— 于是 `conversations.acquire` /
   * `release` 接上线之后，条目还留在清单里没人发现。一条失效的豁免比没有豁免更糟：
   * 它会把**后来真正的新问题**一起放过去（同一个 key 撞上就静默通过）。
   */
  it('清单里没有已经接上线的方法', () => {
    const stale = Object.keys(ALLOW_TEST_ONLY).filter((key) => {
      const [f, name] = key.split(' ') as [string, string]
      if (!text.has(f)) return true
      const call = new RegExp(`\\.${name}\\s*\\(`, 'g')
      return SRC.filter((g) => g !== f).some((g) => call.test(text.get(g)!))
    })
    expect(stale, '这些已经有生产调用点了，从清单里删掉').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────
// ③ 迁移里建了表，src 从来不碰
// ─────────────────────────────────────────────────────────

/**
 * 声明了 schema 却没有代码读写它。
 *
 * 与前两条不同，这一类**从一开始就是空的**：不是接线断了，
 * 而是那个功能只写了数据库那一半。列在这里比留在文档里可靠 ——
 * 文档不会在你新建一张表却忘了用时提醒你。
 */
const ALLOW_UNUSED_TABLE: Record<string, string> = {
  activity_logs: '声明了没写入 —— 见 BACKLOG F「6 张声明了但没写的表」',
  prompt_versions: '同上',
  tool_snapshots: '同上',
  mcp_servers: '同上',
}

describe('迁移里建了表但 src 不碰', () => {
  const tables = walk('migrations', '.sql').flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)]
      .map((m) => m[1]!),
  )

  it('扫到了表 —— 否则这条检查永远是绿的', () => {
    expect(tables.length).toBeGreaterThan(10)
    expect(tables).toContain('runs')
  })

  it('每张表都有代码碰它，否则要写下理由', () => {
    const found = tables.filter(
      (t) => !new RegExp(`\\b${t}\\b`).test(srcText) && !ALLOW_UNUSED_TABLE[t],
    )
    expect(found, '这些表建了但 src 从不引用 —— 那个功能只写了数据库那一半').toEqual([])
  })

  it('允许清单里没有已经用上的表', () => {
    const stale = Object.keys(ALLOW_UNUSED_TABLE).filter((t) => new RegExp(`\\b${t}\\b`).test(srcText))
    expect(stale, '这些表已经在用了，从清单里删掉').toEqual([])
  })
})

// ─────────────────────────────────────────────────────────
// ④ 配置字段没人读
// ─────────────────────────────────────────────────────────

describe('配置字段没人读', () => {
  it('NucleusConfig 的顶层字段都有读取处', () => {
    const cfg = text.get(join('src', 'config.ts'))!
    const start = cfg.indexOf('export interface NucleusConfig')
    const body = cfg.slice(start, cfg.indexOf('\n}\n', start))
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!)
    expect(fields.length).toBeGreaterThan(8)

    const others = SRC.filter((f) => f !== join('src', 'config.ts'))
    const unread = fields.filter((name) => count(name, others) === 0)
    expect(unread, '这些配置字段声明了但没有任何地方读 —— requestTimeoutMs 就这么漏过一次').toEqual(
      [],
    )
  })
})
