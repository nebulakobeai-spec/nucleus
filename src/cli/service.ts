import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { c, heading, ICON, line, strFlag } from './ui.js'

/**
 * `nucleus serve --install` —— 开机自启。
 *
 * ── 为什么生成一份 plist 而不是自己做守护 ────────────────
 *
 * 「进程挂了要自己拉起来」「开机要自己起来」这两件事，操作系统已经做得很好了。
 * 自己写一个看守进程意味着**那个看守进程自己也需要被看守** ——
 * 而它没有开机自启的能力，于是问题只是往上挪了一层。
 *
 * macOS 上是 launchd。这条命令只做一件事：把 plist 写出来，并把
 * `launchctl` 命令打给你 —— **不代替你执行**。
 *
 * ── 为什么不自动 load ──────────────────────────────
 *
 * 装一个开机自启的常驻进程是**对机器的持久改动**，而这条命令跑在一个
 * 「加个规则」「看看 run」都很随意的 CLI 里。写文件是可逆且可读的
 * （你能先打开看一眼再决定），`launchctl load` 是即刻生效的。
 * 这两件事该分开，而分界线正好是「要不要你亲手敲一下」。
 *
 * ── plist 里那几项都是踩过的 ──────────────────────────
 *
 * · `KeepAlive.SuccessfulExit: false` —— 只在**异常**退出时拉起。
 *   写 `KeepAlive: true` 的话，你 Ctrl-C 停掉它,launchd 会立刻再拉起来，
 *   而你以为自己停掉了。
 * · `StandardOutPath` / `StandardErrorPath` —— 不给的话输出进 /dev/null，
 *   于是「它到底有没有在跑」只能靠猜。
 * · `EnvironmentVariables` —— launchd 启动的进程**拿不到你 shell 里的环境**。
 *   `NUCLEUS_CONFIG`、`OPENAI_API_KEY` 这些都在 `~/.zshrc` 里，
 *   而 launchd 从不读它。不显式写进来的话，服务会起来、连不上模型、
 *   然后每个 run 都失败 —— 而错误指向 provider，不指向「环境变量没传进来」。
 */

const LABEL = 'ai.nucleus.serve'

export interface PlistInput {
  /** node 可执行文件的绝对路径 */
  node: string
  /** dist/cli/index.js 的绝对路径 */
  cli: string
  configPath: string | null
  databaseUrl: string | null
  logDir: string
  /** 要透传的环境变量名 —— launchd 不读 shell 配置，缺一个都会静默变成 run 失败 */
  passEnv: string[]
  env: Record<string, string | undefined>
}

/**
 * 生成 plist。纯函数 —— 生成的是要长期躺在系统里的东西，
 * 而 XML 里少一个标签的症状是「服务不起，日志为空」。
 */
export function renderPlist(input: PlistInput): string {
  const args = [input.node, input.cli, 'serve']
  if (input.configPath) args.push('--config', input.configPath)
  if (input.databaseUrl) args.push('--db', input.databaseUrl)

  const envEntries = input.passEnv
    .filter((k) => input.env[k] !== undefined)
    .map((k) => `      <key>${k}</key>\n      <string>${esc(input.env[k]!)}</string>`)

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      <string>${esc(a)}</string>`).join('\n')}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <!-- 只在异常退出时拉起。写成 <true/> 的话你 Ctrl-C 停掉它会被立刻拉回来 -->
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>

    <!-- 不给日志路径的话输出进 /dev/null，「有没有在跑」就只能靠猜 -->
    <key>StandardOutPath</key>
    <string>${esc(join(input.logDir, 'serve.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${esc(join(input.logDir, 'serve.err.log'))}</string>
${
  envEntries.length
    ? `
    <!-- launchd 不读 ~/.zshrc。这些不显式传进来的话，服务会起来但连不上模型 -->
    <key>EnvironmentVariables</key>
    <dict>
${envEntries.join('\n')}
    </dict>
`
    : ''
}  </dict>
</plist>
`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 哪些环境变量要透传。
 *
 * **不能一股脑把 process.env 全塞进去** —— 那会把整个 shell 环境（含无关的
 * token）写进一个躺在 `~/Library/LaunchAgents/` 的明文文件里。
 * 只列运行时真的会读的那些。
 */
export const PASS_ENV = [
  'NUCLEUS_CONFIG',
  'NUCLEUS_DATABASE_URL',
  'NUCLEUS_PGLITE_DIR',
  'NUCLEUS_WORKDIR',
  'NUCLEUS_AGENTS_DIR',
  'NUCLEUS_RULES_DIR',
  'OLLAMA_BASE_URL',
  'PATH',
  'HOME',
  'NODE_EXTRA_CA_CERTS',
]

export async function installService(flags: Record<string, string | true>): Promise<number> {
  if (process.platform !== 'darwin') {
    line(c.red(`--install 目前只支持 macOS（launchd），当前是 ${process.platform}`))
    line(c.gray('  Linux 上用 systemd --user：把 nucleus serve 写成一个 unit 即可'))
    return 1
  }

  const cli = resolve(process.argv[1] ?? '')
  if (!existsSync(cli)) {
    line(c.red(`找不到 CLI 入口：${cli}`))
    return 1
  }

  const logDir = strFlag(flags, 'log-dir') ?? join(homedir(), 'Library', 'Logs', 'nucleus')
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)

  /**
   * **配置路径必须写成绝对路径。**
   *
   * launchd 启动的进程 cwd 是 `/`，而配置查找是「从 cwd 逐级向上」——
   * 从 `/` 往上找什么都找不到，于是它会静默回落到内置默认（只有 mock），
   * 然后每个 run 都用一个假模型跑完。那比起不来更糟。
   */
  const configPath = strFlag(flags, 'config') ?? process.env['NUCLEUS_CONFIG'] ?? null
  const abs = configPath ? resolve(configPath.replace(/^~/, homedir())) : null
  if (abs && !existsSync(abs)) {
    line(c.red(`配置文件不存在：${abs}`))
    return 1
  }

  const plist = renderPlist({
    node: process.execPath,
    cli,
    configPath: abs,
    databaseUrl: strFlag(flags, 'db') ?? process.env['NUCLEUS_DATABASE_URL'] ?? null,
    logDir,
    passEnv: PASS_ENV,
    env: process.env,
  })

  await mkdir(logDir, { recursive: true })
  await mkdir(dirname(plistPath), { recursive: true })
  await writeFile(plistPath, plist, 'utf8')

  heading('已生成 launchd 配置')
  line(`${c.gray('plist')}  ${plistPath}`)
  line(`${c.gray('日志')}   ${join(logDir, 'serve.log')}`)
  line(`${c.gray('配置')}   ${abs ?? c.yellow('（没有 —— 服务会回落到内置默认，只有 mock 模型）')}`)
  line()

  if (!abs) {
    line(`${ICON.warn} ${c.yellow('没有配置文件路径')}`)
    line(c.gray('  launchd 启动的进程 cwd 是 /，而配置是从 cwd 逐级向上找的 ——'))
    line(c.gray('  从 / 往上找不到任何东西，于是会静默用内置默认（只有 mock 模型）。'))
    line(c.gray('  加上 --config /绝对/路径/nucleus.config.json 重新生成。'))
    line()
  }

  const missing = PASS_ENV.filter((k) => process.env[k] === undefined)
  if (missing.length) {
    line(c.gray(`没写进 plist（当前 shell 里没有）：${missing.join(', ')}`))
    line(c.gray('  如果模型要用其中某个，先 export 再重新生成 —— launchd 不读 ~/.zshrc'))
    line()
  }

  /**
   * **不自动 load。** 装一个开机自启的常驻进程是对机器的持久改动，
   * 而这条命令跑在一个「加个规则」都很随意的 CLI 里。
   */
  line(c.bold('接下来自己敲这两行：'))
  line(`  ${c.cyan(`launchctl load -w ${plistPath}`)}`)
  line(`  ${c.cyan(`tail -f ${join(logDir, 'serve.log')}`)}`)
  line()
  line(c.gray(`停掉：launchctl unload -w ${plistPath}`))
  line(c.gray('  没有自动 load —— 写文件可逆且你能先打开看一眼，load 是即刻生效的。'))
  return 0
}
