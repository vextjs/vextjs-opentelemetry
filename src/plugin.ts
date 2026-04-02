import { trace, metrics as otelMetrics } from "@opentelemetry/api";
import { definePlugin } from "vextjs";

import { createTracingMiddleware } from "./middleware.js";
import type { OpenTelemetryPluginOptions } from "./types.js";

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

      // ── 服务名称解析（优先级：env > options > config > 默认）──
      const serviceName =
        process.env.OTEL_SERVICE_NAME ??
        options.serviceName ??
        app.config.otel?.serviceName ??
        "vext-app";

      // ── 获取 Tracer / Meter ───────────────────────────────
      // SDK 未通过 --import 初始化时，getTracer()/getMeter() 返回 Noop 实现，
      // 所有 span/metric 操作为空操作，零 overhead，不抛错。
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

      // ── 挂载到 app.otel ───────────────────────────────────
      // 使用 app.extend() 将 otel 对象注入 app，
      // 之后可通过 req.app.otel 在 handler / service 层访问。
      app.extend("otel", { tracer, meter, metrics });

      // ── 注册全局追踪中间件 ────────────────────────────────
      // 注意：中间件在 app.use() 的注册顺序决定执行顺序。
      // opentelemetry 中间件应尽早注册，确保覆盖所有后续路由。
      app.use(createTracingMiddleware(metrics, options));

      app.logger.info(
        `[vextjs-opentelemetry] initialized (service: ${serviceName})`,
      );
    },

    async onClose(app) {
      // SDK 的 graceful shutdown 由 instrumentation.ts 的 SIGTERM handler 负责。
      // 此处记录一条日志，确保在 SDK flush 前最后的追踪信息可见。
      app.logger.info(
        "[vextjs-opentelemetry] plugin closing, flushing telemetry...",
      );
    },
  });
}
