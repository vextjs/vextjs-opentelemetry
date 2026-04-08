#!/usr/bin/env node

/**
 * build-cjs.mjs — 生成 CJS 入口文件
 *
 * 在 `tsc -p tsconfig.build.json` 构建 ESM 输出到 `dist/` 之后运行。
 * 使用 esbuild 将主入口的 ESM 产物打包为单文件 CJS bundle。
 *
 * 目的：
 *   用户项目若通过 esbuild/vext-dev 编译为 CJS 格式（format: 'cjs'），
 *   会执行 `require('vextjs-opentelemetry')`。由于主包为 ESM-only，
 *   Node.js 18/20 无法直接 require() ESM 模块（ERR_REQUIRE_ESM）。
 *   此脚本生成 CJS 入口，配合 package.json exports 的 "require" 条件解决此问题。
 *
 * 注意：
 *   - `./instrumentation` 子路径为 ESM-only，不生成 CJS bundle。
 *     instrumentation 通过 `--import` 在应用启动前加载，始终处于 ESM 上下文，
 *     且使用了 top-level await，无法编译为 CJS。
 *
 * 生成文件：
 *   - dist/index.cjs  — 主入口 CJS bundle
 *
 * 运行方式：
 *   node scripts/build-cjs.mjs
 */

import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

/**
 * 外部依赖列表（不打包进 CJS bundle，保留为 require() 调用）
 *
 * 所有 peerDependencies 和 Node.js 内置模块均应列为 external，
 * 确保用户安装的版本被使用，避免依赖版本冲突。
 */
const externalDeps = [
  // vextjs 框架（optional peer dep，仅 ./vextjs 子路径需要）
  "vextjs",

  // 框架适配器（optional peer deps）
  "express",
  "koa",
  "hono",
  "fastify",

  // OpenTelemetry API（required peer dep）
  "@opentelemetry/api",
  "@opentelemetry/api-logs",

  // OpenTelemetry SDK 系列（optional peer deps）
  "@opentelemetry/sdk-node",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-trace-node",

  // OpenTelemetry 导出器（optional peer deps）
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-trace-otlp-grpc",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-grpc",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/exporter-logs-otlp-grpc",
  "@opentelemetry/exporter-trace-otlp-grpc",
  "@opentelemetry/exporter-metrics-otlp-grpc",

  // OpenTelemetry 传递性普通依赖（由 sdk-node 安装）
  "@opentelemetry/resources",
  "@opentelemetry/semantic-conventions",
  "@opentelemetry/core",
  "@opentelemetry/context-async-hooks",

  // OpenTelemetry 传递性依赖（init.ts 使用）
  "@opentelemetry/instrumentation",
  "@opentelemetry/otlp-transformer",

  // OpenTelemetry 自动检测（optional peer dep）
  "@opentelemetry/auto-instrumentations-node",

  // gRPC（OTel gRPC exporter 依赖，单实例要求）
  "@grpc/grpc-js",
  "@grpc/proto-loader",

  // Node.js 内置模块
  "node:*",
  "fs",
  "path",
  "url",
  "http",
  "https",
  "net",
  "os",
  "crypto",
  "stream",
  "events",
  "util",
  "child_process",
  "cluster",
  "module",
  "assert",
  "async_hooks",
  "worker_threads",
  "perf_hooks",
  "process",
];

/**
 * CJS 构建入口列表
 *
 * 仅构建主入口（"."）和 4 个框架适配器子路径的 CJS bundle。
 * "./instrumentation" 子路径为 ESM-only，不需要 CJS 版本（使用 top-level await）。
 */
const entries = [
  {
    name: "main",
    input: "dist/index.js",
    output: "dist/index.cjs",
  },
  {
    name: "express",
    input: "dist/adapters/express.js",
    output: "dist/adapters/express.cjs",
  },
  {
    name: "koa",
    input: "dist/adapters/koa.js",
    output: "dist/adapters/koa.cjs",
  },
  {
    name: "egg",
    input: "dist/adapters/egg.js",
    output: "dist/adapters/egg.cjs",
  },
  {
    name: "hono",
    input: "dist/adapters/hono.js",
    output: "dist/adapters/hono.cjs",
  },
  {
    name: "fastify",
    input: "dist/adapters/fastify.js",
    output: "dist/adapters/fastify.cjs",
  },
  {
    name: "vextjs",
    input: "dist/adapters/vextjs.js",
    output: "dist/adapters/vextjs.cjs",
  },
  {
    name: "log",
    input: "dist/log.js",
    output: "dist/log.cjs",
  },
];

async function buildCjs() {
  const startTime = Date.now();
  let built = 0;
  let skipped = 0;

  for (const entry of entries) {
    const inputPath = resolve(projectRoot, entry.input);

    if (!existsSync(inputPath)) {
      console.warn(
        `⚠️  [build-cjs] Skipping ${entry.name}: ${entry.input} not found`,
        "\n   Run `tsc -p tsconfig.build.json` first.",
      );
      skipped++;
      continue;
    }

    await build({
      entryPoints: [inputPath],
      outfile: resolve(projectRoot, entry.output),

      // ── 输出格式 ────────────────────────────────────────────
      format: "cjs",
      platform: "node",
      target: "node18",

      // ── 打包模式 ────────────────────────────────────────────
      // bundle: true — 将 vextjs-opentelemetry 内部的多个 ESM 文件
      // 合并为单个 CJS 文件。外部依赖保持 require() 调用不内联。
      bundle: true,

      // ── 外部依赖 ────────────────────────────────────────────
      external: externalDeps,

      // ── 优化选项 ────────────────────────────────────────────
      treeShaking: true,
      keepNames: true,
      charset: "utf8",
      sourcemap: false,

      // ── 日志级别 ────────────────────────────────────────────
      logLevel: "warning",

      // ── Banner ──────────────────────────────────────────────
      // 标记文件为自动生成，避免误编辑
      banner: {
        js: "/* Auto-generated CJS entry by build-cjs.mjs — DO NOT EDIT */",
      },
    });

    built++;
    console.log(
      `✅ [build-cjs] ${entry.name}: ${entry.input} → ${entry.output}`,
    );
  }

  const elapsed = Date.now() - startTime;

  if (skipped > 0) {
    console.warn(
      `\n⚠️  [build-cjs] ${skipped} entry(ies) skipped (missing ESM input).`,
    );
  }

  console.log(
    `\n🎉 [build-cjs] ${built} CJS bundle(s) generated in ${elapsed}ms`,
  );
}

buildCjs().catch((err) => {
  console.error("❌ [build-cjs] Failed:", err.message);
  process.exit(1);
});
