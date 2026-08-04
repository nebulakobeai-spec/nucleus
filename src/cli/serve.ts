import { boot } from '../boot.js'
import { loadConfig } from '../config-file.js'
import { isMockOnly } from '../config.js'
import { describeCron } from '../runtime/cron.js'
import { ScheduleStore } from '../store/schedules.js'
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

/** 连接串里的密码不该进日志 —— 常驻进程的输出往往被重定向到文件 */
function redactUrl(url: string): string {
  return redactText(url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@'))
}

export async function serve(flags: Record<string, string | true>): Promise<number> {
  const { config, path: configPath } = await loadConfig(strFlag(flags, 'config'))
  const n = await boot({
    config,
    ...resolveDb(flags),
    // 常驻进程要连 MCP —— 这是它和一次性 CLI 命令最大的区别：
    // 那些 stdio 子进程的生命周期跟着它，连一次用很久，而不是每条命令连一遍
    skipMcp: flags['no-mcp'] === true,
  })

  const db = resolveDb(flags)

  try {
    heading('nucleus serve')
    line(`${c.gray('worker')}  ${n.config.runtime.workerId}`)
    line(`${c.gray('配置')}    ${configPath ?? c.yellow('（内置默认，没找到配置文件）')}`)
    line(`${c.gray('模型链')}  ${n.config.defaults.modelChain.join(' → ')}`)
    line(`${c.gray('数据库')}  ${db.databaseUrl ? redactUrl(db.databaseUrl) : `pglite ${db.dataDir}`}`)

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
