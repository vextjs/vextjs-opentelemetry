# Changelog

All notable changes to `vextjs-opentelemetry` will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.

---

## [Unreleased]

---

## [0.1.4] - 2026-04-07

### Changed

- **升级至 OpenTelemetry JS SDK v2**（`@opentelemetry/sdk-node@^0.214.0`）：
  - `@opentelemetry/resources@2.x` 移除了 `Resource` 构造函数，改为 `resourceFromAttributes()` 工厂函数
  - `peerDependencies` 全面升级至对应 v2 版本（`resources@^2.6.1`、`core@^2.6.1`、`sdk-trace-node@^2.6.1` 等）

### Fixed

- `buildResource()` 中 `serviceName` 未写入 Resource 属性的 bug（已补充 `service.name` 字段）

---

## [0.1.3] - 2026-04-07

### Added

- **通用框架适配器** — 新增 5 个子路径导出，提供开箱即用的 HTTP 追踪中间件/钩子，无需在业务层手动初始化 OTel SDK：
  - `vextjs-opentelemetry/express` — Express 兼容中间件（`createExpressMiddleware`）
  - `vextjs-opentelemetry/koa` — Koa / Egg.js 兼容中间件（`createKoaMiddleware`）
  - `vextjs-opentelemetry/hono` — Hono 兼容中间件（`createHonoMiddleware`）
  - `vextjs-opentelemetry/fastify` — Fastify v3/v4 生命周期钩子插件（`createFastifyPlugin`），兼容 `routeOptions.url`（v4）和 `routerPath`（v3）回退
- **`OtelHttpContext`** — 适配器共享上下文接口（`method / path / statusCode / duration / traceId / spanId`），通过 `HttpOtelOptions.customLabels` 可注入自定义 Span 属性
- **`HttpOtelOptions`** — 适配器统一配置接口，支持 `serviceName / ignorePatterns / spanNameResolver / customLabels / onError`
- **`createStructuredLogFormatter`** (`vextjs-opentelemetry/log`) — Schema A 结构化 JSON 日志格式化器，固定字段顺序输出 `timestamp / level / message / service.name / env / host / trace_id / span / endpoint / latency_ms / user_id / exception.*`
- **`createOtelLogBridge`** (`vextjs-opentelemetry/log`) — Schema B OTel LogRecord 桥接，level → SeverityNumber 映射，`trace_id`/`span_id` 由 `LoggingInstrumentor` 自动注入
- **`OtelAppExtension.withSpan<T>()`** — 业务操作追踪便捷方法，封装 `tracer.startActiveSpan()` 的 try/catch/finally 样板代码
  - **成功路径**：自动调用 `span.end()`
  - **异常路径**：`span.recordException()` + `span.setStatus(ERROR)` + `span.end()` + re-throw
  - 支持传入原生 `SpanOptions`（`attributes` / `kind` / `links`），由 SDK 在 span 创建阶段写入，无需在回调内手动调用 `setAttributes()`
- **`tracing.ignorePaths`** (`OpenTelemetryPluginOptions`) — 忽略追踪的路径列表，支持字符串精确匹配或正则表达式；匹配路径不创建 Span、不写入 ALS，但仍统计 HTTP 指标
- **`tracing.spanNameResolver`** (`OpenTelemetryPluginOptions`) — 自定义 Span 名称解析函数，返回值覆盖默认的 `"HTTP {METHOD}"` 高基数名称
- **`VextConfig.otel.sampling.ratio`** — 采样率配置（0.0~1.0，默认 1.0 全量采样）；使用 `ParentBasedSampler(TraceIdRatioBasedSampler(ratio))` 初始化
- **SIGINT 优雅关闭** — 除 `SIGTERM` 外，新增 `SIGINT` 信号监听，支持 Ctrl+C 触发 SDK flush
- **进程资源自动检测** — 使用 `detectResourcesSync({ detectors: [processDetectorSync, envDetectorSync] })` 自动添加 `process.pid`、`process.runtime.*`、`process.owner` 等进程属性
- **`createKoaMiddleware` 双路径逻辑** — 无 active span 时自动创建 `SERVER` span，确保 Egg.js 等框架下请求始终被追踪

### Fixed

- **G-05: 检测器 API 名称错误** — 异步 `processDetector`/`envDetector` 在 `detectResourcesSync()` 下返回空属性；更正为同步变体 `processDetectorSync`/`envDetectorSync`

### Deprecated

- **`otlpHeaders`** (`OpenTelemetryPluginOptions`) 标记为 `@deprecated`—该选项不会影响 SDK 初始化阶段的请求头，请改用 `package.json` `vext.otel.headers`

---

## [0.1.2] - 2026-04-02

### Fixed

- **`selectAggregation` 崩溃修复** — 自定义 metric exporter（noop / file 模式）的 `selectAggregation()` 返回 `undefined` 导致 SDK 调用 `undefined.createAggregator()` 崩溃。移除该方法，由 SDK 使用默认聚合策略
  - 影响范围：所有使用 `otlpEndpoint` 配置本地文件导出或 none 模式的用户
  - 错误信息：`Cannot read properties of undefined (reading 'createAggregator')`

- **`traces.jsonl` 文件不生成修复** — file 模式的 trace exporter 对 SDK `ReadableSpan` 对象直接调用 `JSON.stringify()`，因对象内含循环引用（`_spanProcessor` 等）导致序列化静默失败。改为手动提取 `traceId`、`spanId`、`name`、`attributes`、`status` 等可序列化字段

### Added

- **`otlpEndpoint` 支持纯路径格式** — 无需 `file:` 前缀，直接传入绝对路径或相对路径即可触发文件导出模式
  - 绝对路径：`otlpEndpoint: join(process.cwd(), "otel-data")` → 存储到项目下 otel-data/ 目录
  - 相对路径：`otlpEndpoint: "./otel-data"` → 自动基于 `process.cwd()` 解析
  - 向后兼容：`file:` 前缀格式仍然支持

### Changed

- **文档新增「自动检测」章节** — 详细说明 MongoDB、Redis、MySQL、PostgreSQL 等数据库的自动追踪配置，包括支持的库列表、效果示例、禁用特定检测的方法、未安装时的降级行为

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

[Unreleased]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.3...HEAD
[0.1.3]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.2...vextjs-opentelemetry@0.1.3
[0.1.2]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.1...vextjs-opentelemetry@0.1.2
[0.1.1]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.0...vextjs-opentelemetry@0.1.1
[0.1.0]: https://github.com/vextjs/vextjs-plugins/releases/tag/vextjs-opentelemetry@0.1.0
