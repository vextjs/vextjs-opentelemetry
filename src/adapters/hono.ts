// src/adapters/hono.ts
// Hono 框架适配器
//
// 用法：
//   import { createHonoMiddleware } from "vextjs-opentelemetry/hono";
//   app.use(createHonoMiddleware({ serviceName: "my-app" }));
//
// ── withSpan 注入说明 ───────────────────────────────────────────
// Hono 使用泛型 Variables 管理 context 变量，无法通过 declare module 全局扩展。
// 推荐在应用侧声明 Variables 类型，并通过 c.get("withSpan") 使用：
//
//   import { withSpan } from "vextjs-opentelemetry";
//   import type { Hono } from "hono";
//
//   type AppVariables = { withSpan: typeof withSpan };
//   const app = new Hono<{ Variables: AppVariables }>();
//   app.use(createHonoMiddleware({ serviceName: "my-app" }));
//
//   app.get("/users/:id", async (c) => {
//     const result = await c.get("withSpan")("db.query", async (span) => {
//       span.setAttribute("db.table", "users");
//       return db.findUser(c.req.param("id"));
//     });
//     return c.json(result);
//   });

import type { MiddlewareHandler, Context as HonoContext } from "hono";

import { buildCoreHandlers } from "../core/http-core.js";
import type { HttpOtelOptions, OtelHttpContext } from "../core/types.js";

export type { OtelHttpContext, HttpOtelOptions };

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
