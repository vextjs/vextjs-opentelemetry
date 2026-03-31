import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // ESM 条件导出解析：确保 vitest 正确解析 vextjs 等 ESM 包
    // 的 "import" 条件（NodeNext moduleResolution 需要显式声明）
    conditions: ["import", "node"],
  },
  test: {
    // 测试文件 glob
    include: ["test/**/*.test.{ts,js}"],

    // 超时（单个测试）
    testTimeout: 10_000,

    // 环境
    environment: "node",

    // 环境变量
    env: {
      NODE_ENV: "test",
    },

    // 覆盖率配置
    coverage: {
      // 使用 V8 原生覆盖率（无需额外依赖，Node.js 内置）
      provider: "v8",

      // 输出格式
      reporter: ["text", "lcov", "json-summary"],

      // 输出目录
      reportsDirectory: "coverage",

      // 只统计 src/ 下的源码覆盖率
      include: ["src/**/*.ts"],

      // 排除项
      exclude: [
        // 类型定义（纯类型无运行时代码，不参与覆盖率统计）
        "src/types.ts",
        // instrumentation.ts 使用 top-level await + 动态 import，
        // 在 vitest 环境下测试成本高，由集成测试覆盖
        "src/instrumentation.ts",
      ],

      // 核心模块（plugin.ts + middleware.ts）覆盖率目标 ≥90%
      // 整体目标 ≥85%
      thresholds: {
        "src/plugin.ts": {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        "src/middleware.ts": {
          lines: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
  },
});
