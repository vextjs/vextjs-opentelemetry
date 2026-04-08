// src/adapters/egg.ts
// Egg.js 框架适配器
//
// 自动注入到 ctx 的字段（框架字段，无需在业务代码中处理）：
//   - trace_id     当前请求的 W3C trace ID
//   - span_name    `${method} ${routerPath}`
//   - endpoint     routerPath
//   - latency_ms   请求总耗时（ms）
//
// 业务字段通过 onCtxInit 回调注入，字段来源显式可见：
//   onCtxInit: (ctx) => {
//     ctx.user_id = ctx.state?.userId ?? '';
//     ctx.feature_flag = ctx.get('x-feature-flag') || '';
//   }
//
// 类型扩展：在项目 typings/index.d.ts 的 egg.Context 接口中声明 ctx 字段：
//
//   declare module 'egg' {
//     interface Context {
//       trace_id: string;
//       span_name: string;
//       endpoint: string;
//       latency_ms: number;
//       user_id: string;
//       feature_flag: string;
//     }
//   }
//
// 用法：
//   // app/middleware/otel.ts
//   import { createEggMiddleware } from 'vextjs-opentelemetry/egg';
//   export default createEggMiddleware({
//     serviceName: 'my-service',
//     tracing: { ignorePaths: [/^\/favicon/] },
//     onCtxInit: (ctx) => {
//       ctx.user_id = ctx.state?.userId ?? '';
//       ctx.feature_flag = ctx.get('x-feature-flag') || '';
//     },
//     onRequestDone: (ctx, info) => {
//       ctx.logger.info(`${info.method} ${ctx.status} ${info.route} ${info.latencyMs}ms`);
//     },
//   });
//
//   // config/config.default.ts
//   config.middleware = ['otel'];

import { trace } from "@opentelemetry/api";
import { createKoaMiddleware } from "./koa.js";
import type { HttpOtelOptions } from "../core/types.js";

export type { HttpOtelOptions };

const ZERO_TRACE_ID = "00000000000000000000000000000000";

export interface EggHttpOtelOptions extends HttpOtelOptions {
  /**
   * 请求初始化时的回调，在 OTel span 创建前执行。
   * 用于注入业务特定字段（如 user_id、feature_flag）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCtxInit?: (ctx: any) => void;
  /**
   * 请求完成时的回调，在 finally 块中执行。
   * 用于自定义 access log 或其他请求后处理。
   * @param info.method   HTTP 方法
   * @param info.route    匹配的路由路径（routerPath 或 path）
   * @param info.latencyMs 请求耗时（ms）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRequestDone?: (ctx: any, info: { method: string; route: string; latencyMs: number }) => void;
}

/**
 * Egg.js 中间件工厂
 *
 * 符合 Egg.js 中间件规范（`(options, app) => Middleware`）。
 * 自动处理：HTTP span 创建、trace_id/span_name/endpoint/latency_ms 注入、请求计时。
 */
export function createEggMiddleware(otelOptions: EggHttpOtelOptions = {}) {
  const { onCtxInit, onRequestDone, ...koaOptions } = otelOptions;
  const koaMiddleware = createKoaMiddleware(koaOptions);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function eggMiddlewareFactory(_options: unknown, _app: unknown): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async function otelEggMiddleware(ctx: any, next: () => Promise<void>): Promise<void> {
      ctx.trace_id = "";
      ctx.span_name = `${ctx.method} ${ctx.path}`;
      ctx.endpoint = ctx.path;
      ctx.latency_ms = 0;
      onCtxInit?.(ctx);

      const wrappedNext = async () => {
        const rawTraceId = trace.getActiveSpan()?.spanContext().traceId ?? "";
        ctx.trace_id = rawTraceId !== ZERO_TRACE_ID ? rawTraceId : "";
        return next();
      };

      const startTime = performance.now();
      try {
        await koaMiddleware(ctx, wrappedNext);
      } finally {
        const route = ctx.routerPath ?? ctx.path;
        const latencyMs = Math.round(performance.now() - startTime);
        ctx.span_name = `${ctx.method} ${route}`;
        ctx.endpoint = route;
        ctx.latency_ms = latencyMs;
        onRequestDone?.(ctx, { method: ctx.method, route, latencyMs });
      }
    };
  };
}

/** @deprecated 请使用 createEggMiddleware */
export const defineEggMiddleware = createEggMiddleware;

