// src/index.ts
// 主入口：导出 opentelemetryPlugin 工厂函数及公开类型
//
// 用法：
//   import { opentelemetryPlugin } from "vextjs-opentelemetry";
//
// declare module 扩展通过导入 ./types.js 自动激活，
// 用户安装本包后 IDE 将自动识别 app.otel / config.otel 类型，无需手写 .d.ts。

export { opentelemetryPlugin } from "./plugin.js";

export type {
  OpenTelemetryPluginOptions,
  OtelAppExtension,
  OtelMetrics,
} from "./types.js";

// 激活 declare module 'vextjs' 类型扩展
// 此副作用导入确保模块增强在用户代码中生效，
// 即使用户仅导入类型（import type）也能获得完整的类型推断。
import "./types.js";
