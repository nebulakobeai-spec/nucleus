import { defineConfig } from 'vitest/config'

/**
 * tier 3：真模型测试（本机 ollama）。
 *
 *   NUCLEUS_RECORD=1 npm run test:live   录制 fixture
 *   npm run test:live                    从 fixture 重放
 *
 * 录好的 fixture 提交进 git 后，tier 2 的离线测试就能永远确定性重放。
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // 真调用不并行，避免本机模型排队导致超时
    fileParallelism: false,
  },
})
