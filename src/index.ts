// src/index.ts
// 主入口：框架无关的 OTel 工具函数及公开类型
//
// 此入口 100% 框架无关 — 不依赖 vextjs / express / koa / hono / fastify。
// VextJS 插件用户请使用子路径：
//   import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs";

export { createWithSpan, getOtelStatus } from "./core.js";

export type {
  OtelMetrics,
  OtelHttpContext,
  HttpOtelOptions,
  OnEndInfo,
} from "./types.js";
