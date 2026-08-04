import { describe, expect, it } from 'vitest'
import { PASS_ENV, renderPlist, type PlistInput } from '../src/cli/service.js'

/**
 * `nucleus serve --install` —— 开机自启的 launchd 配置。
 *
 * ── 为什么这个纯函数值得测 ────────────────────────────
 *
 * 它生成的是要**长期躺在系统里**的东西，而 XML 里少一个标签的症状是
 * 「服务不起，日志为空」—— 那时你已经不在写这段代码的上下文里了。
 */

const base: PlistInput = {
  node: '/opt/homebrew/bin/node',
  cli: '/Users/x/nucleus/dist/cli/index.js',
  configPath: '/Users/x/nucleus/nucleus.config.json',
  databaseUrl: null,
  dataDir: '/Users/x/nucleus/.nucleus-data/pglite',
  logDir: '/Users/x/Library/Logs/nucleus',
  passEnv: PASS_ENV,
  env: { NUCLEUS_CONFIG: '/Users/x/nucleus/nucleus.config.json', PATH: '/usr/bin', HOME: '/Users/x' },
}

describe('plist 的形状', () => {
  it('可执行文件、CLI、子命令、配置都在 ProgramArguments 里', () => {
    const p = renderPlist(base)
    expect(p).toMatch(/<string>\/opt\/homebrew\/bin\/node<\/string>/)
    expect(p).toMatch(/dist\/cli\/index\.js/)
    expect(p).toMatch(/<string>serve<\/string>/)
    expect(p).toMatch(/<string>--config<\/string>/)
  })

  /**
   * **`KeepAlive: true` 是错的。**
   *
   * 那样你 Ctrl-C 停掉它，launchd 会立刻再拉起来 —— 而你以为自己停掉了。
   * 只在**异常**退出时拉起才是想要的行为。
   */
  it('只在异常退出时拉起，而不是无条件 KeepAlive', () => {
    const p = renderPlist(base)
    expect(p).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    // 不能是裸的 <key>KeepAlive</key><true/>
    expect(p).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })

  /** 不给日志路径的话输出进 /dev/null，「有没有在跑」就只能靠猜 */
  it('日志有落点', () => {
    const p = renderPlist(base)
    expect(p).toMatch(/StandardOutPath[\s\S]*serve\.log/)
    expect(p).toMatch(/StandardErrorPath[\s\S]*serve\.err\.log/)
  })

  it('开机自启', () => {
    expect(renderPlist(base)).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  it('给了 db 就写进参数，没给就写 --data', () => {
    const pg = renderPlist({ ...base, databaseUrl: 'postgres://h/db' })
    expect(pg).toMatch(/--db/)
    expect(pg, '用 postgres 时不该再传 pglite 目录').not.toMatch(/--data/)
    expect(renderPlist(base)).not.toMatch(/--db/)
  })

  /**
   * **launchd 下 cwd 是 `/`。**
   *
   * `resolveDb` 默认的 `.nucleus-data/pglite` 是相对路径 —— 交互式用没问题，
   * 而在 launchd 下会变成 `/.nucleus-data/pglite`：没权限，于是服务起不来
   * 或者在根目录建一个库。这是同一个教训的第三次（rulesDir、logDir、dataDir）。
   */
  it('pglite 目录写成绝对路径', () => {
    expect(renderPlist(base)).toMatch(/<string>--data<\/string>/)
    expect(renderPlist(base)).toMatch(/<string>\/Users\/x\/nucleus\/\.nucleus-data\/pglite<\/string>/)
  })
})

describe('环境变量', () => {
  /**
   * **launchd 不读 `~/.zshrc`。**
   *
   * `NUCLEUS_CONFIG`、`OLLAMA_BASE_URL` 这些都在 shell 配置里，而 launchd
   * 从不加载它。不显式写进 plist 的话，服务会起来、连不上模型、然后每个 run
   * 都失败 —— 而错误指向 provider，不指向「环境变量没传进来」。
   */
  it('把运行时真的会读的那些写进去', () => {
    const p = renderPlist(base)
    expect(p).toMatch(/<key>NUCLEUS_CONFIG<\/key>/)
    expect(p).toMatch(/<key>PATH<\/key>/)
  })

  it('当前 shell 里没有的不写空值 —— 空的 PATH 比没有 PATH 更糟', () => {
    const p = renderPlist({ ...base, env: { HOME: '/Users/x' } })
    expect(p).not.toMatch(/<key>PATH<\/key>/)
    expect(p).not.toMatch(/<key>NUCLEUS_CONFIG<\/key>/)
  })

  /**
   * **这一条是安全约束。**
   *
   * plist 是明文，躺在 `~/Library/LaunchAgents/`。一股脑把 `process.env`
   * 塞进去会把整个 shell 环境写进那个文件 —— 而实测这台机器的 shell 里
   * 就有 `OPENAI_API_KEY` 与一个 JWT。
   *
   * 所以 PASS_ENV 是一份**白名单**，而且里面不能有任何看起来像密钥的名字：
   * 凭据该走 keychain / 0600 文件（那是 CredentialStore 的事），不该顺路
   * 复制进一个 launchd 配置。
   */
  it('PASS_ENV 是白名单，且不含任何密钥类名字', () => {
    for (const k of PASS_ENV) {
      expect(k, `${k} 看起来像凭据，不该进 plist`).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i)
    }
  })

  it('只输出白名单里的，env 里多余的一概不写', () => {
    const p = renderPlist({
      ...base,
      env: { ...base.env, OPENAI_API_KEY: 'sk-real-secret', RC_AUTH_TOKEN: 'jwt' },
    })
    expect(p).not.toMatch(/sk-real-secret/)
    expect(p).not.toMatch(/OPENAI_API_KEY/)
    expect(p).not.toMatch(/RC_AUTH_TOKEN/)
  })
})

describe('XML 转义', () => {
  /**
   * 路径里带 `&` 是合法的，而未转义的 `&` 会让整份 plist 解析失败 ——
   * 症状是服务不起而且日志为空（因为日志路径也在这份坏掉的文件里）。
   */
  it('路径里的 & < > 被转义', () => {
    const p = renderPlist({ ...base, cli: '/Users/x/a&b/<c>/index.js' })
    expect(p).toMatch(/a&amp;b/)
    expect(p).toMatch(/&lt;c&gt;/)
    expect(p).not.toMatch(/a&b/)
  })

  it('环境变量的值也转义', () => {
    const p = renderPlist({ ...base, env: { ...base.env, PATH: '/a&b:/c' } })
    expect(p).toMatch(/\/a&amp;b:\/c/)
  })
})
