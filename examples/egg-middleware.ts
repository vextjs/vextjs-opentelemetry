// examples/egg-middleware.ts
//
// Egg.js 接入 vextjs-opentelemetry 完整示例
//
// ─────────────────────────────────────────────────────────────
// 原理说明：
//   Egg.js 的中间件等价于 Koa 中间件（签名完全相同），因此直接
//   使用 vextjs-opentelemetry/koa 适配器，无需任何适配层。
// ─────────────────────────────────────────────────────────────
//
// 前提：SDK 需通过 --import 预加载（与 VextJS 场景完全一致）。
//
// package.json 中添加启动命令示例：
// {
//   "scripts": {
//     "start": "node --import vextjs-opentelemetry/instrumentation node_modules/.bin/egg-scripts start",
//     "dev":   "node --import vextjs-opentelemetry/instrumentation node_modules/.bin/egg-bin dev"
//   }
// }
// ─────────────────────────────────────────────────────────────

// 注意：本示例使用相对跨包路径，发布后改为：
// import { createEggMiddleware } from "vextjs-opentelemetry/egg";
import { createEggMiddleware } from "../src/adapters/egg.js";
import type { OtelHttpContext } from "../src/core/types.js";

// ── 步骤 1：创建 Egg.js 中间件文件（app/middleware/otel.ts）──

/**
 * Egg.js 中间件工厂函数
 *
 * 在 config/config.default.ts 中注册：
 *   config.middleware = ["otel"];
 *   config.otel = { serviceName: "my-egg-app" };
 */
export default createEggMiddleware({
  serviceName: "my-egg-app",
  tracing: {
    // 忽略健康检查路径，不产生追踪数据
    ignorePaths: ["/health", "/ping", "/favicon.ico"],

    // 自定义 Span 名称（路由匹配完成后可获取 ctx.route）
    spanNameResolver: (ctx: OtelHttpContext) =>
      `${ctx.method} ${ctx.route ?? ctx.path}`,

    // 为每个 Span 附加业务维度属性
    extraAttributes: (ctx: OtelHttpContext) => ({
      "tenant.id": (ctx.headers["x-tenant-id"] as string) ?? "",
      "api.version": (ctx.headers["x-api-version"] as string) ?? "v1",
    }),
  },
  metrics: {
    // 自定义指标维度标签
    customLabels: (ctx: OtelHttpContext) => ({
      "app.env": process.env.NODE_ENV ?? "unknown",
      "api.version": (ctx.headers["x-api-version"] as string) ?? "v1",
    }),
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

// ── 步骤 3：SDK 初始化（vextjs-opentelemetry/instrumentation）

// otel-setup.mjs（在 --import 中指定，或通过 vext.preload 自动加载）：
//
// import { setupOpenTelemetry } from "vextjs-opentelemetry/instrumentation";
// setupOpenTelemetry({
//   otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "none",
//   serviceName:  process.env.OTEL_SERVICE_NAME ?? "my-egg-app",
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
