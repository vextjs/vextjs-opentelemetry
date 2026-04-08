// src/adapters/express.ts
// Express 框架适配器
//
// 用法：
//   import { createExpressMiddleware } from "vextjs-opentelemetry/express";
//   app.use(createExpressMiddleware({ serviceName: "my-app" }));
//
// Egg.js 不在此适配器范围内，请使用 vextjs-opentelemetry/koa。
//
// 注意（Express route 时序）：
//   在 app.use() 全局中间件中，req.route 在此时为 undefined（路由匹配尚未发生）。
//   本适配器通过 res.on('finish') 回调延迟读取 req.route?.path，
//   以获取路由模板。若 auto-instrumentation 先于此回调关闭 Span，
//   Span 属性更新为 no-op（无 crash）。
//   建议通过 spanNameResolver 精细控制 Span 名称。

import type { Request, Response, NextFunction, RequestHandler } from "express";

import { withSpan } from "../core/span.js";
import { buildCoreHandlers } from "../core/http-core.js";
import type { HttpOtelOptions, OtelHttpContext } from "../core/types.js";

export type { OtelHttpContext, HttpOtelOptions };

// ── Express Request 类型扩展 ───────────────────────────────────
declare module "express-serve-static-core" {
  interface Request {
    /**
     * 追踪任意操作（由 createExpressMiddleware 默认注入，框架可覆盖扩展）
     *
     * 两层机制：
     *   1. adapter 默认注入（保底）：直接使用 core withSpan
     *   2. 框架自定义注入（可选）：在后续中间件中覆盖 req.withSpan 实现扩展
     *
     * @example
     * const result = await req.withSpan("db.query", async (span) => {
     *   span.setAttribute("db.table", "users");
     *   return db.findUser(id);
     * });
     */
    withSpan: typeof withSpan;
  }
}

/**
 * 创建 Express 追踪中间件
 *
 * @param options 追踪选项（全部可选）
 * @returns Express `RequestHandler`（可直接传入 `app.use()`）
 *
 * @example
 * import { createExpressMiddleware } from "vextjs-opentelemetry/express";
 * app.use(createExpressMiddleware({ serviceName: "my-express-app" }));
 */
export function createExpressMiddleware(options: HttpOtelOptions = {}): RequestHandler {
  const handlers = buildCoreHandlers(options);

  return function otelExpressMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // 默认注入（保底）：框架可在后续中间件中覆盖 req.withSpan 实现扩展
    if (!req.withSpan) {
      req.withSpan = withSpan;
    }

    const requestId = req.headers["x-request-id"];
    const ctx: OtelHttpContext = {
      method: req.method,
      path: req.path,
      route: undefined, // 全局中间件阶段，route 尚未匹配
      requestId: Array.isArray(requestId) ? requestId[0] : requestId,
      headers: req.headers as Record<string, string | string[] | undefined>,
    };

    const state = handlers.onRequestStart(ctx);

    res.on("finish", () => {
      // finish 时路由已完成匹配，req.route?.path 可获取路由模板
      const finalCtx: OtelHttpContext = {
        ...ctx,
        route: req.route?.path ?? req.path,
      };
      handlers.onRequestEnd(state, finalCtx, res.statusCode);
    });

    res.on("error", (err: unknown) => {
      handlers.onRequestError(state, ctx, err);
    });

    next();
  };
}
