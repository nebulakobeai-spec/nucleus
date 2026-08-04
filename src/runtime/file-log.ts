import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { redactText } from '../auth/credentials.js'

/**
 * 落盘日志 —— 给「另一台机器上常驻，出问题把日志交上来」这个回路用。
 *
 * ── 为什么不另造一条日志路径 ────────────────────────────
 *
 * 事件流已经有了（`RunEvent`），而 `TeeEventSink.subscribe()` 正是为「除了落库
 * 之外还想看一眼」准备的接入点 —— CLI 的过程树就用它。所以这里只是**再订一份，
 * 写进文件**，不改任何现有代码路径。
 *
 * 事件流能回答「发生了什么」，回答不了「模型当时看到了什么」—— 而后者往往才是
 * 失败的原因（历史被裁掉了、约束块被砍半了、工具描述有歧义）。所以 serve 在
 * **run 失败时**额外 dump 那个 run 的 transcript；成功的 run 不 dump，
 * 否则仓库会无限膨胀，而**git 历史是永久的**。
 *
 * （`nucleus bundle` 仍然是「一次往返拿到最多信息」的正式渠道，它自己 boot
 * 一个实例，所以不能在 serve 里就地复用 —— pglite 是单连接的。）
 *
 * ── 凭据在写盘前就被抹掉 ────────────────────────────
 *
 * 不是提交前抹，是**写盘前**抹。理由：一旦落到磁盘上，它就可能被别的东西
 * （编辑器备份、备份软件、一次手滑的 `git add -A`）带走，而 git 一旦收下
 * 就永久留在历史里 —— 即使后来删掉。
 *
 * `redactText` 认已知形态：`sk-*`、`xai-*`、z.ai 的 hex32.alnum16、`Bearer *`，
 * 以及「字段名 : 值」（api_key / token / secret / password / authorization），
 * **引号可以是转义的或单引号**——转义那一版是写这个模块时才发现漏掉的，
 * 而它恰恰是日志里最常见的形态（一段 JSON 被当字符串写进外层）。
 *
 * **它不认没见过的格式**，所以这不是「安全了」，是「已知的那些不会漏」。
 */

export interface FileLogOptions {
  dir: string
  /** 保留几个文件（含今天）。git 历史是永久的，所以这里必须有上限 */
  keepDays?: number
  /** 单日文件的字节上限，超过就停写并留一行说明 */
  maxBytesPerDay?: number
  /** 注入时间，测试用 */
  now?: () => Date
}

const DEFAULT_KEEP_DAYS = 14
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** `serve-2026-08-04.jsonl` —— 按天切，方便直接看某天发生了什么 */
export function logFileName(d: Date): string {
  return `serve-${d.toISOString().slice(0, 10)}.jsonl`
}

/**
 * 哪些文件算日志 —— 清理只删自己写的。
 *
 * 用严格的正则而不是 `endsWith('.jsonl')`：`logs/` 目录将来可能放别的东西
 * （比如 bundles 子目录、一份说明），而一个会删掉别人文件的清理逻辑
 * 是最不该有的那种「顺手」。
 */
export const LOG_NAME = /^serve-\d{4}-\d{2}-\d{2}\.jsonl$/

/** 超出保留天数的文件名（升序里最旧的那些） */
export function expiredFiles(names: string[], keepDays: number): string[] {
  const logs = names.filter((n) => LOG_NAME.test(n)).sort()
  return logs.length <= keepDays ? [] : logs.slice(0, logs.length - keepDays)
}

export class FileLog {
  #dir: string
  #keepDays: number
  #maxBytes: number
  #now: () => Date
  /** 当天写了多少字节 —— 超上限后只写一行说明，不再继续 */
  #day = ''
  #bytes = 0
  #capped = false

  constructor(opts: FileLogOptions) {
    this.#dir = opts.dir
    this.#keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS
    this.#maxBytes = opts.maxBytesPerDay ?? DEFAULT_MAX_BYTES
    this.#now = opts.now ?? (() => new Date())
    mkdirSync(this.#dir, { recursive: true })
  }

  /** 当前在写哪个文件 —— 启动时要打出来，否则「日志在哪」得靠猜 */
  get path(): string {
    return join(this.#dir, logFileName(this.#now()))
  }

  /**
   * 写一条。
   *
   * **同步写**（`appendFileSync`）。异步写在进程被 SIGKILL 掉时会丢掉缓冲里的
   * 内容 —— 而那恰好是最需要看的那几行（崩溃前发生了什么）。日志量不大，
   * 换来的是「日志里有的就是真发生过的」。
   */
  write(kind: string, data: Record<string, unknown>): void {
    const now = this.#now()
    const day = now.toISOString().slice(0, 10)
    const rolled = day !== this.#day
    if (rolled) {
      this.#day = day
      this.#bytes = existsSync(this.path) ? statSync(this.path).size : 0
      this.#capped = false
    }
    if (this.#capped) return

    const line = redactText(JSON.stringify({ t: now.toISOString(), kind, ...data })) + '\n'
    const size = Buffer.byteLength(line)

    if (this.#bytes + size > this.#maxBytes) {
      this.#capped = true
      // **说出来。** 静默停写会让人以为「那段时间什么都没发生」
      const note =
        JSON.stringify({
          t: now.toISOString(),
          kind: 'log.capped',
          maxBytes: this.#maxBytes,
          note: '当天日志到上限，后续不再写入。调 --log-max-mb 或看数据库',
        }) + '\n'
      appendFileSync(this.path, note)
      return
    }
    appendFileSync(this.path, line)
    this.#bytes += size
    /**
     * 清理放在**写完之后**，不是跨天时立刻。
     *
     * 放在前面的话今天的文件还不存在，于是 `keepDays: 2` 实际保留的是
     * 「2 个旧的 + 今天」共 3 个 —— 而「保留 14 天」的直觉是**总共 14 个**。
     * 差一个不要紧，语义含糊要紧：那个数字将来会被人用来算仓库会长多大。
     */
    if (rolled) this.#sweep()
  }

  /** 删掉超出保留期的 —— git 历史是永久的，无上限的日志会让每次 clone 都变大 */
  #sweep(): void {
    for (const n of expiredFiles(readdirSync(this.#dir), this.#keepDays)) {
      try {
        unlinkSync(join(this.#dir, n))
      } catch {
        /* 删不掉不该影响写日志 */
      }
    }
  }
}
