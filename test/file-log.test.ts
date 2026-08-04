import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expiredFiles, FileLog, LOG_NAME, logFileName } from '../src/runtime/file-log.js'

/**
 * 常驻进程的落盘日志 —— 给「另一台机器上出了什么事」这个回路用。
 *
 * 两条约束决定了它的形状，而两条都来自「**日志要进 git 仓库**」：
 *
 *  ① 凭据在**写盘前**就要抹掉，不是提交前。一旦落到磁盘就可能被别的东西带走
 *    （编辑器备份、一次手滑的 `git add -A`），而 git 一旦收下就永久留在历史里。
 *  ② 必须有上限。无上限的日志会让每一次 clone 都变大，而且**永远变不回来**。
 */

let tmp: string | null = null
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

const at = (iso: string) => () => new Date(iso)

describe('写盘前抹掉凭据', () => {
  it('sk-* / Bearer / JSON 里的 api_key 都不会落盘', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-log-'))
    const log = new FileLog({ dir: tmp, now: at('2026-08-04T10:00:00Z') })
    log.write('llm.call', {
      headers: 'Authorization: Bearer abcdefghijklmnop',
      body: '{"api_key":"super-secret-value"}',
      note: 'sk-proj-AAAAAAAAAAAAAAAA 是我的 key',
    })
    const text = await readFile(log.path, 'utf8')
    expect(text).not.toMatch(/abcdefghijklmnop/)
    expect(text).not.toMatch(/super-secret-value/)
    expect(text).not.toMatch(/sk-proj-AAAAAAAAAAAAAAAA/)
  })

  /**
   * **这一条不是「测通过了就安全了」。**
   *
   * `redactText` 认的是已知形态。没见过的 token 格式它认不出来 ——
   * 所以这条测试证明的是「已知的那些不会漏」，不是「日志可以随便公开」。
   */
  it('不认识的格式认不出来 —— 这是已知限制，写下来而不是假装没有', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-log-'))
    const log = new FileLog({ dir: tmp, now: at('2026-08-04T10:00:00Z') })
    log.write('x', { weird: 'nk_live_ZZZZZZZZZZZZ' })
    expect(await readFile(log.path, 'utf8')).toMatch(/nk_live_ZZZZZZZZZZZZ/)
  })

  it('正文照旧写进去 —— 除了凭据都要留', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-log-'))
    const log = new FileLog({ dir: tmp, now: at('2026-08-04T10:00:00Z') })
    log.write('tool.intent', { tool: 'delegate', goal: '查一下 2026 年的显卡价格' })
    const text = await readFile(log.path, 'utf8')
    expect(text).toMatch(/2026 年的显卡价格/)
    expect(JSON.parse(text.trim())).toMatchObject({ kind: 'tool.intent', tool: 'delegate' })
  })
})

describe('按天切，有保留上限', () => {
  it('文件名按 UTC 日期', () => {
    expect(logFileName(new Date('2026-08-04T23:59:00Z'))).toBe('serve-2026-08-04.jsonl')
  })

  it('超出保留天数的最旧那些被列出来', () => {
    const names = ['serve-2026-08-01.jsonl', 'serve-2026-08-02.jsonl', 'serve-2026-08-03.jsonl']
    expect(expiredFiles(names, 2)).toEqual(['serve-2026-08-01.jsonl'])
    expect(expiredFiles(names, 3)).toEqual([])
  })

  /**
   * **清理只删自己写的。** `logs/` 将来会放别的东西（bundles、一份说明），
   * 而一个会删掉别人文件的清理逻辑是最不该有的那种「顺手」。
   */
  it('不碰不是自己写的文件', () => {
    const names = ['README.md', 'bundles', 'serve.log', 'serve-2026-08-01.jsonl']
    expect(expiredFiles(names, 0)).toEqual(['serve-2026-08-01.jsonl'])
    expect(LOG_NAME.test('serve.log')).toBe(false)
    expect(LOG_NAME.test('README.md')).toBe(false)
  })

  it('跨天时清掉过期的', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-log-'))
    for (const d of ['01', '02', '03']) await writeFile(join(tmp, `serve-2026-08-${d}.jsonl`), 'x\n')
    // keepDays=2：写第 4 天时应该只留最近 2 天 + 今天
    const log = new FileLog({ dir: tmp, keepDays: 2, now: at('2026-08-04T00:00:00Z') })
    log.write('serve.started', {})
    const left = (await readdir(tmp)).sort()
    expect(left).toEqual(['serve-2026-08-03.jsonl', 'serve-2026-08-04.jsonl'])
  })
})

describe('单日上限', () => {
  /**
   * 到上限时**留一行说明**再停写。
   *
   * 静默停写会让人以为「那段时间什么都没发生」—— 而那正是最需要看的时候
   * （日志爆掉往往意味着有东西在疯狂重试）。
   */
  it('超上限后停写，但留下一行说明为什么', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'nuc-log-'))
    const log = new FileLog({ dir: tmp, maxBytesPerDay: 300, now: at('2026-08-04T10:00:00Z') })
    for (let i = 0; i < 50; i++) log.write('noise', { i, pad: 'x'.repeat(40) })

    const lines = (await readFile(log.path, 'utf8')).trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!)
    expect(last.kind).toBe('log.capped')
    expect(last.note).toMatch(/上限/)
    // 停写之后不再增长
    const before = lines.length
    log.write('noise', { more: true })
    expect((await readFile(log.path, 'utf8')).trim().split('\n').length).toBe(before)
  })
})
