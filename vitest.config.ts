import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    // PGlite 是进程内的，每个测试文件一个实例
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
