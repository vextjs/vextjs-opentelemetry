// src/core/http-core.ts
// 框架无关的 HTTP 追踪核心处理器（v1.0.0 重构）
//
// 职责：
//   为各框架适配器提供统一的三阶段钩子（onRequestStart / onRequestEnd / onRequestError），
//   完成 Span 标注、HTTP 指标记录等框架无关逻辑。
//
// 约束：
//   - 仅 import @opentelemetry/api，不 import 任何 SDK 包
//   - 适配器中禁止执行 SDK 初始化

import { trace, metrics as otelMetrics, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { OtelHttpContext, HttpOtelOptions, OnEndInfo } from "./types.js";

// ── 内置默认分桶（毫秒）──────────────────────────────────────

const DEFAULT_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// 请求/响应体大小分桶（字节）：100B / 1KB / 10KB / 100KB / 1MB / 10MB
const DEFAULT_SIZE_BUCKETS = [100, 1_024, 10_240, 102_400, 1_048_576, 10_485_760];

// ── 指标名称（遵循 OTEL 语义约定）──────────────────────────

const METRIC_DURATION  = "http.server.duration";
const METRIC_TOTAL     = "http.server.request.total";
const METRIC_ACTIVE    = "http.server.active_requests";
const METRIC_REQ_SIZE  = "http.server.request.size";
const METRIC_RESP_SIZE = "http.server.response.size";

// ── 公开类型 ─────────────────────────────────────────────────

/**
 * onRequestStart 返回的请求状态快照，跨调用传递
 *
 * - startTime：performance.now() 时间戳
 * - shouldTrace：是否进行 Span 标注（ignorePaths 已过滤）
 * - activeSpan：在 onRequestStart 时捕获的 Span 引用；
 *   后续直接引用而非重新调用 trace.getActiveSpan()，
 *   避免 Express res.on('finish') 等回调中 Context 已变更的问题
 */
export interface CoreRequestState {
  readonly startTime: number;
  readonly shouldTrace: boolean;
  readonly shouldMetric: boolean;
  readonly activeSpan: Span | undefined;
}

/** buildCoreHandlers 返回的三阶段处理器 */
export interface CoreHandlers {
  /**
   * 请求开始阶段
   * - 获取当前活跃 Span 并存入 state
   * - 检查 ignorePaths；shouldTrace=false 时后续 Span 操作跳过
   * - 调用 extraAttributes（route 可能为 undefined）
   * - 活跃请求数 +1
   */
  onRequestStart(ctx: OtelHttpContext): CoreRequestState;

  /**
   * 请求成功结束阶段（await next() 或 res.on('finish') 之后）
   * - 更新 http.route、http.status_code
   * - 调用 spanNameResolver（ctx.route 应已由适配器填充）
   * - 设置 Span status（4xx/5xx → ERROR）
   * - 记录 httpRequestDuration / httpRequestTotal
   * - 活跃请求数 -1
   */
  onRequestEnd(state: CoreRequestState, ctx: OtelHttpContext, statusCode: number): void;

  /**
   * 请求异常阶段（未捕获异常）
   * - recordException + setStatus(ERROR)
   * - 以 statusCode=500 记录指标
   * - 活跃请求数 -1
   */
  onRequestError(state: CoreRequestState, ctx: OtelHttpContext, err: unknown): void;
}

// ── 工厂函数 ─────────────────────────────────────────────────

/**
 * 构建框架无关的 HTTP 追踪处理器
 *
 * 每次调用适配器工厂函数时调用一次，内部自动创建 Meter + 指标对象。
 *
 * @param options 通用追踪选项（HttpOtelOptions）
 * @param meterName 可选 meter 名称，默认 "vextjs-opentelemetry-http"
 */
export function buildCoreHandlers(
  options: HttpOtelOptions,
  meterName = "vextjs-opentelemetry-http",
): CoreHandlers {
  const metricsEnabled = options.metrics?.enabled !== false;
  const tracingEnabled = options.tracing?.enabled !== false;
  const serviceName = options.serviceName ?? "http-app";
  const ignorePaths = options.tracing?.ignorePaths ?? [];
  const customLabelsFn = options.metrics?.customLabels;
  const extraAttributesFn = options.tracing?.extraAttributes;
  const spanNameResolver = options.tracing?.spanNameResolver;

  // 指标创建（SDK 未初始化时为 Noop，isRecording=false，全部静默）
  const meter = otelMetrics.getMeter(meterName);
  const durationBuckets = options.metrics?.durationBuckets ?? DEFAULT_DURATION_BUCKETS;
  const httpRequestDuration = meter.createHistogram(METRIC_DURATION, {
    description: "HTTP server request duration (ms)",
    unit: "ms",
    advice: { explicitBucketBoundaries: durationBuckets },
  });
  const httpRequestTotal = meter.createCounter(METRIC_TOTAL, {
    description: "Total HTTP server requests",
  });
  const httpActiveRequests = meter.createUpDownCounter(METRIC_ACTIVE, {
    description: "Current active HTTP server requests",
  });
  const httpRequestSize = meter.createHistogram(METRIC_REQ_SIZE, {
    description: "HTTP server request body size (bytes)",
    unit: "By",
    advice: { explicitBucketBoundaries: DEFAULT_SIZE_BUCKETS },
  });
  const httpResponseSize = meter.createHistogram(METRIC_RESP_SIZE, {
    description: "HTTP server response body size (bytes)",
    unit: "By",
    advice: { explicitBucketBoundaries: DEFAULT_SIZE_BUCKETS },
  });

  function isIgnoredPath(urlPath: string): boolean {
    return ignorePaths.some((pattern) =>
      typeof pattern === "string" ? pattern === urlPath : pattern.test(urlPath),
    );
  }

  function resolveCustomLabels(ctx: OtelHttpContext): Record<string, string | number | boolean> {
    if (!customLabelsFn) return {};
    try {
      return typeof customLabelsFn === "function" ? customLabelsFn(ctx) : customLabelsFn;
    } catch {
      console.warn("[vextjs-opentelemetry] customLabels function threw an error, using defaults");
      return {};
    }
  }

  function resolveExtraAttributes(ctx: OtelHttpContext): Record<string, string | number | boolean> {
    if (!extraAttributesFn) return {};
    try {
      return typeof extraAttributesFn === "function" ? extraAttributesFn(ctx) : extraAttributesFn;
    } catch {
      console.warn("[vextjs-opentelemetry] extraAttributes function threw an error, using defaults");
      return {};
    }
  }

  return {
    onRequestStart(ctx: OtelHttpContext): CoreRequestState {
      const startTime = performance.now();

      const shouldTrace = tracingEnabled && !isIgnoredPath(ctx.path);
      const shouldMetric = metricsEnabled && !isIgnoredPath(ctx.path);
      const activeSpan = trace.getActiveSpan();

      if (shouldMetric) {
        httpActiveRequests.add(1, { "http.method": ctx.method });
        if (ctx.requestSize !== undefined) {
          httpRequestSize.record(ctx.requestSize, { "http.method": ctx.method });
        }
      }

      if (shouldTrace && activeSpan?.isRecording()) {
        const extra = resolveExtraAttributes(ctx);
        activeSpan.setAttributes({
          "http.request_id": ctx.requestId ?? "",
          "vext.service": serviceName,
          ...extra,
        });
      }

      return { startTime, shouldTrace, shouldMetric, activeSpan };
    },

    onRequestEnd(state: CoreRequestState, ctx: OtelHttpContext, statusCode: number): void {
      const duration = Math.round(performance.now() - state.startTime);
      const route = ctx.route ?? ctx.path;

      if (state.shouldTrace && state.activeSpan?.isRecording()) {
        state.activeSpan.setAttributes({
          "http.route": route,
          "http.status_code": statusCode,
        });

        if (spanNameResolver) {
          state.activeSpan.updateName(spanNameResolver(ctx));
        }

        if (statusCode >= 400) {
          state.activeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${statusCode}`,
          });
        }
      }

      if (state.shouldMetric) {
        const labels = {
          "http.method": ctx.method,
          "http.status_code": statusCode,
          "http.route": route,
          ...resolveCustomLabels(ctx),
        };
        httpRequestTotal.add(1, labels);
        httpRequestDuration.record(duration, labels);
        httpActiveRequests.add(-1, { "http.method": ctx.method });
        if (ctx.responseSize !== undefined) {
          httpResponseSize.record(ctx.responseSize, { "http.method": ctx.method, "http.status_code": statusCode });
        }
      }

      if (options.onEnd) {
        try {
          options.onEnd({
            traceId: state.activeSpan?.spanContext().traceId ?? "",
            method: ctx.method,
            route,
            latencyMs: duration,
            statusCode,
          } satisfies OnEndInfo);
        } catch (e) {
          console.warn("[vextjs-opentelemetry] onEnd callback threw:", (e as Error).message ?? e);
        }
      }
    },

    onRequestError(state: CoreRequestState, ctx: OtelHttpContext, err: unknown): void {
      const duration = Math.round(performance.now() - state.startTime);
      const route = ctx.route ?? ctx.path;

      if (state.shouldTrace && state.activeSpan?.isRecording()) {
        if (err instanceof Error) {
          state.activeSpan.recordException(err);
        }
        state.activeSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (state.shouldMetric) {
        const labels = {
          "http.method": ctx.method,
          "http.status_code": 500,
          "http.route": route,
          ...resolveCustomLabels(ctx),
        };
        httpRequestTotal.add(1, labels);
        httpRequestDuration.record(duration, labels);
        httpActiveRequests.add(-1, { "http.method": ctx.method });
      }

      if (options.onEnd) {
        try {
          options.onEnd({
            traceId: state.activeSpan?.spanContext().traceId ?? "",
            method: ctx.method,
            route,
            latencyMs: duration,
            statusCode: 500,
          } satisfies OnEndInfo);
        } catch (e) {
          console.warn("[vextjs-opentelemetry] onEnd callback threw:", (e as Error).message ?? e);
        }
      }
    },
  };
}
