// src/adapters/koa.ts
// Koa 框架适配器（同时兼容 Egg.js）
//
// 用法（Koa）：
//   import { createKoaMiddleware } from "vextjs-opentelemetry/koa";
//   app.use(createKoaMiddleware({ serviceName: "my-app" }));
//
// 用法（Egg.js）：
//   // app/middleware/otel.ts
//   import { createKoaMiddleware } from "vextjs-opentelemetry/koa";
//   import type { Application } from "egg";
//   export default (_options: unknown, _app: Application) =>
//     createKoaMiddleware({ serviceName: "my-app" });
//
//   // config/config.default.ts → middleware: ["otel"]
//
// Egg.js 中间件签名与 Koa 完全相同（async (ctx, next) => {}），
// 无需专属适配器。

import { trace, SpanKind } from "@opentelemetry/api";
import type { Middleware, Context, Next } from "koa";

import { buildCoreHandlers } from "../core.js";
import type { HttpOtelOptions, OtelHttpContext } from "../types.js";

export { OtelHttpContext, HttpOtelOptions };

/**
 * 创建 Koa 追踪中间件（同时适用于 Egg.js）
 *
 * 行为：
 *  - 若存在 active span（来自 HTTP auto-instrumentation），直接标注该 span
 *  - 若无 active span（手动 SDK 初始化场景，如 Egg.js `--require`），自动创建 SERVER span
 *
 * @param options 追踪选项（全部可选）
 * @returns Koa `Middleware`（可直接传入 `app.use()`）
 *
 * @example
 * import { createKoaMiddleware } from "vextjs-opentelemetry/koa";
 * app.use(createKoaMiddleware({ serviceName: "my-koa-app" }));
 */
export function createKoaMiddleware(options: HttpOtelOptions = {}): Middleware {
    const handlers = buildCoreHandlers(options);
    const serviceName = options.serviceName ?? "http-app";
    const tracingEnabled = options.tracing?.enabled !== false;
    const ignorePaths: (string | RegExp)[] = options.tracing?.ignorePaths ?? [];
    const spanResolver = options.tracing?.spanNameResolver;

    function isIgnoredPath(path: string): boolean {
        return ignorePaths.some((p) =>
            typeof p === "string" ? p === path : p.test(path),
        );
    }

    return async function otelKoaMiddleware(ctx: Context, next: Next): Promise<void> {
        const requestId = ctx.get("x-request-id") || undefined;
        const otelCtx: OtelHttpContext = {
            method: ctx.method,
            path: ctx.path,
            route: undefined, // 路由匹配在 await next() 之后完成
            requestId,
            headers: ctx.headers as Record<string, string | string[] | undefined>,
        };

        // ── 已有 active span（HTTP auto-instrumentation 已创建），或追踪关闭 ──
        // 直接使用原有行为：读取 + 标注已有 span，不重复创建。
        if (trace.getActiveSpan() || !tracingEnabled || isIgnoredPath(ctx.path)) {
            const state = handlers.onRequestStart(otelCtx);
            try {
                await next();
                const finalCtx: OtelHttpContext = {
                    ...otelCtx,
                    route: (ctx as Context & { routerPath?: string }).routerPath ?? ctx.path,
                };
                handlers.onRequestEnd(state, finalCtx, ctx.status ?? 200);
            } catch (err) {
                handlers.onRequestError(state, otelCtx, err);
                throw err;
            }
            return;
        }

        // ── 无 active span：为此 HTTP 请求主动创建 SERVER span ──────────────
        // 适用场景：Egg.js / Koa 手动 SDK 初始化（--require CJS 文件），
        // 未注册 @opentelemetry/instrumentation-http。
        const tracer = trace.getTracer(serviceName);
        const initialName = spanResolver
            ? spanResolver(otelCtx)
            : `${ctx.method} ${ctx.path}`;

        return tracer.startActiveSpan(
            initialName,
            { kind: SpanKind.SERVER },
            async (span) => {
                const state = handlers.onRequestStart(otelCtx);
                try {
                    await next();

                    const routerPath =
                        (ctx as Context & { routerPath?: string }).routerPath ?? ctx.path;
                    const finalCtx: OtelHttpContext = { ...otelCtx, route: routerPath };
                    // 路由匹配完成后，用正确的路由模板更新 span 名
                    const finalName = spanResolver
                        ? spanResolver(finalCtx)
                        : `${ctx.method} ${routerPath}`;
                    if (finalName !== initialName) {
                        span.updateName(finalName);
                    }
                    handlers.onRequestEnd(state, finalCtx, ctx.status ?? 200);
                } catch (err) {
                    handlers.onRequestError(state, otelCtx, err);
                    throw err;
                }
            },
        );
    };
}

