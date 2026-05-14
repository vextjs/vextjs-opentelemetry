// examples/egg-middleware.ts
//
// Egg.js 接入 vextjs-opentelemetry 完整示例
//
// ─────────────────────────────────────────────────────────────
// 原理说明：
//   Egg.js 运行时仍基于 Koa，但库侧已经提供 `vextjs-opentelemetry/egg`
//   专属适配器与默认 raw ctx 类型，无需消费方再手写 any 标注。
// ─────────────────────────────────────────────────────────────
//
// 前提：SDK 需通过 --require 预加载（Egg.js / Koa 场景统一使用 initOtel）。
//
// package.json 中添加启动命令示例：
// {
//   "scripts": {
//     "start": "egg-scripts start --require ./app/otel-init.cjs",
//     "dev":   "egg-bin dev --require ./app/otel-init.cjs"
//   }
// }
// ─────────────────────────────────────────────────────────────

// 注意：本示例使用相对跨包路径，发布后改为：
// import { createEggMiddleware } from "vextjs-opentelemetry/egg";
import {
  createEggMiddleware,
  type EggContextLike,
} from "../src/adapters/egg.js";
import type { HttpObservationContext } from "../src/core/types.js";

type AppEggContext = EggContextLike & {
  user_id?: string;
  feature_flag?: string;
  state?: Record<string, unknown> & {
    userId?: string;
    user?: { id?: string };
  };
};

// ── 步骤 1：创建 Egg.js 中间件文件（app/middleware/otel.ts）──

/**
 * Egg.js 中间件工厂函数
 *
 * 在 config/config.default.ts 中注册：
 *   config.middleware = ["otel"];
 *   config.otel = { serviceName: "my-egg-app" };
 */
export default createEggMiddleware<AppEggContext>({
  serviceName: "my-egg-app",
  tracing: {
    // 忽略健康检查路径，不产生追踪数据
    ignorePaths: ["/health", "/ping", "/favicon.ico"],

    // 自定义 Span 名称（路由匹配完成后可获取 ctx.route）
    spanNameResolver: (ctx: HttpObservationContext) =>
      `${ctx.method} ${ctx.route ?? ctx.path}`,

    // 请求开始阶段附加稳定业务属性
    startAttributes: (_ctx, rawCtx: AppEggContext) => ({
      "tenant.id": rawCtx.get("x-tenant-id") || "",
      "api.version": rawCtx.get("x-api-version") || "v1",
    }),

    // 请求结束阶段再读取需要完整 raw ctx 的字段
    endAttributes: (_ctx, rawCtx: AppEggContext) => ({
      "request.body.present": Boolean(rawCtx.request?.body),
    }),
  },
  metrics: {
    // 自定义指标维度标签
    labels: (ctx: HttpObservationContext) => ({
      "app.env": process.env.NODE_ENV ?? "unknown",
      "api.version": (ctx.headers["x-api-version"] as string) ?? "v1",
    }),
  },

  lifecycle: {
    onStart: (_ctx, rawCtx: AppEggContext) => {
      const stateUser = rawCtx.state?.user as { id?: string } | undefined;
      rawCtx.user_id = (rawCtx.state?.userId as string | undefined) ?? stateUser?.id ?? "";
      rawCtx.feature_flag = rawCtx.get("x-feature-flag") || "";
    },
    onEnd: (ctx, rawCtx: AppEggContext, info) => {
      rawCtx.logger?.info?.(
        `${ctx.method} ${rawCtx.status} ${ctx.route ?? ctx.path} ${info.latencyMs}ms`,
      );
    },
  },
});

// ── 步骤 2：注册中间件（config/config.default.ts）──────────

// export default (appInfo: EggAppInfo) => {
//   return {
//     middleware: ["otel"],   // 将 otel 中间件放在第一位（全局覆盖）
//     otel: {
//       serviceName: "my-egg-app",
//     },
//   };
// };

// ── 步骤 3：SDK 初始化（app/otel-init.cjs）

// "use strict";
// const { initOtel } = require("vextjs-opentelemetry/koa");
// initOtel({
//   serviceName: process.env.OTEL_SERVICE_NAME || "my-egg-app",
//   endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || "47.89.182.109:32767",
//   instrumentations: [
//     // new HttpInstrumentation(),
//   ],
// });

// ── 关键说明 ────────────────────────────────────────────────
//
// 1. routerPath 读取时机：
//    Egg.js Router（基于 koa-router）在路由匹配后
//    自动将 ctx.routerPath 设为路由模板（如 "/users/:id"）。
//    createKoaMiddleware 在 await next() 之后读取 ctx.routerPath，
//    因此可以正确获取路由模板。
//
// 2. 无需修改现有路由代码：
//    只需将 otel 中间件加到 middleware 列表第一位即可，
//    现有 Controller / Service / Router 代码零修改。
//
// 3. 日志关联：
//    vextjs-opentelemetry SDK 会自动将当前 Span 的
//    trace_id / span_id 注入到日志上下文中，
//    搭配 Egg.js 默认的 egg-logger 即可实现日志与链路的关联。
