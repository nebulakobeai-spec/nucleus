import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfigDir } from '../src/config-file.js'
import { writeRuleFile } from '../src/cli/rule-new.js'

/**
 * 规则文件落在**哪里**。
 *
 * 这一组全部来自实测踩到的两个坑，两个都是「静默」的 ——
 * 不报错，只是东西不在你以为的地方。
 */

let tmp: string | null = null
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

describe('相对路径按配置文件解析，不是 cwd', () => {
  /**
   * ── 实测怎么暴露的 ────────────────────────────────
   *
   *     cd /tmp/elsewhere && nucleus rules      # 「还没有你自己写的规则」
   *
   * 配置文件是靠向上搜索（或 NUCLEUS_CONFIG）找到的，可能离 cwd 很远，
   * 而里面的 `rulesDir: "rules"` 原先按 cwd 解析。于是**规则静默消失**。
   * 更糟的是 `rule add` 会往 `/tmp/elsewhere/rules/` 写一个谁都不看的文件，
   * 然后提示「看一眼 nucleus rules」。
   *
   * 按配置文件解析是通行做法（tsconfig、eslint）：配置里的路径描述的是
   * **项目结构**，cwd 只是你恰好站在哪。
   */
  it('相对路径按配置文件所在目录', () => {
    expect(resolveConfigDir('rules', '/proj/nucleus.config.json')).toBe('/proj/rules')
  })

  it('嵌套的相对路径也一样', () => {
    expect(resolveConfigDir('conf/rules', '/proj/nucleus.config.json')).toBe('/proj/conf/rules')
  })

  it('绝对路径原样用', () => {
    expect(resolveConfigDir('/abs/rules', '/proj/nucleus.config.json')).toBe('/abs/rules')
  })

  /**
   * 环境变量与 `--dir` 是**当场**给的，按 cwd 才符合直觉 ——
   * 敲 `--dir ./tmp-rules` 时想的是当前目录下那个。
   */
  it('当场给的（--dir / 环境变量）按 cwd', () => {
    expect(resolveConfigDir('rules', '/proj/nucleus.config.json', true)).toBe(join(process.cwd(), 'rules'))
  })

  it('没有配置文件时只能按 cwd', () => {
    expect(resolveConfigDir('rules', null)).toBe(join(process.cwd(), 'rules'))
  })

  it('`..` 也按配置文件解析', () => {
    expect(resolveConfigDir('../shared/rules', '/proj/a/nucleus.config.json')).toBe('/proj/shared/rules')
  })
})

describe('写文件前建目录', () => {
  /**
   * ── 为什么这是个真 bug ────────────────────────────
   *
   * `rules/` 是**按需才有**的目录（仓库里只有 `examples/rules/`）——
   * 所以第一条规则的写入必然 ENOENT。
   *
   * 也就是说：向导一路问完、判层、校验、给你看完整内容、你按了 Y，
   * **最后一步炸掉**，而炸的原因和规则本身毫无关系。实测就是这么丢的：
   * `nucleus rules` 说「还没有你自己写的规则」，而使用者记得自己按过 Y。
   */
  it('目录不存在时自己建，不是 ENOENT', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-rules-'))
    const path = join(tmp, 'rules', 'foo.md')
    await writeRuleFile(path, '---\nappliesTo: [x]\n---\n')
    expect(await readFile(path, 'utf8')).toMatch(/appliesTo/)
  })

  it('多层目录一次建好 —— --dir 可以给嵌套路径', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-rules-'))
    const path = join(tmp, 'a', 'b', 'c', 'foo.md')
    await writeRuleFile(path, 'x')
    expect((await stat(path)).isFile()).toBe(true)
  })

  it('目录已存在时不报错', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-rules-'))
    const path = join(tmp, 'foo.md')
    await writeRuleFile(path, 'one')
    await writeRuleFile(path, 'two')
    expect(await readFile(path, 'utf8')).toBe('two')
  })
})
