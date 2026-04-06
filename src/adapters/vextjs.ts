// src/adapters/vextjs.ts
// VextJS 框架适配器
//
// 用法：
//   import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs";
//
// 此子路径是唯一依赖 vextjs 框架的入口。
// 不使用 VextJS 的项目（Express、Koa、Egg.js、Hono 等）
// 应使用对应的子路径适配器，主入口不依赖任何框架。

export { opentelemetryPlugin } from "../plugin.js";

export type {
    OpenTelemetryPluginOptions,
    OtelAppExtension,
    OtelMetrics,
} from "../types.js";

// 激活 declare module 'vextjs' 类型扩展
// 用户导入此适配器时 IDE 将自动识别 app.otel / config.otel 类型
import "../types.js";
