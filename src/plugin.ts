import { trace, metrics as otelMetrics, SpanStatusCode } from "@opentelemetry/api";
import type { Span, SpanOptions } from "@opentelemetry/api";
import { definePlugin, defineMiddleware } from "vextjs";
import { createTracingMiddleware } from "./middleware.js";
import type { OpenTelemetryPluginOptions } from "./types.js";

/**
 * 创建绑定到指定 tracer 的 withSpan 辅助方法
 *
 * 可在任意 Node.js Web 框架中使用（不依赖 VextJS 插件系统）。
 * VextJS 用户优先通过 `app.otel.withSpan` 访问；
 * Egg.js / Koa / Express 用户在应用启动时调用此工厂，自行注入到 ctx 或 app。
 *
 * @param tracerName - Tracer 名称（通常与服务名一致，如 `'chat'`、`'payment'`）
 *
 * @example
 * // Egg.js：在中间件或 extend/context.ts 中注入
 * import { createWithSpan } from 'vextjs-opentelemetry';
 * export default { withSpan: createWithSpan('chat') };
 *
 * // 直接在 service 层使用
 * const withSpan = createWithSpan('payment');
 * const result = await withSpan('db.query', () => db.findUser(id));
 */
export function createWithSpan(tracerName: string) {
  const tracer = trace.getTracer(tracerName);
  return function withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions,
  ): Promise<T> {
    return tracer.startActiveSpan(name, options ?? {}, async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * 获取 OTel SDK 当前运行状态
 *
 * 与 `createWithSpan` 同理：数据逻辑与框架解耦，各框架自行决定注册路由路径。
 * VextJS 插件内部使用此函数驱动 `/_otel/status` 端点；
 * Egg.js / Koa / Express 可在路由中直接调用并返回结果。
 *
 * @param options.serviceName - 服务名称（`createWithSpan` / OTel SDK 初始化时传入的同一值）
 * @param options.endpoint    - OTLP 上报地址（`"none"` 表示不上报）
 *
 * @example
 * // Egg.js router
 * import { getOtelStatus } from 'vextjs-opentelemetry';
 * router.get('/_otel/status', async (ctx) => {
 *   ctx.body = getOtelStatus({ serviceName: 'chat' });
 * });
 *
 * // Koa / Express
 * app.get('/_otel/status', (req, res) => {
 *   res.json(getOtelStatus({ serviceName: 'my-service' }));
 * });
 */
export function getOtelStatus(options?: {
  serviceName?: string;
  endpoint?: string;
}): {
  sdk: "initialized" | "noop";
  serviceName: string;
  exportMode: string;
  endpoint: string;
  autoInstrumentation: boolean;
} {
  return {
    sdk: process.env.VEXT_OTEL_SDK_STARTED === "1" ? "initialized" : "noop",
    serviceName: options?.serviceName ?? "unknown",
    exportMode: process.env.VEXT_OTEL_EXPORT_MODE ?? "none",
    endpoint: options?.endpoint ?? "none",
    autoInstrumentation: process.env.VEXT_OTEL_AUTO_INSTRUMENTATION === "1",
  };
}



/**
 * opentelemetryPlugin — VextJS 官方 OpenTelemetry 插件
 *
 * 极简接入方式：
 * ```typescript
 * // src/plugins/otel.ts
 * import { opentelemetryPlugin } from "vextjs-opentelemetry";
 *
 * export default opentelemetryPlugin({
 *   serviceName: "my-app",
 * });
 * ```
 *
 * 功能：
 * - 通过 app.extend('otel', {...}) 挂载 tracer / meter / metrics 到 app
 * - 自动注册全局追踪中间件（Span 标注 + ALS 日志关联 + HTTP 指标统计）
 * - SDK 未初始化时以 Noop 模式运行，零 overhead，不抛错
 * - enabled: false 时完全跳过，no-op
 *
 * @param options - 插件配置（全部可选，内置合理默认值）
 */
export function opentelemetryPlugin(options: OpenTelemetryPluginOptions = {}) {
  return definePlugin({
    name: "opentelemetry",

    async setup(app) {
      // ── 快速退出：disabled 模式 ──────────────────────────
      if (options.enabled === false) {
        app.logger.debug(
          "[vextjs-opentelemetry] disabled via options, skipping setup",
        );
        return;
      }

      // 也支持通过 vext config.otel.enabled 控制
      if (app.config.otel?.enabled === false) {
        app.logger.debug(
          "[vextjs-opentelemetry] disabled via config.otel.enabled, skipping setup",
        );
        return;
      }

      // ── 服务名称解析（优先级：options > config > 默认）────────
      const serviceName =
        options.serviceName ??
        app.config.otel?.serviceName ??
        "vext-app";

      // ── OTLP 端点解析（仅从插件配置读取，不读取环境变量）────
      //
      // 优先级（高→低）：
      //   1. options.otlpEndpoint（插件工厂函数参数）
      //   2. app.config.otel?.endpoint（vext.config.ts 配置）
      //   3. "none"（默认，SDK 初始化但不导出数据）
      //
      const resolvedEndpoint =
        options.otlpEndpoint ?? app.config.otel?.endpoint ?? "none";

      // ── 获取 Tracer / Meter ───────────────────────────────
      const tracer = trace.getTracer(serviceName);
      const meter = otelMetrics.getMeter(serviceName);

      // ── 创建标准 HTTP 指标 ────────────────────────────────
      const durationBuckets = options.metrics?.durationBuckets ?? [
        5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
      ];

      const httpRequestDuration = meter.createHistogram(
        "http.server.duration",
        {
          description: "HTTP request duration in milliseconds",
          unit: "ms",
          advice: { explicitBucketBoundaries: durationBuckets },
        },
      );

      const httpRequestTotal = meter.createCounter(
        "http.server.request.total",
        {
          description: "Total number of HTTP requests",
        },
      );

      const httpActiveRequests = meter.createUpDownCounter(
        "http.server.active_requests",
        {
          description: "Number of active HTTP requests",
        },
      );

      const metrics = {
        httpRequestDuration,
        httpRequestTotal,
        httpActiveRequests,
      };

      // ── withSpan 辅助方法（生命周期自动管理）─────────────
      //
      // 使用 createWithSpan 工厂绑定服务名称 tracer，
      // 其他框架（Egg.js / Koa / Express）通过直接调用
      // createWithSpan(serviceName) 获得等价的独立函数。
      const withSpan = createWithSpan(serviceName);

      // ── 挂载到 app.otel ───────────────────────────────────
      app.extend("otel", { tracer, meter, metrics, withSpan });

      // ── 注册状态检查接口 ──────────────────────────────────
      //
      // 默认路径：GET /_otel/status
      // 在追踪中间件前注册，短路匹配后直接返回，不进入业务链路。
      //
      const statusEndpointPath =
        options.statusEndpoint === undefined
          ? "/_otel/status"
          : options.statusEndpoint;

      if (statusEndpointPath !== false) {
        // ── 注册为正式路由（通过 adapter.registerRoute）──────
        //
        // 🔴 修复：之前使用 app.use() 中间件拦截 /_otel/status，
        // 但 Native Adapter 的全局中间件仅对已匹配路由执行。
        // 未注册的路径直接走 handleNotFound（404），跳过中间件链。
        //
        // 改为 app.adapter.registerRoute() 注册为正式路由：
        //   - find-my-way 路由表中有此条目，请求能正确匹配
        //   - 全局中间件链（requestId/cors/body-parser 等）自动拼接
        //   - rawJson 绕过出口包装，返回原始 JSON
        //
        const statusHandler = defineMiddleware(async (_req, res, _next) => {
          // 使用 rawJson 绕过出口包装中间件，确保状态接口始终返回原始 JSON
          res.rawJson(
            getOtelStatus({ serviceName, endpoint: resolvedEndpoint }),
            200,
          );
        });

        app.adapter.registerRoute("GET", statusEndpointPath, [statusHandler]);
      }

      // ── 注册全局追踪中间件 ────────────────────────────────
      app.use(createTracingMiddleware(metrics, options));

      app.logger.info(
        `[vextjs-opentelemetry] initialized (service: ${serviceName})`,
      );
    },

    async onClose(app) {
      app.logger.info(
        "[vextjs-opentelemetry] plugin closing, flushing telemetry...",
      );
    },
  });
}
