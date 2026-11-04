// dsh-code-review 0.2.0 —— 单元/集成测试配置
// 约定：测试文件位于 test/ 下，命名 *.test.ts；不依赖真实网络。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只收集 TypeScript 测试，避免误跑 0.1.3 的 .mjs 冒烟脚本
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 每个测试文件独立进程，避免模块级状态互相污染
    pool: 'forks',
    // 单测不应长时间挂起，默认给 15 秒
    testTimeout: 15_000,
  },
})
