// src/instrumentation.ts
//
// OpenTelemetry SDK 初始化入口（v1.0.0 重构）
//
// 唯一推荐初始化方式：
//   node --import @devcodex/opentelemetry/instrumentation server.js
//
// 框架 CLI 等价（自动注入）：
//   vext start / vext dev
//
// Docker / K8s 环境变量方式：
//   ENV NODE_OPTIONS="--import @devcodex/opentelemetry/instrumentation"
//
// 配置来源、preload gate 与 SDK 初始化逻辑位于 instrumentation-main.ts。
// 此入口必须保持轻量：Node 的 ESM hook 只影响在 register() 之后发生的 import。

import { registerEsmInstrumentationHook } from "./core/esm-loader-hook.js";

registerEsmInstrumentationHook();
await import("./instrumentation-main.js");

export {};
