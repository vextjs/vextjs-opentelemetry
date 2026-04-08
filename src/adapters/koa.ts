// src/adapters/koa.ts
// Koa 框架适配器（v1.0.0 重构）
//
// 用法（Koa）：
//   import { createKoaMiddleware } from "vextjs-opentelemetry/koa";
//   app.use(createKoaMiddleware({ serviceName: "my-app" }));
//
// 用法（Egg.js）：
//   import { createKoaMiddleware } from "vextjs-opentelemetry/koa";
//   export default (_opts, _app) => createKoaMiddleware({ serviceName: "user" });
//
//   推荐使用专属适配器：
//   import { defineEggMiddleware } from "vextjs-opentelemetry/egg";
//   export default defineEggMiddleware({ serviceName: "user" });

import { trace, SpanKind } from "@opentelemetry/api";
import type { Middleware, Context, Next } from "koa";
import { createRequire } from "node:module";

import { withSpan } from "../core/span.js";
import { buildCoreHandlers } from "../core/http-core.js";
import type { HttpOtelOptions, OtelHttpContext } from "../core/types.js";

export type { OtelHttpContext, HttpOtelOptions };

// ── Koa Context 类型扩展 ───────────────────────────────────────
declare module "koa" {
  interface DefaultContext {
    /**
     * 追踪任意操作（由 createKoaMiddleware 默认注入，框架可覆盖扩展）
     *
     * 两层机制：
     *   1. adapter 默认注入（保底）：直接使用 core withSpan
     *   2. 框架自定义注入（可选）：在后续中间件中覆盖 ctx.withSpan 实现扩展
     *
     * @example
     * const result = await ctx.withSpan("db.query", async (span) => {
     *   span.setAttribute("db.table", "users");
     *   return db.findUser(id);
     * });
     */
    withSpan: typeof withSpan;
  }
}

/**
 * 创建 Koa 追踪中间件（同时适用于 Egg.js）
 *
 * @param options 追踪选项（全部可选）
 * @returns Koa Middleware
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
        // 默认注入（保底）：框架可在后续中间件中覆盖 ctx.withSpan 实现扩展
        if (!ctx.withSpan) {
            ctx.withSpan = withSpan;
        }

        const requestId = ctx.get("x-request-id") || undefined;
        const otelCtx: OtelHttpContext = {
            method: ctx.method,
            path: ctx.path,
            route: undefined, // 路由匹配在 await next() 之后完成
            requestId,
            headers: ctx.headers as Record<string, string | string[] | undefined>,
            requestSize: ctx.request?.length,
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
                    responseSize: ctx.length,
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
                    const finalCtx: OtelHttpContext = { ...otelCtx, route: routerPath, responseSize: ctx.length };
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

// ── initOtel（CJS --require 场景：Koa / Egg.js）─────────────────
//
// 端点判断规则（与 vextjs 适配器一致）：
//   "host:port"          → gRPC h2c（内网/自建 Collector，如 Jaeger、K8s OTel Collector）
//   "http://host:port"   → OTLP HTTP
//   "none" / 不传        → 不上报（仅本地 SDK，适合测试）
//
// 用法（otel-init.cjs）：
//   const { initOtel } = require('vextjs-opentelemetry/koa');
//   const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
//   initOtel({
//     serviceName: 'my-app',
//     endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || '47.89.182.109:32767',
//     instrumentations: [new HttpInstrumentation(), ...],
//   });

import type { Instrumentation, InstrumentationConfig } from "@opentelemetry/instrumentation";

export interface InitOtelOptions {
  /** 服务名，写入 Resource service.name */
  serviceName: string;
  /**
   * 上报地址（判断规则与 vextjs 适配器一致）：
   *   - "host:port"          → gRPC h2c（适合内网/自建 Collector）
   *   - "http://host:port"   → OTLP HTTP
   *   - "none" / 不传        → 不上报
   */
  endpoint?: string;
  /** OTLP 请求头 */
  headers?: Record<string, string>;
  /** 自定义 instrumentation 列表（HTTP/DB/Redis 等自动追踪） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instrumentations?: Instrumentation<InstrumentationConfig>[];
  /** Metrics 上报间隔（ms），默认 15000 */
  metricIntervalMs?: number;
}

/**
 * 一行完成 OTel SDK + Exporter 初始化（CJS --require 场景）
 *
 * 适合 Egg.js / Koa 的 otel-init.cjs，通过 --require 预加载。
 */
export function initOtel(options: InitOtelOptions): void {
  const {
    serviceName,
    endpoint = "none",
    headers,
    instrumentations = [],
    metricIntervalMs = 15000,
  } = options;

  // 使用 createRequire（ESM 文件中 require 未定义；CJS bundle 中 import.meta.url 为 undefined，用 __filename fallback）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = createRequire(
    typeof __filename !== "undefined" ? __filename : import.meta.url,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as (mod: string) => any;

  try {
    const { NodeSDK } = r("@opentelemetry/sdk-node");
    const { PeriodicExportingMetricReader } = r("@opentelemetry/sdk-metrics");
    const { BatchSpanProcessor } = r("@opentelemetry/sdk-trace-base");
    const { BatchLogRecordProcessor, LoggerProvider } = r("@opentelemetry/sdk-logs");
    const { logs: otelLogs } = r("@opentelemetry/api-logs");
    const { resourceFromAttributes } = r("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = r("@opentelemetry/semantic-conventions");

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
      "deployment.environment": process.env.NODE_ENV ?? "development",
    });

    const isNone = !endpoint || endpoint === "none";
    // 没有 http:// 前缀 → gRPC；有 http:// → HTTP（与 vextjs 适配器判断逻辑一致）
    const isGrpc = !isNone && !endpoint.startsWith("http");
    const grpcHost = isGrpc ? endpoint.replace(/^(grpc|http|https):\/\//, "").replace(/\/$/, "") : "";
    const httpBase = !isNone && !isGrpc ? endpoint : "";

    // ── 构建 span/metric/log 处理器 ───────────────────────────────
    let spanProcessors: unknown[] = [];
    let metricExporter: unknown = null;
    let logProcessor: unknown = null;

    if (!isNone) {
      if (isGrpc) {
        // gRPC h2c（node:http2，兼容自建 Jaeger / K8s OTel Collector）
        const http2 = r("node:http2");
        const { ProtobufTraceSerializer, ProtobufMetricsSerializer, ProtobufLogsSerializer } =
          r("@opentelemetry/otlp-transformer");
        const { ExportResultCode } = r("@opentelemetry/core");
        const { AggregationTemporality } = r("@opentelemetry/sdk-metrics");

        const TRACE_PATH = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";
        const METRIC_PATH = "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";
        const LOG_PATH = "/opentelemetry.proto.collector.logs.v1.LogsService/Export";
        const authority = `http://${grpcHost}`;

        function makeSessionFactory(url: string) {
          let session: ReturnType<typeof http2.connect> | null = null;
          return () => {
            if (!session || session.destroyed) {
              session = http2.connect(url);
              session.on("error", () => {});
            }
            return session;
          };
        }

        function makeGrpcExporter(path: string, serialize: (data: unknown) => Uint8Array, getSession: () => ReturnType<typeof http2.connect>) {
          return {
            export(data: unknown, resultCallback: (result: { code: number }) => void) {
              try {
                const body = serialize(data);
                const req = getSession().request({
                  ":method": "POST",
                  ":path": path,
                  "content-type": "application/grpc+proto",
                  "te": "trailers",
                  ...headers,
                });
                // gRPC framing: 1 byte flag (0=no compress) + 4 byte big-endian length
                const frame = Buffer.allocUnsafe(5 + body.length);
                frame[0] = 0;
                frame.writeUInt32BE(body.length, 1);
                body.forEach((b: number, i: number) => { frame[5 + i] = b; });
                req.end(frame);
                req.on("response", () => { req.resume(); });
                req.on("end", () => resultCallback({ code: ExportResultCode.SUCCESS }));
                req.on("error", () => resultCallback({ code: ExportResultCode.FAILED }));
              } catch {
                resultCallback({ code: ExportResultCode.FAILED });
              }
            },
            shutdown() { return Promise.resolve(); },
            forceFlush() { return Promise.resolve(); },
            selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; },
          };
        }

        const traceSession = makeSessionFactory(authority);
        const metricSession = makeSessionFactory(authority);
        const logSession = makeSessionFactory(authority);

        spanProcessors = [
          new BatchSpanProcessor(makeGrpcExporter(TRACE_PATH, (d) => ProtobufTraceSerializer.serializeRequest(d as never), traceSession)),
        ];
        metricExporter = makeGrpcExporter(METRIC_PATH, (d) => ProtobufMetricsSerializer.serializeRequest(d as never), metricSession);
        logProcessor = new BatchLogRecordProcessor(
          makeGrpcExporter(LOG_PATH, (d) => ProtobufLogsSerializer.serializeRequest(d as never), logSession),
        );
      } else {
        // OTLP HTTP
        const { OTLPTraceExporter } = r("@opentelemetry/exporter-trace-otlp-http");
        const { OTLPMetricExporter } = r("@opentelemetry/exporter-metrics-otlp-http");
        const { OTLPLogExporter } = r("@opentelemetry/exporter-logs-otlp-http");

        spanProcessors = [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${httpBase}/v1/traces`, headers }))];
        metricExporter = new OTLPMetricExporter({ url: `${httpBase}/v1/metrics`, headers });
        logProcessor = new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${httpBase}/v1/logs`, headers }));
      }
    }

    const loggerProvider = new LoggerProvider({
      resource,
      processors: logProcessor ? [logProcessor] : [],
    });
    otelLogs.setGlobalLoggerProvider(loggerProvider);
    (globalThis as Record<string, unknown>)._otelLogger = loggerProvider.getLogger(serviceName);

    const sdk = new NodeSDK({
      resource,
      ...(spanProcessors.length ? { spanProcessors } : {}),
      ...(metricExporter ? {
        metricReaders: [new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: metricIntervalMs,
        })],
      } : {}),
      instrumentations,
    });

    sdk.start();
    process.env.OTEL_SERVICE_NAME = serviceName;
    process.env.VEXT_OTEL_SDK_STARTED = "1";
    if (!isNone) {
      process.env.VEXT_OTEL_EXPORT_MODE = isGrpc ? "otlp-grpc" : "otlp-http";
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = isGrpc ? grpcHost : httpBase;
    }

    process.on("SIGTERM", () => {
      void Promise.all([sdk.shutdown(), loggerProvider.shutdown()])
        .then(() => console.log("[vextjs-opentelemetry] shutdown complete"))
        .catch((err: Error) => console.error("[vextjs-opentelemetry] shutdown error:", err.message));
    });
  } catch (err) {
    console.warn("[vextjs-opentelemetry/koa] initOtel failed:", (err as Error).message);
  }
}
