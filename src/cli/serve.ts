import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { isMockOnly } from '../config.js'
import { describeCron } from '../runtime/cron.js'
import { ScheduleStore } from '../store/schedules.js'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { FileLog } from '../runtime/file-log.js'
import { TeeEventSink } from '../runtime/events.js'
import { c, heading, ICON, line, resolveDb, strFlag } from './ui.js'
import { redactText } from '../auth/credentials.js'

/**
 * `nucleus serve` —— 常驻进程。
 *
 * ── 为什么这条命令必须存在 ────────────────────────────
 *
 * `Worker.run()`（长驻循环）一直在 `worker.ts` 里，**零调用者** —— 连测试都没有。
 * 而 `tick()` 里已经会触发到点的计划（`#fireDueSchedules`）。
 *
 * 也就是说 cron 整套机制是通的，只差有人调 `run()`。在此之前唯一驱动 worker
 * 的地方是 `ask()` 里的 `drain()` —— **你打一句话才推进一次**。后果：
 *
 *  · 「每天 9:00 跑一次调研」这条计划，只在你恰好 9:00 在打字时才会发生。
 *    而 E 段标着「✅ 已完成」，因为当初的端到端验证是在一条 CLI 命令里跑的，
 *    那条命令自己 drain 了，所以看起来是通的。
 *  · `waiting_retry` 不会自己重试。（会话锁那个死锁就是它的症状，
 *    我当时写的「真正的修法是让重试由长驻 worker 推进」—— 就是这里。）
 *
 * **一个标着完成、实际不可能发生的功能，比一个缺失的功能更糟。**
 *
 * ── 为什么不加单实例锁 ────────────────────────────────
 *
 * 多 worker 是**设计里就支持的**：`workerId` + 租约 + fence token 三件套
 * 保证同一个 attempt 不会被跑两遍。所以两个 serve 同时跑是安全的，
 * 只是日志会分散在两个地方。启动时把 workerId 打出来，而不是拦住第二个。
 */

/**
 * 常驻进程要用的三个路径。
 *
 * ── 「相对路径 + cwd 不确定的进程」咬了三次 ──────────────────
 *
 * launchd 启动的进程 **cwd 是 `/`**，而这三处的默认值都是相对的：
 *
 *   rulesDir  规则静默消失，`rule add` 写到一个没人看的目录
 *   logDir    日志写到 `/logs`，没权限，于是静默为空
 *   dataDir   pglite 库建到 `/.nucleus-data`，服务起不来
 *
 * 三次都不报错，只是东西不在你以为的地方。所以相对路径一律按**配置文件所在
 * 目录**解析 —— 配置里的路径描述的是项目结构，cwd 只是进程恰好站在哪。
 *
 * 拆成纯函数是因为**这个判断本身就是 bug 的所在**，而它埋在一个跑起来就不退出
 * 的命令里 —— 那种代码只能靠手动开一次服务来验，也就是实际上没人验。
 *
 * `--log-dir` 例外：命令行上当场给的路径按 cwd 解析才符合直觉。
 */
export function servePaths(
  db: { databaseUrl: string | null; dataDir: string },
  configPath: string | null,
  opts: { logDir: string | null; cwd: string },
): { databaseUrl: string | null; dataDir: string; logDir: string } {
  const base = configPath ? dirname(configPath) : opts.cwd
  const abs = (p: string, from: string) => (isAbsolute(p) ? p : resolve(from, p))
  return {
    databaseUrl: db.databaseUrl,
    dataDir: abs(db.dataDir, base),
    // 当场给的按 cwd；没给的落在配置文件旁边
    logDir: opts.logDir ? abs(opts.logDir, opts.cwd) : join(base, 'logs'),
  }
}

/** 连接串里的密码不该进日志 —— 常驻进程的输出往往被重定向到文件 */
function redactUrl(url: string): string {
  return redactText(url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@'))
}

/**
 * 把一个 run 的完整 transcript 写进日志。
 *
 * 过 `redactText`（FileLog 里做）。transcript 含完整的 prompt 与模型回复 ——
 * 那是「模型为什么那么做」唯一的证据，也是这份日志里唯一真的会包含
 * 对话内容的地方。
 */
async function dumpTranscripts(
  n: Awaited<ReturnType<typeof boot>>,
  runId: string,
  log: FileLog,
): Promise<void> {
  const r = await n.db.query<Record<string, unknown>>(
    `select t.*, a.attempt_no from transcripts t
       join run_attempts a on a.id = t.run_attempt_id
      where a.run_id = $1 order by t.id`,
    [runId],
  )
  if (r.rows.length === 0) return
  log.write('transcripts', { run: runId, count: r.rows.length, rows: r.rows })
}

export async function serve(flags: Record<string, string | true>): Promise<number> {
  const { config, path: configPath } = await loadConfig(strFlag(flags, 'config'))

  const paths = servePaths(resolveDb(flags), configPath, {
    logDir: strFlag(flags, 'log-dir') ?? null,
    cwd: process.cwd(),
  })
  const db = { databaseUrl: paths.databaseUrl, dataDir: paths.dataDir }
  const log = new FileLog({
    dir: paths.logDir,
    keepDays: Number(strFlag(flags, 'log-keep-days') ?? 14),
    maxBytesPerDay: Number(strFlag(flags, 'log-max-mb') ?? 32) * 1024 * 1024,
  })

  const n = await boot({
    config,
    ...db,
    // 常驻进程要连 MCP —— 这是它和一次性 CLI 命令最大的区别：
    // 那些 stdio 子进程的生命周期跟着它，连一次用很久，而不是每条命令连一遍
    skipMcp: flags['no-mcp'] === true,
  })

  try {
    heading('nucleus serve')
    line(`${c.gray('worker')}  ${n.config.runtime.workerId}`)
    line(`${c.gray('配置')}    ${configPath ?? c.yellow('（内置默认，没找到配置文件）')}`)
    line(`${c.gray('模型链')}  ${n.config.defaults.modelChain.join(' → ')}`)
    line(`${c.gray('数据库')}  ${db.databaseUrl ? redactUrl(db.databaseUrl) : `pglite ${db.dataDir}`}`)
    line(`${c.gray('日志')}    ${log.path}`)

    /**
     * **pglite 撑不住常驻进程。**
     *
     * pglite 自己的 README 写着「PGlite is single user/connection」——
     * 它是 postgres 的单用户模式编译成 WASM。而它**没有锁文件**，所以两个
     * 进程开同一个目录不会报错，行为未定义。
     *
     * 实测就撞上了：serve 在跑时另开一条 `schedule history`，同一条命令里
     * 统计说「2 次跑失败」而表里只列出 1 行 —— 两次查询看到了不同的快照。
     *
     * **「大部分能用」是这里最坏的失败模式**：它不会在你配错的那天报错，
     * 而是在某次读到旧快照时给出一个说得通但是错的答案。
     *
     * 所以要么用真 postgres（`--db postgres://…` 或 NUCLEUS_DATABASE_URL），
     * 要么接受「serve 跑着的时候不碰任何别的 nucleus 命令」。
     */
    if (!db.databaseUrl) {
      line()
      line(`${ICON.warn} ${c.yellow('pglite 不支持多进程 —— 它是单连接的（pglite 自己的文档这么写）')}`)
      line(c.gray('  没有锁文件，所以另开一条 nucleus 命令不会报错，只会读到不确定的快照。'))
      line(c.gray('  常驻用真 postgres：--db postgres://… 或设 NUCLEUS_DATABASE_URL'))
      line(c.gray('  就这样跑也行 —— 但 serve 在跑期间别碰其它 nucleus 命令。'))
    }
    if (isMockOnly(n.config)) {
      line(`${ICON.warn} ${c.yellow('只有 mock 模型 —— 它的回答是假的')}`)
    }

    /**
     * 启动时就把「接下来会发生什么」说出来。
     *
     * 一个常驻进程最容易的失败是**什么都不做而看起来正常**：没有计划、
     * 或者计划全是停用的，日志里只有一片安静。那时你没法区分
     * 「在等」和「配错了」。
     */
    // ScheduleStore 没挂在 Nucleus 上 —— 自己建一个只读实例，与 worker 内部那个
    // 用同一个 db，不共享状态（store 本身无状态）
    const schedules = await new ScheduleStore(n.db, n.deps).list()
    const enabled = schedules.filter((s) => s.enabled)
    line()
    if (enabled.length === 0) {
      line(
        `${ICON.info} ${c.gray(
          schedules.length
            ? `${schedules.length} 条计划，但全都停用了 —— 不会有任何定时任务`
            : '没有定时任务。加一条：nucleus schedule add',
        )}`,
      )
      line(c.gray('  它仍然在做事：推进重试、跑 reconciler、接手别的进程留下的活'))
    } else {
      line(`${c.bold('定时任务')}（${enabled.length}）`)
      for (const s of enabled) {
        const next = s.nextFireAt ? s.nextFireAt.toLocaleString() : c.yellow('（算不出下次时刻）')
        line(`  ${s.name.padEnd(18)} ${c.gray(describeCron(s.cron, s.timezone))}  ${c.cyan(String(next))}`)
      }
    }

    line()
    line(c.gray('Ctrl-C 退出。退出时会交还租约，正在跑的 attempt 由下一个 worker 接手。'))
    line()

    /**
     * **优雅退出**：先让循环停在两次 tick 之间，再关连接。
     *
     * 直接 `process.exit()` 的代价是留下一个持有租约的 attempt ——
     * 那个 run 要等租约过期（默认 60s）才会被别人接手，而在那段时间里
     * 它在 `nucleus runs` 里看起来是「running」，实际上没有任何进程在跑它。
     * reconciler 最终会捞回来，但那是兜底，不该当成正常退出路径。
     */
    let stopping = false
    const stop = (sig: string) => {
      if (stopping) {
        // 第二次 Ctrl-C：不等了
        line(c.red('  强制退出 —— 租约要等过期才会被接手'))
        process.exit(130)
      }
      stopping = true
      line()
      line(c.gray(`  收到 ${sig}，跑完这一轮就退…`))
      n.worker.stop()
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))

    /**
     * **全量事件流写进日志文件。**
     *
     * `TeeEventSink.subscribe()` 本来就是为「除了落库还想看一眼」准备的接入点
     * （CLI 的过程树就用它），所以这里只是再订一份写文件，不改任何现有路径。
     *
     * 凭据在**写盘前**就被 `redactText` 抹掉 —— 不是提交前抹。一旦落到磁盘，
     * 它就可能被别的东西带走（编辑器备份、一次手滑的 `git add -A`），
     * 而 git 一旦收下就永久留在历史里。
     */
    const tee = n.events instanceof TeeEventSink ? n.events : null
    if (tee) {
      tee.subscribe((e) => {
        log.write(e.kind, { run: e.runId, attempt: e.attemptId, payload: e.payload })
      })
    } else {
      line(`${ICON.warn} ${c.yellow('事件流拿不到订阅口，日志里只会有 attempt 收尾与定时触发')}`)
    }

    log.write('serve.started', {
      worker: n.config.runtime.workerId,
      configPath,
      db: db.databaseUrl ? 'postgres' : `pglite ${db.dataDir}`,
      models: n.config.defaults.modelChain,
      schedules: enabled.map((s) => ({ name: s.name, cron: s.cron, tz: s.timezone })),
    })

    let lastIdleLog = 0
    await n.worker.run({
      onScheduleFire: (info) => {
        line(
          info.skipped === null
            ? `${ICON.ok} ${c.cyan('定时触发')} ${info.name} ${c.gray(`run ${info.runId?.slice(0, 8) ?? ''}`)}`
            : // 跳过的原因要说出来 —— 「什么都没发生」和「刻意跳过」看起来一样
              `${ICON.info} ${c.gray(`跳过 ${info.name}：${info.reason ?? info.skipped}`)}`,
        )
      },
      onAttemptEnd: (i) => {
        line(
          `${ICON.branch} ${c.gray(i.runId.slice(0, 8))} ${i.status}` +
            (i.errorCode ? ` ${c.gray(i.errorCode)}` : ''),
        )
        /**
         * **失败时把那个 run 的 transcript 也写进日志。**
         *
         * 事件流能回答「发生了什么」，回答不了「模型当时看到了什么」——
         * 而后者往往才是失败的原因（历史被裁掉了、约束块被砍半了、
         * 工具描述里有歧义）。
         *
         * 只在失败时写：成功的 run 也 dump 会让仓库无限膨胀，而 git 历史是永久的。
         * `void` 是刻意的 —— 日志写不出来不该拖住 worker 循环。
         */
        if (i.status === 'failed' && !i.errorCode?.startsWith('provider.')) {
          void dumpTranscripts(n, i.runId, log).catch(() => {
            /* 日志失败不影响运行 */
          })
        }
      },
      onIdle: () => {
        /**
         * 空闲时**不**每轮打一行 —— 500ms 一次会把日志刷成噪音，
         * 而噪音里看不出真正发生了什么。每 10 分钟一次心跳就够说明「它还活着」。
         */
        const now = Date.now()
        if (now - lastIdleLog > 600_000) {
          lastIdleLog = now
          line(c.gray(`  ${new Date(now).toLocaleTimeString()} 空闲`))
        }
      },
    })

    line(`${ICON.ok} 已退出`)
    return 0
  } finally {
    await n.close()
  }
}
