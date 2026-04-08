// src/index.ts
// 主入口（v1.0.0 重构）
//
// 框架无关 — 不依赖 vextjs / express / koa / hono / fastify。
// 各框架适配器请使用对应子路径：
//   import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs"
//   import { createKoaMiddleware } from "vextjs-opentelemetry/koa"
//   import { createEggMiddleware } from "vextjs-opentelemetry/egg"
//   import { createExpressMiddleware } from "vextjs-opentelemetry/express"
//   import { createFastifyPlugin } from "vextjs-opentelemetry/fastify"
//   import { createHonoMiddleware } from "vextjs-opentelemetry/hono"

// ── Span / Trace / Log 工具（业务代码直接使用）───────────────
export {
  withSpan,
  createWithSpan,
  getActiveSpan,
  getActiveTraceId,
  getActiveSpanId,
  getOtelStatus,
  getOtelLogger,
} from "./core/span.js";

// ── SDK 配置工具（框架适配器 setup 阶段调用）─────────────────
//
// 各框架可直接调用 attachExporterToSdk 向已启动的 SDK 挂载 exporter，
// 无需依赖具体框架的插件系统。
export { attachExporterToSdk } from "./core/sdk-config.js";
export type { AttachExporterConfig } from "./core/sdk-config.js";

// ── 高级 API：Deferred 处理器（自定义适配器使用）────────────
//
// 框架 / 库作者在实现自己的适配器时，可通过 getDeferredState()
// 直接访问 instrumentation.ts 创建的 Deferred 实例进行精细控制。
export {
  getDeferredState,
  DeferredSpanProcessor,
  DeferredMetricExporter,
  DeferredLogProcessor,
} from "./core/deferred.js";
export type { DeferredState } from "./core/deferred.js";

// ── 类型导出（框架无关）────────────────────────────────────
export type {
  OtelHttpContext,
  HttpOtelOptions,
  OnEndInfo,
  OtelConfig,
  ExportMode,
  OtelStatus,
  OtelMetrics,
  OtelAppExtension,
  OtelLogBridge,
  OtelLogBridgeOptions,
} from "./core/types.js";

// 常量导出（避免各处写死字符串）
export { DEFAULT_SERVICE_NAME } from "./core/types.js";

// ── 重新导出 @opentelemetry/api 核心类型（避免用户直接依赖 api 包）
export type { Span, SpanOptions, Tracer, Meter, Attributes } from "@opentelemetry/api";
