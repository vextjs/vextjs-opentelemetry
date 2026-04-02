# Changelog

All notable changes to `vextjs-opentelemetry` will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.

---

## [Unreleased]

---

## [0.1.1] - 2026-04-02

### Added

- **`metrics.customLabels`** — 为 HTTP 指标（`httpRequestTotal` / `httpRequestDuration`）附加自定义业务标签
  - 支持静态对象形式：`customLabels: { "env": "production" }`
  - 支持函数形式：`customLabels: (req) => ({ "tenant.id": req.headers["x-tenant-id"] ?? "default" })`
  - 函数抛错时优雅降级为空对象，基础指标正常记录，输出 warn 日志
  - `httpActiveRequests` 不含 customLabels（仅 `http.method`，符合 OTEL 语义约定）
  - 新增 5 个单元测试用例覆盖全部场景

- **`vext.preload` 自动注入** — `package.json` 新增 `vext.preload` 字段
  - 使用 `vext start` / `vext dev` 时自动注入 `--import vextjs-opentelemetry/instrumentation`
  - 无需用户手动配置 `--import` 参数，真正实现零配置接入

---

## [0.1.0] - 2026-03-31

### Added

- **`opentelemetryPlugin()`** 工厂函数 — VextJS 官方 OpenTelemetry 插件核心入口
  - 自动注册全局 HTTP 追踪中间件（Span 属性标注 + ALS 日志关联 + HTTP 指标统计）
  - 通过 `app.extend('otel', {...})` 将 `tracer` / `meter` / `metrics` 挂载到 `app.otel`
  - 支持 `enabled: false` 完全跳过（no-op），适合通过环境变量动态控制
  - SDK 未初始化时以 Noop 模式运行，零 overhead，不抛错

- **HTTP 追踪中间件** (`src/middleware.ts`)
  - 标注 active Span 属性：`http.route` / `http.request_id` / `http.status_code` / `vext.service`
  - 支持 `tracing.extraAttributes`（对象或函数形式）扩展自定义 Span 属性
  - 请求异常时自动调用 `span.recordException()` 并设置 `SpanStatusCode.ERROR`
  - 4xx/5xx 响应自动设置 Span 错误状态

- **F-03 ALS 日志关联** — 自动将 `traceId` / `spanId` 写入 ALS store
  - vext 框架内置 logger mixin 自动读取，注入 `trace_id` / `span_id` 到每条请求日志
  - 无需修改 `app.config.logger.mixin`（deepFrozen 对象），零配置生效

- **内置标准 HTTP 指标**
  - `http.server.duration`（Histogram，毫秒）— 请求时长，支持自定义分桶边界
  - `http.server.request.total`（Counter）— 请求总数，含 method / status_code / route 标签
  - `http.server.active_requests`（UpDownCounter）— 当前活跃请求数

- **`./instrumentation` 子路径** (`src/instrumentation.ts`) — SDK 初始化入口
  - 通过 `--import vextjs-opentelemetry/instrumentation` 在应用启动前加载
  - 全部使用动态 `import()` + try/catch，缺失 optional peer dep 时优雅降级
  - 支持 OTLP HTTP 导出器（Trace + Metrics）
  - `@opentelemetry/auto-instrumentations-node` 为可选项，未安装时降级并输出 warning
  - 内置 SIGTERM handler，应用退出时自动 flush 未发送的遥测数据
  - 支持全套环境变量配置（`OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_ENDPOINT` 等）

- **TypeScript 类型扩展** (`src/types.ts`)
  - `OpenTelemetryPluginOptions` — 插件配置接口（全部字段可选）
  - `OtelAppExtension` — `app.otel` 扩展对象类型（tracer / meter / metrics）
  - `OtelMetrics` — 内置 HTTP 指标集合类型
  - `declare module 'vextjs'` — 自动扩展 `VextApp.otel?` 和 `VextConfig.otel?`，用户零手写 `.d.ts`

- **ESM + CJS 双模式发布**
  - 主入口：`import` → `dist/index.js`，`require` → `dist/index.cjs`
  - instrumentation 子路径：仅 ESM（`dist/instrumentation.js`）
  - TypeScript 类型声明随包发布（`dist/**/*.d.ts`）

- **工程配置**
  - TypeScript strict 模式，`target: ES2022`，`moduleResolution: NodeNext`
  - Vitest 测试框架，覆盖率目标：核心模块（plugin.ts + middleware.ts）≥ 90%，整体 ≥ 85%
  - Prettier 代码格式化（双引号 / 有分号 / 2 空格 / 80 字符）
  - esbuild CJS 构建脚本（`scripts/build-cjs.mjs`）

### Dependencies

**Required peer dependencies:**

- `vextjs` `^0.2.3`
- `@opentelemetry/api` `^1.9.0`

**Optional peer dependencies:**

- `@opentelemetry/sdk-node` `^0.57.0`
- `@opentelemetry/exporter-trace-otlp-http` `^0.57.0`
- `@opentelemetry/exporter-metrics-otlp-http` `^0.57.0`
- `@opentelemetry/auto-instrumentations-node` `^0.57.0`

---

[Unreleased]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.1...HEAD
[0.1.1]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.0...vextjs-opentelemetry@0.1.1
[0.1.0]: https://github.com/vextjs/vextjs-plugins/releases/tag/vextjs-opentelemetry@0.1.0
