// src/adapters/egg.ts
// Egg.js 框架适配器
//
// 自动注入到 ctx 的字段（框架字段，无需在业务代码中处理）：
//   - trace_id     当前请求的 W3C trace ID
//   - span_name    `${method} ${routerPath}`
//   - endpoint     routerPath
//   - latency_ms   请求总耗时（ms）
//
// 业务字段通过统一 lifecycle 回调注入，字段来源显式可见：
//   lifecycle: {
//     onStart: (_ctx, rawCtx) => {
//       rawCtx.user_id = rawCtx.state?.userId ?? '';
//       rawCtx.feature_flag = rawCtx.get('x-feature-flag') || '';
//     },
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
//     lifecycle: {
//       onStart: (_ctx, rawCtx) => {
//         rawCtx.user_id = rawCtx.state?.userId ?? '';
//         rawCtx.feature_flag = rawCtx.get('x-feature-flag') || '';
//       },
//       onEnd: (ctx, rawCtx, info) => {
//         rawCtx.logger?.info?.(`${ctx.method} ${rawCtx.status} ${ctx.route ?? ctx.path} ${info.latencyMs}ms`);
//       },
//     },
//   });
//
//   // config/config.default.ts
//   config.middleware = ['otel'];

import { trace } from "@opentelemetry/api";
import type { Context } from "koa";
import { createKoaMiddleware } from "./koa.js";
import type { HttpOtelOptions } from "../core/types.js";

export type { HttpOtelOptions };

export interface EggTracerLike {
  traceId?: string;
}

export interface EggLoggerLike {
  info?: (...args: unknown[]) => unknown;
  warn?: (...args: unknown[]) => unknown;
  error?: (...args: unknown[]) => unknown;
  debug?: (...args: unknown[]) => unknown;
}

export interface EggRequestLike {
  body?: unknown;
  length?: number;
}

export interface EggContextLike {
  method: string;
  path: string;
  status?: number;
  routerPath?: string;
  headers?: Record<string, string | string[] | undefined>;
  state?: Record<string, unknown>;
  request?: EggRequestLike;
  logger?: EggLoggerLike;
  tracer?: EggTracerLike;
  trace_id?: string;
  span_name?: string;
  endpoint?: string;
  latency_ms?: number;
  get(name: string): string;
}

export type EggMiddleware<TEggCtx extends EggContextLike = EggContextLike> = (
  ctx: TEggCtx,
  next: () => Promise<void>,
) => Promise<void>;

export type EggMiddlewareFactory<TEggCtx extends EggContextLike = EggContextLike> = (
  _options: unknown,
  _app: unknown,
) => EggMiddleware<TEggCtx>;

export type EggOtelOptions<TEggCtx extends EggContextLike = EggContextLike> =
  HttpOtelOptions<TEggCtx>;

const ZERO_TRACE_ID = "00000000000000000000000000000000";

/**
 * Egg.js 中间件工厂
 *
 * 符合 Egg.js 中间件规范（`(options, app) => Middleware`）。
 * 自动处理：HTTP span 创建、trace_id/span_name/endpoint/latency_ms 注入、请求计时。
 */
export function createEggMiddleware(
  otelOptions?: EggOtelOptions,
): EggMiddlewareFactory;
export function createEggMiddleware<TEggCtx extends EggContextLike>(
  otelOptions: EggOtelOptions<TEggCtx>,
): EggMiddlewareFactory<TEggCtx>;
export function createEggMiddleware<TEggCtx extends EggContextLike = EggContextLike>(
  otelOptions: EggOtelOptions<TEggCtx> = {},
): EggMiddlewareFactory<TEggCtx> {
  const koaMiddleware = createKoaMiddleware(
    otelOptions as unknown as HttpOtelOptions<Context>,
  );

  return function eggMiddlewareFactory(
    _options: unknown,
    _app: unknown,
  ): EggMiddleware<TEggCtx> {
    return async function otelEggMiddleware(
      ctx: TEggCtx,
      next: () => Promise<void>,
    ): Promise<void> {
      ctx.trace_id = "";
      ctx.span_name = `${ctx.method} ${ctx.path}`;
      ctx.endpoint = ctx.path;
      ctx.latency_ms = 0;

      const wrappedNext = async () => {
        const rawTraceId = trace.getActiveSpan()?.spanContext().traceId ?? "";
        ctx.trace_id = rawTraceId !== ZERO_TRACE_ID ? rawTraceId : "";
        // 同步到 Egg 内置 tracer.traceId，使 access log 中第三段显示 OTel trace_id
        if (ctx.trace_id && ctx.tracer && typeof ctx.tracer === "object") {
          ctx.tracer.traceId = ctx.trace_id;
        }
        return next();
      };

      const startTime = performance.now();
      try {
        await koaMiddleware(ctx as unknown as Context, wrappedNext);
      } finally {
        const route = ctx.routerPath ?? ctx.path;
        const latencyMs = Math.round(performance.now() - startTime);
        ctx.span_name = `${ctx.method} ${route}`;
        ctx.endpoint = route;
        ctx.latency_ms = latencyMs;
      }
    };
  };
}

/** @deprecated 请使用 createEggMiddleware */
export const defineEggMiddleware = createEggMiddleware;

