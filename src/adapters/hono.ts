// src/adapters/hono.ts
// Hono 框架适配器
//
// 用法：
//   import { createHonoMiddleware } from "vextjs-opentelemetry/hono";
//   app.use(createHonoMiddleware({ serviceName: "my-app" }));

import type { MiddlewareHandler, Context as HonoContext } from "hono";

import { buildCoreHandlers } from "../core.js";
import type { HttpOtelOptions, OtelHttpContext } from "../types.js";

export { OtelHttpContext, HttpOtelOptions };

/**
 * 创建 Hono 追踪中间件
 *
 * @param options 追踪选项（全部可选）
 * @returns Hono `MiddlewareHandler`（可直接传入 `app.use()`）
 *
 * @example
 * import { createHonoMiddleware } from "vextjs-opentelemetry/hono";
 * app.use(createHonoMiddleware({ serviceName: "my-hono-app" }));
 */
export function createHonoMiddleware(options: HttpOtelOptions = {}): MiddlewareHandler {
  const handlers = buildCoreHandlers(options);

  return async function otelHonoMiddleware(
    c: HonoContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const url = new URL(c.req.url);
    const requestId = c.req.header("x-request-id");
    const otelCtx: OtelHttpContext = {
      method: c.req.method,
      path: url.pathname,
      route: undefined, // await next() 之后从 c.req.routePath 获取
      requestId,
      headers: Object.fromEntries(
        [...new Headers(c.req.raw.headers).entries()].map(([k, v]) => [k, v]),
      ),
    };

    const state = handlers.onRequestStart(otelCtx);

    try {
      await next();

      // Hono 在 next() 之后填充 routePath（路由模板，如 "/users/:id"）
      const finalCtx: OtelHttpContext = {
        ...otelCtx,
        route: c.req.routePath !== "*" ? c.req.routePath : url.pathname,
      };
      handlers.onRequestEnd(state, finalCtx, c.res?.status ?? 200);
    } catch (err) {
      handlers.onRequestError(state, otelCtx, err);
      throw err;
    }
  };
}
