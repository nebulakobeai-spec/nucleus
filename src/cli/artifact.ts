import { writeFile } from 'node:fs/promises'
import { boot, type Nucleus } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { c, heading, ICON, line, strFlag, table, resolveDb } from './ui.js'

/**
 * `nucleus artifact` —— 把产出读出来。
 *
 * 为什么必须有：整套 context 策略是「summary 只写结论，完整内容写成
 * artifact 后在 artifacts 中引用」。引用本身在会话里可见，但**内容以前
 * 取不出来** —— 既没有命令能读，也没有工具能读（read_file 读的是文件系统，
 * 而 write_report 从不落盘）。加上内容一度根本没被保存，
 * 引用指向的就是一个不存在的东西。
 */

async function open(flags: Record<string, string | true>): Promise<Nucleus> {
  const { config } = await loadConfig(strFlag(flags, 'config'))
  return boot({
    config,
    ...resolveDb(flags),
    skipMcp: true,
  })
}

interface Row {
  ref: string
  path: string
  kind: string
  bytes: number | null
  summary: string | null
  trust_level: string
  agent_id: string | null
  created_at: Date
}

export async function artifactList(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const n = await open(flags)
  try {
    const runPrefix = argv[0] ?? strFlag(flags, 'run')
    const r = await n.db.query<Row>(
      runPrefix
        ? `select a.*, r.agent_id from artifacts a
             join runs r on r.id = a.run_id
            where r.root_run_id::text like $1 or r.id::text like $1
            order by a.created_at`
        : `select a.*, r.agent_id from artifacts a
             left join runs r on r.id = a.run_id
            order by a.created_at desc limit 30`,
      runPrefix ? [`${runPrefix}%`] : [],
    )

    heading(runPrefix ? `产出（run ${runPrefix}）` : '最近的产出')
    if (r.rows.length === 0) {
      line(c.gray('（没有）'))
      return 0
    }
    table(
      r.rows.map((x) => [
        x.path,
        x.agent_id ?? c.gray('?'),
        x.bytes === null ? c.gray('?') : formatBytes(x.bytes),
        // untrusted 的内容永不进长期 prompt（DESIGN.md §8），显示上也要区分
        x.trust_level === 'untrusted_tool_output' ? c.yellow(x.trust_level) : c.gray(x.trust_level),
        c.gray((x.summary ?? '').slice(0, 40)),
      ]),
      ['路径', 'AGENT', '大小', '可信度', '摘要'],
    )
    line()
    line(c.gray('读内容：nucleus artifact cat <路径或 ref 片段>'))
    return 0
  } finally {
    await n.close()
  }
}

export async function artifactCat(argv: string[], flags: Record<string, string | true>): Promise<number> {
  const needle = argv[0]
  if (!needle) {
    line(c.red('用法：nucleus artifact cat <路径或 ref 片段> [--out <文件>]'))
    return 1
  }

  const n = await open(flags)
  try {
    const r = await n.db.query<Row & { content: string | null }>(
      `select a.*, r.agent_id from artifacts a
         left join runs r on r.id = a.run_id
        where a.ref like $1 or a.path like $1
        order by a.created_at desc limit 5`,
      [`%${needle}%`],
    )
    if (r.rows.length === 0) {
      line(c.red(`没找到匹配「${needle}」的产出`))
      line(c.gray('看清单：nucleus artifact list'))
      return 1
    }
    if (r.rows.length > 1) {
      line(`${ICON.warn} 匹配到 ${r.rows.length} 个，取最新的一个：`)
      for (const x of r.rows) line(c.gray(`  ${x.ref}`))
      line()
    }

    const hit = r.rows[0]!
    if (hit.content === null) {
      line(`${ICON.warn} ${c.yellow('这条产出没有内容')}`)
      line(
        c.gray(
          '它是在「artifact 内容不落库」的版本里写下的 —— 只记了长度和摘要，' +
            '原文已经不存在。重跑那个任务才能拿回来。',
        ),
      )
      return 1
    }

    const out = strFlag(flags, 'out')
    if (out) {
      await writeFile(out, hit.content, 'utf8')
      line(`${ICON.ok} 已写入 ${out}（${formatBytes(hit.content.length)}）`)
      return 0
    }

    heading(hit.path)
    line(
      c.gray(
        `${hit.agent_id ?? '?'} · ${formatBytes(hit.content.length)} · ${hit.trust_level}` +
          ` · ${new Date(hit.created_at).toLocaleString()}`,
      ),
    )
    if (hit.trust_level === 'untrusted_tool_output') {
      line(`${ICON.warn} ${c.yellow('内容来自外部工具，按不可信处理 —— 不要直接当事实用')}`)
    }
    line()
    line(hit.content)
    return 0
  } finally {
    await n.close()
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
