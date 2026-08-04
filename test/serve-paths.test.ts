import { describe, expect, it } from 'vitest'
import { servePaths } from '../src/cli/serve.js'

/**
 * 常驻进程的三个路径。
 *
 * ── 「相对路径 + cwd 不确定的进程」这条咬了三次 ────────────────
 *
 * launchd 启动的进程 **cwd 是 `/`**，而三处默认值都是相对的：
 *
 * | | 症状 |
 * |---|---|
 * | `rulesDir` | 规则静默消失，`rule add` 写到一个没人看的目录 |
 * | `logDir`   | 日志写到 `/logs`，没权限，于是静默为空 |
 * | `dataDir`  | pglite 库建到 `/.nucleus-data`，服务起不来 |
 *
 * 三次都**不报错**，只是东西不在你以为的地方。
 *
 * 这个判断原先埋在 `serve()` 里 —— 而那是个跑起来就不退出的命令，
 * 只能靠手动开一次服务来验，也就是实际上没人验。拆出来就是为了这个。
 */

const CWD = '/Users/x/somewhere/else'
const CONFIG = '/Users/x/proj/nucleus.config.json'

describe('相对路径按配置文件解析', () => {
  it('pglite 目录落在配置文件旁边，不是 cwd', () => {
    const p = servePaths({ databaseUrl: null, dataDir: '.nucleus-data/pglite' }, CONFIG, {
      logDir: null,
      cwd: CWD,
    })
    expect(p.dataDir).toBe('/Users/x/proj/.nucleus-data/pglite')
    expect(p.dataDir).not.toContain('somewhere/else')
  })

  it('日志目录同理', () => {
    const p = servePaths({ databaseUrl: null, dataDir: 'd' }, CONFIG, { logDir: null, cwd: CWD })
    expect(p.logDir).toBe('/Users/x/proj/logs')
  })

  /**
   * **launchd 下 cwd 是 `/`。** 这一条是那三个 bug 的共同形状：
   * 按 cwd 解析的话，两个路径都会指向根目录。
   */
  it('cwd 是 / 时也不会指向根目录', () => {
    const p = servePaths({ databaseUrl: null, dataDir: '.nucleus-data/pglite' }, CONFIG, {
      logDir: null,
      cwd: '/',
    })
    expect(p.dataDir).toBe('/Users/x/proj/.nucleus-data/pglite')
    expect(p.logDir).toBe('/Users/x/proj/logs')
  })

  it('绝对路径原样用', () => {
    const p = servePaths({ databaseUrl: null, dataDir: '/var/lib/nucleus' }, CONFIG, {
      logDir: '/var/log/nucleus',
      cwd: CWD,
    })
    expect(p.dataDir).toBe('/var/lib/nucleus')
    expect(p.logDir).toBe('/var/log/nucleus')
  })
})

describe('当场给的按 cwd', () => {
  /**
   * `--log-dir ./tmp-logs` 想的是「当前目录下那个」——
   * 命令行上当场给的路径按 cwd 解析才符合直觉，与配置里的路径不同。
   */
  it('--log-dir 是相对的时候按 cwd，而不是配置文件', () => {
    const p = servePaths({ databaseUrl: null, dataDir: 'd' }, CONFIG, {
      logDir: 'tmp-logs',
      cwd: CWD,
    })
    expect(p.logDir).toBe('/Users/x/somewhere/else/tmp-logs')
  })
})

describe('没有配置文件时', () => {
  /**
   * 没找到配置文件时只能按 cwd —— 但那时 `serve` 会在启动报告里显著提示
   * 「内置默认，没找到配置文件」，因为那意味着只有 mock 模型。
   */
  it('回落到 cwd', () => {
    const p = servePaths({ databaseUrl: null, dataDir: 'data' }, null, { logDir: null, cwd: CWD })
    expect(p.dataDir).toBe('/Users/x/somewhere/else/data')
    expect(p.logDir).toBe('/Users/x/somewhere/else/logs')
  })
})

describe('用 postgres 时', () => {
  it('连接串原样传下去，dataDir 仍然算出来（不用但不该是相对的）', () => {
    const p = servePaths(
      { databaseUrl: 'postgres://h/db', dataDir: '.nucleus-data/pglite' },
      CONFIG,
      { logDir: null, cwd: '/' },
    )
    expect(p.databaseUrl).toBe('postgres://h/db')
    expect(p.dataDir.startsWith('/Users/x/proj')).toBe(true)
  })
})
