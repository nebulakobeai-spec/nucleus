import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    // PGlite 是进程内的，每个测试文件一个实例
    pool: 'forks',
    /**
     * 超时给得宽。
     *
     * ── 为什么不是 30 秒 ──────────────────────────────
     *
     * 实测：同一批测试单独跑 19.5 秒全绿，在机器有别的负载时（我并行跑了
     * 另一个 vitest）报 2 个失败 —— 而且**两次失败的不是同一个测试**，
     * 失败点都在 `PgliteDb.open()` / `db.close()` 这类建库拆库的地方。
     *
     * 那种失败最坏的地方不是它假，而是它**教人重跑而不是读**。
     * 一个「多试几次就绿了」的套件，等于把真失败的信号也一起废掉了 ——
     * 下一次真的坏了，第一反应还是重跑。
     *
     * 代价只是真卡住时多等一会儿；换来的是**红色一定意味着坏了**。
     * 这与 requestTimeoutMs 那次是同一个判断：太短的代价比太长严重得多。
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
