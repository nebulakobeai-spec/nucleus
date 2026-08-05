import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NucleusConfig } from '../config.js'
import { insertIntoArray, verifyInsert } from '../config/json-edit.js'
import { stripJsonComments } from '../config-file.js'
import { RESERVED_FIELDS, FIELD_NAME, FIELD_NAME_HINT } from './result-schema.js'
import { GRANTABLE, isPermission } from './permissions.js'
import { INLINE_MAX_TOKENS, roughTokens, TIER_WHAT } from './user-rules.js'
import type { ToolDefinition } from './tools.js'

/**
 * 让编排者能改运行时自己：加规则、加专家、加模型。
 *
 * ── 使用者的选择：全部自动，不要批准 ────────────────────────
 *
 * 我提过一个反对意见并且它仍然成立：**有 `configure` 的 agent 可以造一个带
 * `execute` 权限的专家，然后委派给它 —— 那等于给自己发了 execute。**
 * 使用者明确选择了「全部自动」，所以这里不加闸门。
 *
 * 代价用**可见性**补，而不是靠信任：
 *
 *  · 每次写入都把完整内容回给模型（于是它会出现在对话里）
 *  · 全量进 `logs/`（事件流已经订了一份写文件）
 *  · 每次都给出**回退命令**
 *  · 造 agent 时把「这几项权限意味着什么」连风险一起说出来
 *
 * 不加闸门不等于不说话。
 *
 * ── 为什么不是「让模型再调一次模型」 ────────────────────────
 *
 * `rule new --describe` 那条路是 CLI 调模型让它起草。而这里**调用方本身就是
 * 模型** —— 让它再嵌套调一次模型是多余的一跳，还会把两次判断的分歧藏起来。
 * 所以工具的参数就是提案本身，判定仍然全部由运行时做
 * （工具名是否真实、字段名是否合法、是否只剩提醒、权限是否可授予）。
 *
 * 所以三层的**代价**必须写进工具描述 —— 那是模型判层的唯一依据。
 */

export interface ConfigWriteResult {
  path: string
  content: string
  /** 出错了怎么退回去 —— 每次写入都要给 */
  revert: string
}

/** 规则 / 专家文件的写入位置。相对路径按配置文件所在目录，与 CLI 一致 */
export interface ConfigPaths {
  rulesDir: string
  agentsDir: string
  configPath: string | null
}

const ID_RE = /^[a-z][a-z0-9.-]*$/

// ─────────────────────────────────────────────────────────
// create_rule
// ─────────────────────────────────────────────────────────

export function createRuleTool(paths: ConfigPaths, existing: () => NucleusConfig): ToolDefinition {
  return {
    name: 'create_rule',
    description: [
      '加一条规则。规则**由运行时强制**，不靠你记得。',
      '',
      '三层的强制方式与代价差好几个数量级，**优先用强的**：',
      ...(['boundary', 'check', 'reminder'] as const).map((t) => `- ${t}：${TIER_WHAT[t]}`),
      '',
      '两条硬性原则（校验会拒绝，不是建议）：',
      '1. **reminder 不能单独存在** —— 只有提醒的规则等于一句没人强制的文本，',
      '   它会出现在规则清单里、看起来系统在管，实际什么都没管。',
      '2. **能用 boundary 表达的绝不写成 reminder** —— 前者零成本且不可违反。',
      '',
      '**check 只能校验你自己提交的那份结果**，没有别的信息源。所以',
      '`plan_approved: true` 这种「我做过了」的字段等于零 —— 它是同一个模型填的。',
      '有效的 check 要求的是**内容本身**（数据带来源、结论带引用）。',
      '',
      '复合要求里有一句管不住时**不要整条放弃**：管住能管的，',
      '把管不住的放进 uncoveredClauses（会写进文件并在清单里标出来）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '规则 id，会成为文件名。小写字母、数字、点、连字符' },
        denyTools: { type: 'array', items: { type: 'string' }, description: 'boundary：禁掉的工具' },
        requiredFields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'check：必填字段路径。' +
            '`a[].b` 表示**有 a 的时候**每条都要有 b —— 没有 a 时这条要求算满足。' +
            '`a[]!.b` 额外要求 a 必须非空。' +
            '\n**默认用 `[]`。** 用 `[]!` 之前想清楚：那会让任何产生不了这种数据的' +
            '任务都过不了契约。实测踩过一次 —— 一条「金融数据要标来源」的规则挂到 `*` 上，' +
            '结果「报告你还活着」这种任务也被锁死，每次触发都 contract.postcondition_failed。',
        },
        resultFields: {
          type: 'object',
          description:
            'check：新字段声明。核心字段之外的都要在这里声明。字段名 snake_case。' +
            '形如 {"data_points":{"type":"object[]","fields":{"source":"string"}}}',
        },
        constraint: { type: 'string', description: 'reminder 正文。可以留空' },
        gist: {
          type: 'string',
          description: `正文超过约 ${INLINE_MAX_TOKENS} token 时必须给的索引行，**要带触发条件**`,
        },
        appliesTo: {
          type: 'array',
          items: { type: 'string' },
          description: '作用于哪些 agent。**领域性的规则不要挂 `*`** —— 「金融数据要标来源」只对产出金融数据的专家有意义，挂到全部会让不相干的任务也被那句提醒推着走（实测：一条挂在 `*` 上的金融规则，让「报告你还活着」这个定时任务变成了一份 NVIDIA/AMD 财报对比 —— 编排者为了满足那句提醒编了活出来）。只有真正无关领域的规则（比如「不许写文件」）才用 `["*"]`。',
        },
        uncoveredClauses: {
          type: 'array',
          items: { type: 'string' },
          description: '这条要求里没被管住的分句，原样抄回来',
        },
      },
      required: ['id'],
    },
    requires: ['configure'],
    // 同一个 id 写两次结果一致（后写覆盖），崩溃后重放安全
    sideEffect: 'idempotent',
    execute: async (args) => {
      const a = args as Record<string, unknown>
      const id = String(a['id'] ?? '').trim()
      if (!ID_RE.test(id)) {
        return { ok: false, rejected: true, content: `id 只能是小写字母、数字、点与连字符：${id || '(空)'}` }
      }

      const cfg = existing()
      const problems = validateRuleArgs(a, cfg)
      if (problems.length) {
        return {
          ok: false,
          // 校验拒绝不是故障：理由已经回给模型，它会自己改
          rejected: true,
          content: `这条规则没通过校验：\n${problems.map((p) => `- ${p}`).join('\n')}`,
        }
      }

      const content = renderRule(a)
      const path = join(paths.rulesDir, `${id}.md`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')

      return {
        ok: true,
        content: [
          `已写入 ${path}`,
          '',
          content.trim(),
          '',
          `每轮成本：${describeRuleCost(a)}`,
          `不想要了：nucleus rule rm ${id}`,
        ].join('\n'),
      }
    },
  }
}

/** 与 `rule add` 同一套判定 —— 工具名是否真实、字段名是否合法、是否只剩提醒 */
function validateRuleArgs(a: Record<string, unknown>, cfg: NucleusConfig): string[] {
  const out: string[] = []
  const deny = (a['denyTools'] as string[]) ?? []
  const req = (a['requiredFields'] as string[]) ?? []
  const fields = (a['resultFields'] as Record<string, unknown>) ?? {}
  const applies = (a['appliesTo'] as string[]) ?? []
  const constraint = String(a['constraint'] ?? '').trim()

  const agents = new Set(cfg.agents.map((x) => x.id))
  for (const t of applies) {
    if (t !== '*' && !agents.has(t)) {
      out.push(`appliesTo 里的「${t}」不是已有 agent（现有：${[...agents].join(', ')}）`)
    }
  }
  for (const name of Object.keys(fields)) {
    if (!FIELD_NAME.test(name)) out.push(`resultFields.${name}：${FIELD_NAME_HINT}`)
    if (RESERVED_FIELDS.includes(name)) out.push(`${name} 是核心字段，不能覆盖`)
  }
  const declared = new Set([...RESERVED_FIELDS, ...Object.keys(fields)])
  for (const f of req) {
    const top = f.split(/[.[]/)[0]!
    if (!declared.has(top)) {
      out.push(`requiredFields 里的 ${f} 引用了未声明的字段「${top}」—— 要么用核心字段，要么在 resultFields 里声明`)
    }
  }
  const hasCheck = req.length > 0 || Object.keys(fields).length > 0
  if (constraint && !hasCheck && deny.length === 0) {
    out.push(
      '只有 reminder，没有任何机械强制 —— 那等于一句没人强制的文本。' +
        '找出 check / boundary，或者把管不住的分句放进 uncoveredClauses 并至少管住一部分',
    )
  }
  if (!constraint && !hasCheck && deny.length === 0) out.push('什么都没声明')
  if (constraint && roughTokens(constraint) > INLINE_MAX_TOKENS && !a['gist']) {
    out.push(`正文约 ${roughTokens(constraint)} token，超过内联上限，必须给 gist（带触发条件）`)
  }
  return out
}

/** 与 rule-propose 的 renderRuleMd 同一种格式 —— 生成的文件要能被加载器原样读回 */
export function renderRule(a: Record<string, unknown>): string {
  const fm: string[] = []
  const gist = String(a['gist'] ?? '').trim()
  if (gist) fm.push(`gist: ${gist}`)
  const applies = ((a['appliesTo'] as string[]) ?? ['*']).filter(Boolean)
  fm.push(`appliesTo: [${(applies.length ? applies : ['*']).map((x) => `'${x}'`).join(', ')}]`)
  const deny = (a['denyTools'] as string[]) ?? []
  if (deny.length) fm.push(`denyTools: [${deny.join(', ')}]`)
  const req = (a['requiredFields'] as string[]) ?? []
  if (req.length) fm.push(`requiredFields: [${req.join(', ')}]`)
  const fields = (a['resultFields'] as Record<string, Record<string, unknown>>) ?? {}
  if (Object.keys(fields).length) {
    fm.push('resultFields:')
    for (const [name, decl] of Object.entries(fields)) {
      fm.push(`  ${name}:`)
      fm.push(`    type: ${String(decl['type'] ?? 'string')}`)
      if (decl['description']) fm.push(`    description: ${String(decl['description'])}`)
      const sub = decl['fields'] as Record<string, unknown> | undefined
      if (sub && Object.keys(sub).length) {
        fm.push('    fields:')
        for (const [k, v] of Object.entries(sub)) {
          fm.push(`      ${k}: ${typeof v === 'string' ? v : String((v as { type?: string }).type)}`)
        }
      }
    }
  }
  const uncovered = ((a['uncoveredClauses'] as string[]) ?? []).map((x) => String(x).trim()).filter(Boolean)
  if (uncovered.length) {
    fm.push('uncovered:')
    for (const u of uncovered) fm.push(`  - ${u}`)
  }
  const body = String(a['constraint'] ?? '').trim()
  return `---\n${fm.join('\n')}\n---\n${body ? `\n${body}\n` : ''}`
}

/** 说清每轮花多少 —— 「检查免费」是假的，字段声明进工具 schema */
function describeRuleCost(a: Record<string, unknown>): string {
  const parts: string[] = []
  const resident = String(a['gist'] ?? '').trim() || String(a['constraint'] ?? '').trim()
  if (resident) parts.push(`提醒约 ${roughTokens(resident)} tok`)
  const n = Object.keys((a['resultFields'] as Record<string, unknown>) ?? {}).length
  if (n) parts.push(`${n} 个字段声明进工具 schema（约 ${n * 55} tok）`)
  if (!parts.length) return '0 —— 纯边界，只是让工具不出现'
  return parts.join(' + ')
}

// ─────────────────────────────────────────────────────────
// create_agent —— 能提权的那一个
// ─────────────────────────────────────────────────────────

/**
 * 造一个专家。
 *
 * ── 这是三个工具里唯一能提权的 ────────────────────────────
 *
 * 编排者自己没有 `write` / `execute`。但它可以造一个有那些权限的专家、
 * 然后 `delegate` 给它 —— **那等于给自己发了那些权限**。
 *
 * 使用者明确选择了「全部自动，不要批准」，所以这里不拦。但**每次都要把这件事
 * 说出来**：授了哪些权限、每一项意味着什么、以及哪几项是危险的。
 * 不加闸门不等于不说话。
 */
export function createAgentTool(
  paths: ConfigPaths,
  existing: () => NucleusConfig,
  renderMd: (id: string, p: Record<string, unknown>) => string,
): ToolDefinition {
  const grantable = GRANTABLE.join(' / ')
  return {
    name: 'create_agent',
    description: [
      '造一个专家 agent（写 `agents/<id>.md`）。造完立刻可以 delegate 给它。',
      '',
      `可授予的权限：${grantable}`,
      '',
      '**权限按需要授，不要多给。** 授予的是权限而不是工具名单 —— 所以以后新接的',
      'MCP 工具会自动按权限可见，配置一个字都不用改。反过来说，多给一项就是',
      '永久多开一道门。',
      '',
      '`identity` 是**第二人称、给这个专家自己读的**（「你是…」）；',
      '`whenToUse` 是**第三人称、给编排者读的选路依据**。两者不能混 ——',
      '只有 id 的话，编排者只能靠名字猜派给谁。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'agent id，会成为文件名。小写字母、数字、点、连字符' },
        identity: {
          type: 'string',
          description: '第二人称，给这个专家自己读：它是谁、怎么做事、什么不做',
        },
        whenToUse: {
          type: 'string',
          description: '一句话说清**什么时候该派给它** —— 第三人称，给编排者读的选路依据',
        },
        permissions: {
          type: 'array',
          items: { type: 'string', enum: [...GRANTABLE] },
          description: `按需要授，不要多给。可选：${grantable}`,
        },
        requiredFields: { type: 'array', items: { type: 'string' }, description: '它必须交出的字段' },
        resultFields: { type: 'object', description: '它自己声明的结果字段（snake_case）' },
      },
      required: ['id', 'identity', 'whenToUse', 'permissions'],
    },
    requires: ['configure'],
    sideEffect: 'idempotent',
    execute: async (args) => {
      const a = args as Record<string, unknown>
      const id = String(a['id'] ?? '').trim()
      if (!ID_RE.test(id)) {
        return { ok: false, rejected: true, content: `id 只能是小写字母、数字、点与连字符：${id || '(空)'}` }
      }
      const cfg = existing()
      if (cfg.agents.some((x) => x.id === id)) {
        return {
          ok: false,
          rejected: true,
          content: `已经有一个叫 ${id} 的专家了。换个 id，或者让使用者先删掉那个文件。`,
        }
      }
      const identity = String(a['identity'] ?? '').trim()
      const whenToUse = String(a['whenToUse'] ?? '').trim()
      if (!identity || !whenToUse) {
        return { ok: false, rejected: true, content: 'identity 与 whenToUse 都不能为空 —— 它们各有各的读者' }
      }

      const perms = ((a['permissions'] as string[]) ?? []).map(String)
      const bad = perms.filter((x) => !isPermission(x) || !GRANTABLE.includes(x as never))
      if (bad.length) {
        return {
          ok: false,
          rejected: true,
          content: `这些权限不能授予：${bad.join(', ')}。可选：${grantable}`,
        }
      }

      const content = renderMd(id, { ...a, permissions: perms })
      const path = join(paths.agentsDir, `${id}.md`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')

      /**
       * **把提权这件事说出来。**
       *
       * 不拦是使用者的决定，而「不拦」和「不说」是两回事。
       * 授了危险权限时要把它单独点出来，不能混在一串 id 里一带而过。
       */
      const risky = perms.filter((p) => ['execute', 'write', 'network'].includes(p))
      return {
        ok: true,
        content: [
          `已写入 ${path}`,
          '',
          content.trim(),
          '',
          `授予的权限：${perms.join(', ') || '（无 —— 它只能直接作答）'}`,
          ...(risky.length
            ? [
                `**注意：${risky.join(', ')} 是能改变外部世界的权限。**`,
                '你自己没有这些权限，但可以委派给这个专家 —— 也就是说这一步实际上',
                '扩大了你能做的事。使用者选择了不逐次批准，所以这件事只会出现在这里',
                '和日志里。',
              ]
            : []),
          `不想要了：删掉 ${path}`,
        ].join('\n'),
      }
    },
  }
}

// ─────────────────────────────────────────────────────────
// configure_model
// ─────────────────────────────────────────────────────────

/**
 * 往 `nucleus.config.json` 加一个模型。
 *
 * ── 为什么是外科式插入 ────────────────────────────────
 *
 * 那份配置里全是注释（「这个数字为什么是这个值」）。JSON 序列化会把它们全部
 * 丢掉，所以 `model add` 一直只打印片段让人自己粘。这里真的要写，
 * 于是只在数组的 `]` 之前插一项，**其余一个字节都不动**（见 json-edit.ts）。
 *
 * ── contextWindow 必须给，不猜 ──────────────────────────
 *
 * 窗口大小是模型的事实。猜大了会直接溢出，而 ollama 的默认 num_ctx 常常
 * 只有 4096。这个项目的规矩是宁可不填也不编造数字 —— 所以它是必填参数，
 * 不知道就去问使用者（ask_user）或者跑 `nucleus providers probe`。
 */
export function configureModelTool(paths: ConfigPaths): ToolDefinition {
  return {
    name: 'configure_model',
    description: [
      '往配置里加一个模型。会**保留配置里的注释**（外科式插入，不是重写整个文件）。',
      '',
      '**contextWindow 必须给，不要猜。** 窗口大小是模型的事实：猜大了会直接溢出，',
      '而 ollama 的默认 num_ctx 常常只有 4096。不知道就先问使用者，',
      '或者让他跑 `nucleus providers probe <provider>`。',
      '',
      '**不要传任何密钥。** 只传 apiKeyRef（环境变量名 / 凭据引用名）——',
      '值由运行时从环境变量、keychain 或 0600 文件解析，永不进配置文件。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '模型键，形如 `provider:model`（第一个冒号分隔）' },
        provider: { type: 'string', description: 'provider id，如 ollama / anthropic / openrouter' },
        model: { type: 'string', description: 'provider 那边的模型 id' },
        baseUrl: { type: 'string', description: 'API 端点。provider 段里已有就可以省' },
        contextWindow: { type: 'number', description: '**必填**，不要猜' },
        maxTokens: { type: 'number', description: '单次输出上限。推理模型要给足' },
        apiKeyRef: { type: 'string', description: '凭据**引用名**，不是值' },
        costPerMTokIn: { type: 'number', description: '每百万输入 token 的价格；本地模型 0' },
        costPerMTokOut: { type: 'number', description: '每百万输出 token 的价格；本地模型 0' },
      },
      required: ['key', 'provider', 'model', 'contextWindow'],
    },
    requires: ['configure'],
    // 非幂等：插入会改文件，重放会插两次。崩溃后需要人确认，而不是自动重发
    sideEffect: 'non_idempotent',
    execute: async (args) => {
      const a = args as Record<string, unknown>
      if (!paths.configPath) {
        return {
          ok: false,
          content:
            '找不到配置文件（现在用的是内置默认）。让使用者先建一个 nucleus.config.json ——' +
            '复制 nucleus.config.example.json 即可。',
        }
      }
      const key = String(a['key'] ?? '').trim()
      if (!key.includes(':')) {
        return { ok: false, rejected: true, content: `模型键要形如 provider:model，收到「${key}」` }
      }
      const cw = Number(a['contextWindow'])
      if (!Number.isFinite(cw) || cw <= 0) {
        return {
          ok: false,
          rejected: true,
          content:
            'contextWindow 必须是正数，而且**不要猜** —— 不知道就问使用者，' +
            '或者让他跑 nucleus providers probe。',
        }
      }
      /**
       * 密钥不能进配置。挡在这里而不是靠工具描述劝导 ——
       * 一旦写进去，那个文件就成了一份明文凭据，而它还可能被提交。
       */
      for (const [k, v] of Object.entries(a)) {
        if (/^(apiKey|token|secret|password)$/i.test(k)) {
          return {
            ok: false,
            rejected: true,
            content: `不要传 ${k} —— 配置里只放 apiKeyRef（引用名）。值由运行时从环境变量 / keychain 解析。`,
          }
        }
        if (typeof v === 'string' && /^(sk-|xai-)/.test(v)) {
          return {
            ok: false,
            rejected: true,
            content: `${k} 看起来是一个真实密钥。配置里只放引用名。`,
          }
        }
      }

      const item = renderModelItem(a)
      const before = await readFile(paths.configPath, 'utf8')
      const ins = insertIntoArray(before, 'models', item)
      if (!ins.ok) return { ok: false, content: `改不动配置：${ins.error}` }

      const v = verifyInsert(before, ins.text, 'models', key, stripJsonComments)
      if (!v.ok) {
        // 宁可不写，也不要留下一份起不来的配置
        return { ok: false, content: `插入后自检没过，没有写入：${v.error}` }
      }
      await writeFile(paths.configPath, ins.text, 'utf8')

      return {
        ok: true,
        content: [
          `已加进 ${paths.configPath}（配置里的注释都保留了）`,
          '',
          item,
          '',
          '**这一步不会生效到当前进程** —— 配置在启动时读一次。',
          '让使用者重开 nucleus，或者重启 nucleus serve。',
          `不想要了：从 ${paths.configPath} 的 models 数组里删掉这一项`,
        ].join('\n'),
      }
    },
  }
}

/** 渲染成配置里那一项 —— 缩进要跟现有的对上，因为这份文件是要人读的 */
export function renderModelItem(a: Record<string, unknown>): string {
  const pairs: Array<[string, unknown]> = [
    ['key', String(a['key'])],
    ['provider', String(a['provider'])],
    ['model', String(a['model'])],
  ]
  for (const k of ['baseUrl', 'apiKeyRef'] as const) {
    if (a[k]) pairs.push([k, String(a[k])])
  }
  pairs.push(['contextWindow', Number(a['contextWindow'])])
  if (a['maxTokens']) pairs.push(['maxTokens', Number(a['maxTokens'])])
  pairs.push(['billing', 'usage'])
  pairs.push(['costPerMTokIn', Number(a['costPerMTokIn'] ?? 0)])
  pairs.push(['costPerMTokOut', Number(a['costPerMTokOut'] ?? 0)])
  const body = pairs
    .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n')
  return `    {\n${body}\n    }`
}
