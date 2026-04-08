// src/adapters/vextjs.ts
// VextJS 框架适配器（v1.0.0 重构）
//
// 整合了旧 plugin.ts + middleware.ts，不再依赖这两个旧文件。
//
// 用法：
//   import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs";
//   export default opentelemetryPlugin({ serviceName: "my-app" });

import { trace, metrics as otelMetrics, SpanStatusCode } from "@opentelemetry/api";
import type { Span, SpanOptions, Attributes } from "@opentelemetry/api";
import { definePlugin, defineMiddleware, requestContext } from "vextjs";
import type { VextRequest, VextApp, VextLogger } from "vextjs";

import { withSpan, getOtelStatus, getActiveTraceId, getOtelLogger } from "../core/span.js";
import { attachExporterToSdk } from "../core/sdk-config.js";
import { createOtelLogBridge } from "../log.js";
import type { OtelAppExtension, OtelMetrics, OnEndInfo, OtelStatus } from "../core/types.js";
import { DEFAULT_SERVICE_NAME } from "../core/types.js";

// ── VextJS 专属配置类型（依赖 VextRequest，不在 core/types 中）──

export interface OpenTelemetryPluginOptions {
  // ── 服务标识 ─────────────────────────────────────────────────
  serviceName?: string;

  // ── SDK 导出配置（instrumentation.ts 已启动 SDK，此处追加 exporter）────
  /**
   * 导出目标（驱动 SDK exporter 配置，无需在 package.json 声明 vext.otel）
   *
   * 支持的值：
   *   "none"           → 不导出（默认，SDK 已用 noop 启动）
   *   "file"           → 写入 <cwd>/otel-data/（traces.jsonl + metrics.jsonl + logs.jsonl）
   *   "./my-traces"    → 写入相对路径（file 模式）
   *   "/abs/path"      → 写入绝对路径（file 模式）
   *   "http://..."     → OTLP HTTP 上报（traces + metrics + logs）
   */
  endpoint?: string;
  /** 上报协议，默认 "http" */
  protocol?: "http" | "grpc";
  /** OTLP 请求头（endpoint 为 OTLP URL 时有效） */
  headers?: Record<string, string>;
  /**
   * gRPC 连接方式（protocol: "grpc" 时有效）
   *
   * - `true`（默认）：使用 node:http2 原生 h2c 明文连接
   *   适合内网 / 自建 Collector（Jaeger、K8s OTel Collector、Docker 等）
   *   ⚠️  @grpc/grpc-js 的 h2c 握手与部分自建 Collector 不兼容，故此模式绕开它
   *
   * - `false`：使用 @grpc/grpc-js TLS 加密连接
   *   适合公网 / 有证书的 Collector（Grafana Cloud、GCP Cloud Trace 等生产环境）
   */
  insecure?: boolean;
  /**
   * 自定义 Resource 属性（全局生效，注入到所有 span / metric / log）
   * 适合添加 pod.name / k8s.cluster / region 等环境标识
   * ⚠️  此配置仅在 instrumentation.ts 阶段（package.json vext.otel.resourceAttributes）生效；
   *     插件阶段 Resource 已固定，此字段仅用于文档说明 / 向后兼容
   */
  resourceAttributes?: Record<string, string | number | boolean>;

  // ── 状态检查接口 ──────────────────────────────────────────────
  /**
   * @deprecated 路由应由用户在应用代码中自行注册，适配器不再自动注册。
   * 请在路由文件中调用 app.otel.getStatus()：
   * @example
   * app.get("/_otel/status", (req, res) => res.json(req.app.otel!.getStatus()))
   */
  statusEndpoint?: never;

  // ── 全局开关 ──────────────────────────────────────────────────
  enabled?: boolean;

  // ── 请求完成回调 ──────────────────────────────────────────────
  onEnd?: (info: OnEndInfo) => void;

  // ── Tracing 配置 ──────────────────────────────────────────────
  tracing?: {
    enabled?: boolean;
    extraAttributes?:
      | Record<string, string | number | boolean>
      | ((req: VextRequest) => Record<string, string | number | boolean>);
    ignorePaths?: (string | RegExp)[];
    spanNameResolver?: (req: VextRequest) => string;
  };

  // ── Logs 配置 ─────────────────────────────────────────────────
  logs?: {
    /**
     * 全局静态属性（每条 log record 自动携带，无需每次手动传）
     *
     * 适合写入应用级别不变的字段，如 app.version / tenant.id / feature.flag。
     * 注意与 resourceAttributes 的区别：
     *   - resourceAttributes（package.json vext.otel）→ 基础设施级别，在 instrumentation.ts 写入
     *     SDK Resource，影响 traces + metrics + logs 三个 signal
     *   - logs.globalAttributes（此字段）→ 应用级别，仅附加到 Log signal 的每条记录
     *     通过 app.otel.logger 发出时自动合并
     */
    globalAttributes?: Attributes;

    /**
     * 是否将 app.logger（框架 pino logger）桥接到 OTel Logs SDK
     *
     * 启用后，每次调用 app.logger.info / warn / error / debug / fatal 都会
     * 同时向 OTel Logs SDK 发送一条 LogRecord，让框架日志自动上报到 collector。
     *
     * 结构化日志支持：
     *   app.logger.info({ "user.id": userId }, "user login")  → attributes + message
     *   app.logger.info("user login")                          → message only
     *   app.logger.error(err, "db timeout")                   → attributes: { "error.message": ... }
     *
     * 默认 true（endpoint 配置了有效目标时自动开启）
     */
    bridgeAppLogger?: boolean;
  };

  // ── Metrics 配置 ──────────────────────────────────────────────
  metrics?: {
    enabled?: boolean;
    durationBuckets?: number[];
    customLabels?:
      | Record<string, string | number | boolean>
      | ((req: VextRequest) => Record<string, string | number | boolean>);
  };
}

export type { OtelAppExtension, OtelMetrics };

// ── declare module 'vextjs'：类型自动扩展 ─────────────────────

declare module "vextjs" {
  interface VextApp {
    /** OpenTelemetry 集成对象（由 vextjs-opentelemetry 插件挂载） */
    otel?: OtelAppExtension;
  }
  interface VextRequest {
    /**
     * 追踪任意操作（由 opentelemetryPlugin 默认注入，框架可覆盖扩展）
     *
     * 两层机制：
     *   1. adapter 默认注入（保底）：直接使用 core withSpan，开箱即用
     *   2. 框架自定义注入（可选）：在自己的中间件/插件中覆盖，注入请求元数据等扩展逻辑
     *      只需在 opentelemetryPlugin 之后注册中间件，赋值 req.withSpan 即可覆盖
     *
     * @example
     * // 路由中直接使用（无需 import otel）
     * const result = await req.withSpan("db.getUser", async (span) => {
     *   span.setAttribute("user.id", id);
     *   return db.findUser(id);
     * });
     */
    withSpan: typeof withSpan;
  }
  interface VextConfig {
    otel?: {
      serviceName?: string;
      enabled?: boolean;
      endpoint?: string;
      headers?: Record<string, string>;
    };
  }
}

// ── 追踪中间件（导出供测试使用）────────────────────────────

export function createTracingMiddleware(metrics: OtelMetrics, options: OpenTelemetryPluginOptions) {
  const metricsEnabled = options.metrics?.enabled !== false;
  const tracingEnabled = options.tracing?.enabled !== false;
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const ignorePaths = options.tracing?.ignorePaths ?? [];

  function isIgnoredPath(urlPath: string): boolean {
    return ignorePaths.some((pattern: string | RegExp) =>
      typeof pattern === "string" ? pattern === urlPath : pattern.test(urlPath),
    );
  }

  const customLabelsFn = options.metrics?.customLabels;

  function resolveCustomLabels(req: VextRequest): Record<string, string | number | boolean> {
    if (!customLabelsFn) return {};
    try {
      return typeof customLabelsFn === "function" ? customLabelsFn(req) : customLabelsFn;
    } catch {
      console.warn("[vextjs-opentelemetry] customLabels function threw an error, using defaults");
      return {};
    }
  }

  return defineMiddleware(async (req, res, next) => {
    // 默认注入（保底）：框架未自定义注入时生效
    // 框架可在 opentelemetryPlugin 之后的中间件中覆盖 req.withSpan 实现扩展
    if (!req.withSpan) {
      req.withSpan = withSpan;
    }

    const startTime = performance.now();

    if (metricsEnabled) {
      metrics.httpActiveRequests.add(1, { "http.method": req.method });
    }

    const activeSpan = trace.getActiveSpan();
    const shouldTrace = tracingEnabled && !isIgnoredPath(req.path);

    if (shouldTrace && activeSpan?.isRecording()) {
      const extra =
        typeof options.tracing?.extraAttributes === "function"
          ? options.tracing.extraAttributes(req)
          : (options.tracing?.extraAttributes ?? {});

      activeSpan.setAttributes({
        "http.route": String(req.route ?? req.path),
        "http.request_id": req.requestId ?? "",
        "vext.service": serviceName,
        ...extra,
      });

      if (options.tracing?.spanNameResolver) {
        activeSpan.updateName(options.tracing.spanNameResolver(req));
      }

      // F-03 日志关联：写入 ALS store
      const store = requestContext.getStore();
      if (store) {
        const ctx = activeSpan.spanContext();
        // vextjs RequestContextStore 通过 any 扩展以支持 traceId/spanId 注入
        (store as unknown as Record<string, unknown>).traceId = ctx.traceId;
        (store as unknown as Record<string, unknown>).spanId = ctx.spanId;
      }
    }

    try {
      await next();

      const duration = Math.round(performance.now() - startTime);
      const statusCode = res.statusCode ?? 200;
      const route = String(req.route ?? req.path);

      if (metricsEnabled) {
        const labels = {
          "http.method": req.method,
          "http.status_code": statusCode,
          "http.route": route,
          ...resolveCustomLabels(req),
        };
        metrics.httpRequestTotal.add(1, labels);
        metrics.httpRequestDuration.record(duration, labels);
        metrics.httpActiveRequests.add(-1, { "http.method": req.method });
      }

      if (shouldTrace && activeSpan?.isRecording()) {
        activeSpan.setAttribute("http.status_code", statusCode);
        if (statusCode >= 400) {
          activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${statusCode}` });
        }
      }

      if (options.onEnd) {
        try {
          options.onEnd({
            traceId: activeSpan?.spanContext().traceId ?? "",
            method: req.method,
            route,
            latencyMs: duration,
            statusCode,
          } satisfies OnEndInfo);
        } catch (e) {
          console.warn("[vextjs-opentelemetry] onEnd callback threw:", (e as Error).message ?? e);
        }
      }
    } catch (err) {
      const duration = Math.round(performance.now() - startTime);
      const route = String(req.route ?? req.path);

      if (metricsEnabled) {
        const labels = {
          "http.method": req.method,
          "http.status_code": 500,
          "http.route": route,
          ...resolveCustomLabels(req),
        };
        metrics.httpRequestTotal.add(1, labels);
        metrics.httpRequestDuration.record(duration, labels);
        metrics.httpActiveRequests.add(-1, { "http.method": req.method });
      }

      if (shouldTrace && activeSpan?.isRecording()) {
        activeSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        activeSpan.recordException(err as Error);
      }

      if (options.onEnd) {
        try {
          options.onEnd({
            traceId: activeSpan?.spanContext().traceId ?? "",
            method: req.method,
            route,
            latencyMs: Math.round(performance.now() - startTime),
            statusCode: 500,
          } satisfies OnEndInfo);
        } catch (e) {
          console.warn("[vextjs-opentelemetry] onEnd callback threw:", (e as Error).message ?? e);
        }
      }

      throw err;
    }
  });
}

// ── app.logger → OTel bridge 代理 ─────────────────────────────

/**
 * 通过 app.setLogger() 将 app.logger 的每个日志方法包装为
 * "先 emit OTel LogRecord，再调用原方法"的代理。
 *
 * 支持 pino 的两种调用约定：
 *   logger.info("message")
 *   logger.info({ key: val }, "message")
 *   logger.error(errorObject, "message")
 */
function bridgeAppLoggerToOtel(
  app: VextApp,
  bridge: ReturnType<typeof createOtelLogBridge>,
): void {
  app.setLogger((original) => {
    function makeProxy(level: string) {
      return function (...args: unknown[]): void {
        let msg = "";
        let attrs: Attributes | undefined;

        if (typeof args[0] === "string") {
          msg = args[0];
        } else if (args[0] instanceof Error) {
          msg = typeof args[1] === "string" ? args[1] : args[0].message;
          attrs = {
            "error.type": args[0].name,
            "error.message": args[0].message,
            ...(args[0].stack ? { "error.stack": args[0].stack } : {}),
          };
        } else if (typeof args[0] === "object" && args[0] !== null) {
          msg = typeof args[1] === "string" ? args[1] : "";
          const raw = args[0] as Record<string, unknown>;
          const filtered: Attributes = {};
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              filtered[k] = v;
            }
          }
          if (Object.keys(filtered).length > 0) attrs = filtered;
        }

        if (msg) bridge.emit(level, msg, attrs);

        (original[level as keyof VextLogger] as (...a: unknown[]) => void)(...args);
      };
    }

    return {
      info: makeProxy("info") as VextLogger["info"],
      warn: makeProxy("warn") as VextLogger["warn"],
      error: makeProxy("error") as VextLogger["error"],
      debug: makeProxy("debug") as VextLogger["debug"],
      fatal: makeProxy("fatal") as VextLogger["fatal"],
      // child logger 不自动桥接（避免子 logger 重复上报）
      child: (bindings) => original.child(bindings),
    };
  });
}

// ── 插件工厂 ─────────────────────────────────────────────────

/**
 * opentelemetryPlugin — VextJS 官方 OpenTelemetry 插件
 *
 * @example
 * // src/plugins/otel.ts
 * import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs";
 * export default opentelemetryPlugin({ serviceName: "my-app" });
 */
export function opentelemetryPlugin(options: OpenTelemetryPluginOptions = {}) {
  return definePlugin({
    name: "opentelemetry",

    async setup(app) {
      if (options.enabled === false || app.config.otel?.enabled === false) {
        app.logger.debug("[vextjs-opentelemetry] disabled, skipping setup");
        return;
      }

      const serviceName =
        options.serviceName ?? app.config.otel?.serviceName ?? DEFAULT_SERVICE_NAME;

      // ── SDK Exporter 配置（向已启动的 SDK 追加 exporter）────────
      const endpoint = options.endpoint ?? app.config.otel?.endpoint ?? "none";
      if (endpoint !== "none") {
        await attachExporterToSdk({
          endpoint,
          protocol: options.protocol ?? "http",
          headers: options.headers,
          insecure: options.insecure,
          serviceName,
        });
      } else {
        // endpoint 为 "none"，仅更新 serviceName 显示
        process.env.OTEL_SERVICE_NAME = serviceName;
        process.env.VEXT_OTEL_SERVICE_NAME = serviceName;
      }

      const tracer = trace.getTracer(serviceName);
      const meter = otelMetrics.getMeter(serviceName);

      const durationBuckets = options.metrics?.durationBuckets ?? [
        5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
      ];

      const httpRequestDuration = meter.createHistogram("http.server.duration", {
        description: "HTTP request duration in milliseconds",
        unit: "ms",
        advice: { explicitBucketBoundaries: durationBuckets },
      });
      const httpRequestTotal = meter.createCounter("http.server.request.total", {
        description: "Total number of HTTP requests",
      });
      const httpActiveRequests = meter.createUpDownCounter("http.server.active_requests", {
        description: "Number of active HTTP requests",
      });

      const metrics: OtelMetrics = { httpRequestDuration, httpRequestTotal, httpActiveRequests };

      // withSpan 绑定当前服务 tracer
      const boundWithSpan: OtelAppExtension["withSpan"] = (name, fn, spanOptions) =>
        withSpan(name, fn, { tracerName: serviceName, ...spanOptions });

      // logger — 预配置 globalAttributes 的 Log bridge
      const logger = createOtelLogBridge(
        () => getOtelLogger(serviceName),
        { globalAttributes: options.logs?.globalAttributes },
      );

      const otelExtension: OtelAppExtension = {
        tracer,
        meter,
        metrics,
        logger,
        withSpan: boundWithSpan,
        getTraceId: getActiveTraceId,
        getStatus: getOtelStatus,
      };
      app.extend("otel", otelExtension);

      // 桥接 app.logger → OTel Logs（默认开启，可通过 logs.bridgeAppLogger: false 关闭）
      const shouldBridge = options.logs?.bridgeAppLogger !== false && endpoint !== "none";
      if (shouldBridge) {
        bridgeAppLoggerToOtel(app, logger);
      }

      // 全局追踪中间件
      app.use(createTracingMiddleware(metrics, options));

      app.logger.info(`[vextjs-opentelemetry] initialized (service: ${serviceName})`);
    },

    async onClose(app) {
      app.logger.info("[vextjs-opentelemetry] plugin closing, flushing telemetry...");
    },
  });
}
