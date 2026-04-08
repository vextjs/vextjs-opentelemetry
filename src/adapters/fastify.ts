// src/adapters/fastify.ts
// Fastify 框架适配器
//
// 用法：
//   import { createFastifyPlugin } from "vextjs-opentelemetry/fastify";
//   await fastify.register(createFastifyPlugin({ serviceName: "my-app" }));
//
// 实现方式：
//   Fastify 无 Promise-based 中间件机制，使用三个生命周期 Hook：
//   - onRequest：请求开始，初始化 CoreRequestState
//   - onResponse：请求成功结束，记录指标和 Span 属性
//   - onError：请求异常结束，标记 Span ERROR 状态

import type {
    FastifyPluginAsync,
    FastifyRequest,
    FastifyReply,
} from "fastify";

import { withSpan } from "../core/span.js";
import { buildCoreHandlers } from "../core/http-core.js";
import type { HttpOtelOptions, OtelHttpContext } from "../core/types.js";
import type { CoreRequestState } from "../core/http-core.js";

export type { OtelHttpContext, HttpOtelOptions };

// ── Fastify Request 类型扩展 ───────────────────────────────────
declare module "fastify" {
    interface FastifyRequest {
        _otelState?: CoreRequestState;
        /**
         * 追踪任意操作（由 createFastifyPlugin 默认注入，框架可覆盖扩展）
         *
         * 两层机制：
         *   1. adapter 默认注入（保底）：decorateRequest 初始化，onRequest 赋值
         *   2. 框架自定义注入（可选）：在后续 onRequest hook 中覆盖 request.withSpan
         *
         * @example
         * const result = await request.withSpan("db.query", async (span) => {
         *   span.setAttribute("db.table", "users");
         *   return db.findUser(id);
         * });
         */
        withSpan: typeof withSpan;
    }
}

/**
 * 创建 Fastify 追踪插件
 *
 * 注册三个生命周期 Hook（onRequest / onResponse / onError），
 * 完成 Span 标注与 HTTP 指标记录。
 *
 * @param options 追踪选项（全部可选）
 * @returns Fastify 插件（`FastifyPluginAsync`）
 *
 * @example
 * import { createFastifyPlugin } from "vextjs-opentelemetry/fastify";
 * await fastify.register(createFastifyPlugin({ serviceName: "my-fastify-app" }));
 */
export function createFastifyPlugin(options: HttpOtelOptions = {}): FastifyPluginAsync {
  const handlers = buildCoreHandlers(options);

  const otelFastifyPlugin = async function (fastify: Parameters<FastifyPluginAsync>[0]) {
    // 在 request 对象上声明 _otelState 存储槽
    fastify.decorateRequest("_otelState", undefined);
    fastify.decorateRequest("withSpan", withSpan);

    // ── Hook 1: onRequest — 请求开始 ──────────────────────
    fastify.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
      // 默认注入（保底）：框架可在后续 onRequest hook 中覆盖 request.withSpan 实现扩展
      if (!request.withSpan) {
        request.withSpan = withSpan;
      }
      const requestId = request.headers["x-request-id"];
      const ctx: OtelHttpContext = {
        method: request.method,
        path: request.url.split("?")[0] ?? request.url,
        route: undefined,
        requestId: Array.isArray(requestId) ? requestId[0] : requestId,
        headers: request.headers as Record<string, string | string[] | undefined>,
      };
      request._otelState = handlers.onRequestStart(ctx);
    });

    // ── Hook 2: onResponse — 请求成功结束 ─────────────────
    fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request._otelState) return;
      const basePath = request.url.split("?")[0] ?? request.url;
      const requestId = request.headers["x-request-id"];
      // routeOptions.url 是 Fastify v5 API；v4 中使用 routerPath
      const routeTemplate =
        request.routeOptions?.url ??
        (request as unknown as { routerPath?: string }).routerPath ??
        basePath;
      const finalCtx: OtelHttpContext = {
        method: request.method,
        path: basePath,
        route: routeTemplate,
        requestId: Array.isArray(requestId) ? requestId[0] : requestId,
        headers: request.headers as Record<string, string | string[] | undefined>,
      };
      handlers.onRequestEnd(request._otelState, finalCtx, reply.statusCode);
    });

    // ── Hook 3: onError — 请求异常结束 ────────────────────
    fastify.addHook("onError", async (request: FastifyRequest, _reply: FastifyReply, error: Error) => {
      if (!request._otelState) return;
      const basePath = request.url.split("?")[0] ?? request.url;
      const requestId = request.headers["x-request-id"];
      const routeTemplate =
        request.routeOptions?.url ??
        (request as unknown as { routerPath?: string }).routerPath ??
        basePath;
      const ctx: OtelHttpContext = {
        method: request.method,
        path: basePath,
        route: routeTemplate,
        requestId: Array.isArray(requestId) ? requestId[0] : requestId,
        headers: request.headers as Record<string, string | string[] | undefined>,
      };
      handlers.onRequestError(request._otelState, ctx, error);
    });
  };

  // Symbol.for('skip-override') 告知 Fastify 不为本插件创建新的封装作用域，
  // 使 decorateRequest 和 addHook 的效果对所有父级路由也生效
  // （等效于 fastify-plugin，无需引入额外依赖）
  (otelFastifyPlugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;

  return otelFastifyPlugin as FastifyPluginAsync;
}
