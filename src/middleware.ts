import { trace, SpanStatusCode } from "@opentelemetry/api";
import { defineMiddleware, requestContext } from "vextjs";
import type { VextRequest } from "vextjs";

import type { OtelMetrics, OpenTelemetryPluginOptions } from "./types.js";

/**
 * 创建 HTTP 追踪中间件
 *
 * 承担三项职责：
 * 1. 标注 active Span 属性（利用自动检测已创建的 active span）
 * 2. 将 traceId/spanId 写入 ALS store → 触发 vext logger 内置 mixin 自动注入日志
 * 3. 统计标准 HTTP 指标（duration / total / active_requests）
 *
 * @param metrics - 由 opentelemetryPlugin 创建的标准 HTTP 指标集合
 * @param options - 插件配置选项
 */
export function createTracingMiddleware(
  metrics: OtelMetrics,
  options: OpenTelemetryPluginOptions,
) {
  const metricsEnabled = options.metrics?.enabled !== false;
  const tracingEnabled = options.tracing?.enabled !== false;
  const serviceName = options.serviceName ?? "vext-app";

  // ── 闭包顶部解析 customLabels（一次解析，多次复用）────
  const customLabelsFn = options.metrics?.customLabels;

  /**
   * resolveCustomLabels — 解析本次请求的自定义业务标签
   *
   * 支持静态对象和函数两种形式，try/catch 保护：
   * 自定义函数抛错时降级为空对象，基础指标不受影响。
   */
  function resolveCustomLabels(
    req: VextRequest,
  ): Record<string, string | number | boolean> {
    if (!customLabelsFn) return {};
    try {
      return typeof customLabelsFn === "function"
        ? customLabelsFn(req)
        : customLabelsFn;
    } catch {
      console.warn(
        "[vextjs-opentelemetry] customLabels function threw an error, using defaults",
      );
      return {};
    }
  }

  return defineMiddleware(async (req, res, next) => {
    const startTime = performance.now();

    // ── 指标：活跃请求 +1 ──────────────────────────────────
    if (metricsEnabled) {
      metrics.httpActiveRequests.add(1, { "http.method": req.method });
    }

    // ── 追踪：标注 active span（由自动检测创建）─────────────
    // getActiveSpan() 在 SDK 未初始化时返回 undefined（Noop），
    // isRecording() 为 false，所有追踪操作静默跳过，零 overhead。
    const activeSpan = trace.getActiveSpan();

    if (tracingEnabled && activeSpan?.isRecording()) {
      // 解析额外属性（支持函数和对象两种形式）
      const extra =
        typeof options.tracing?.extraAttributes === "function"
          ? options.tracing.extraAttributes(req)
          : (options.tracing?.extraAttributes ?? {});

      activeSpan.setAttributes({
        "http.route": req.route ?? req.path,
        "http.request_id": req.requestId ?? "",
        "vext.service": serviceName,
        ...extra,
      });

      // ── F-03 日志关联：写入 ALS store ────────────────────
      // vext logger 内置 mixin 自动读取 store.traceId / store.spanId，
      // 将 trace_id / span_id 注入该请求生命周期内的所有日志。
      // 无需修改 app.config.logger.mixin（该对象已 deepFrozen）。
      const store = requestContext.getStore();
      if (store) {
        const ctx = activeSpan.spanContext();
        store.traceId = ctx.traceId;
        store.spanId = ctx.spanId;
      }
    }

    try {
      await next();

      const duration = Math.round(performance.now() - startTime);
      const statusCode = res.statusCode ?? 200;

      // ── 指标：请求完成统计 ─────────────────────────────────
      if (metricsEnabled) {
        const labels = {
          "http.method": req.method,
          "http.status_code": statusCode,
          "http.route": req.route ?? req.path,
          ...resolveCustomLabels(req),
        };
        metrics.httpRequestTotal.add(1, labels);
        metrics.httpRequestDuration.record(duration, labels);
        metrics.httpActiveRequests.add(-1, { "http.method": req.method });
      }

      // ── 追踪：设置 Span 最终状态 ───────────────────────────
      if (tracingEnabled && activeSpan?.isRecording()) {
        activeSpan.setAttribute("http.status_code", statusCode);
        if (statusCode >= 400) {
          activeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${statusCode}`,
          });
        }
      }
    } catch (err) {
      const duration = Math.round(performance.now() - startTime);

      // ── 指标：异常请求统计（以 500 计）────────────────────
      if (metricsEnabled) {
        const labels = {
          "http.method": req.method,
          "http.status_code": 500,
          "http.route": req.route ?? req.path,
          ...resolveCustomLabels(req),
        };
        metrics.httpRequestTotal.add(1, labels);
        metrics.httpRequestDuration.record(duration, labels);
        metrics.httpActiveRequests.add(-1, { "http.method": req.method });
      }

      // ── 追踪：记录异常 + 设置 ERROR 状态 ──────────────────
      if (tracingEnabled && activeSpan?.isRecording()) {
        activeSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        activeSpan.recordException(err as Error);
      }

      // 重新抛出，由框架的全局错误处理器处理
      throw err;
    }
  });
}
