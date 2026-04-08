// src/core/span.ts
// Span 工具 API（v1.0.0 重构）
//
// 框架无关，业务代码直接从主入口使用：
//   import { withSpan, createWithSpan, getActiveTraceId, getOtelStatus } from "vextjs-opentelemetry"
//
// 100% 依赖 @opentelemetry/api，不引入任何 SDK 包。

import { trace, SpanStatusCode } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { Span, SpanOptions } from "@opentelemetry/api";
import type { OtelStatus, ExportMode } from "./types.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";

// ── withSpan — 直接调用（零配置） ────────────────────────────

/**
 * 追踪任意异步/同步操作（使用默认 tracer）
 *
 * 零配置直接使用：无需预先创建 tracer，推荐用于函数级别的临时追踪。
 * 成功路径自动 span.end()；异常路径 recordException + setStatus(ERROR) + end + re-throw。
 *
 * @param name    Span 名称
 * @param fn      被追踪的操作，span 实例为参数（仅在需要动态属性时才使用）
 * @param options SpanOptions，可通过 attributes 传静态初始属性；
 *                额外字段 tracerName 指定具名 tracer（默认 "vextjs-opentelemetry"）
 *
 * @example
 * import { withSpan } from "vextjs-opentelemetry";
 *
 * // 不接触 span（仅追踪生命周期）
 * const result = await withSpan("user.queryById", () => db.findUser(id));
 *
 * // 动态属性
 * const result = await withSpan("user.queryById", async (span) => {
 *   span.setAttribute("user.id", id);
 *   return db.findUser(id);
 * });
 */
export function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options?: SpanOptions & { tracerName?: string },
): Promise<T> {
  const { tracerName, ...spanOptions } = options ?? {};
  const tracer = trace.getTracer(tracerName ?? "vextjs-opentelemetry");
  return tracer.startActiveSpan(name, spanOptions, async (span) => {
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
}

// ── createWithSpan — 绑定具名 tracer ────────────────────────

/**
 * 创建绑定具名 tracer 的 withSpan 函数
 *
 * 适合模块级别统一管理，避免每次调用都指定 tracerName。
 * VextJS 用户优先通过 app.otel.withSpan 访问（已绑定服务名）；
 * Egg.js / Koa / Express 用户可在应用启动时创建并注入到 ctx 或 app。
 *
 * @param tracerName Tracer 名称（通常与服务名一致，如 "user"、"chat"）
 *
 * @example
 * import { createWithSpan } from "vextjs-opentelemetry";
 *
 * // 模块顶部创建，绑定服务名
 * const withSpan = createWithSpan("user-service");
 *
 * // 业务代码使用
 * const user = await withSpan("user.getById", (span) => {
 *   span.setAttribute("user.id", id);
 *   return db.findUser(id);
 * });
 */
export function createWithSpan(tracerName: string) {
  const tracer = trace.getTracer(tracerName);
  return function boundWithSpan<T>(
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

// ── 上下文读取工具 ────────────────────────────────────────────

/**
 * 获取当前活跃 Span 对象
 *
 * SDK 未初始化时返回 Noop Span（不为 undefined，但 isRecording() = false）。
 *
 * @example
 * const span = getActiveSpan();
 * span?.setAttribute("custom.key", "value");
 */
export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * 获取当前请求的 traceId（32 位小写十六进制）
 *
 * 无活跃 Span、采样关闭（traceFlags = 0）或 SDK 未初始化时返回空字符串 ""。
 * 用于日志关联：将 traceId 写入日志字段，与 Trace 数据形成关联。
 *
 * @example
 * import { getActiveTraceId } from "vextjs-opentelemetry";
 *
 * // Egg.js / Koa
 * ctx.logger.info("处理用户请求", { trace_id: getActiveTraceId(), userId });
 */
export function getActiveTraceId(): string {
  return trace.getActiveSpan()?.spanContext().traceId ?? "";
}

/**
 * 获取当前活跃 Span 的 spanId（16 位小写十六进制）
 *
 * 无活跃 Span 时返回空字符串 ""。
 */
export function getActiveSpanId(): string {
  return trace.getActiveSpan()?.spanContext().spanId ?? "";
}

// ── SDK 状态查询 ──────────────────────────────────────────────

/**
 * 获取 OTel SDK 当前运行状态
 *
 * 框架无关，各框架自行决定注册的路由路径。
 * VextJS 适配器内部使用此函数驱动 /_otel/status 端点；
 * Egg.js / Koa / Express 可在路由中直接调用。
 *
 * @example
 * // Egg.js router
 * import { getOtelStatus } from "vextjs-opentelemetry";
 * router.get("/_otel/status", async (ctx) => {
 *   ctx.body = getOtelStatus();
 * });
 *
 * // Express
 * app.get("/_otel/status", (_req, res) => res.json(getOtelStatus()));
 */
export function getOtelStatus(): OtelStatus {
  return {
    sdk: process.env.VEXT_OTEL_SDK_STARTED === "1" ? "initialized" : "noop",
    serviceName: process.env.OTEL_SERVICE_NAME ?? process.env.VEXT_OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME,
    exportMode: (process.env.VEXT_OTEL_EXPORT_MODE as ExportMode | undefined) ?? "none",
    exportTarget:
      process.env.VEXT_OTEL_EXPORT_DIR ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "none",
    protocol: (process.env.VEXT_OTEL_PROTOCOL as "http" | "grpc" | undefined) ?? "http",
    autoInstrumentation: process.env.VEXT_OTEL_AUTO_INSTRUMENTATION === "1",
    samplingRatio: parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? "1.0") || 1.0,
  };
}

// ── OTel Logger 获取 ──────────────────────────────────────────

/**
 * 获取 OTel Logger 实例（用于结合 createOtelLogBridge 发送 Log signal）
 *
 * 框架无关，各框架在初始化完成后调用。
 * SDK 未初始化时返回 NoopLogger（emit 为空操作，不报错）。
 *
 * @param name Logger 名称（通常与 serviceName 一致）
 *
 * @example
 * import { getOtelLogger } from "vextjs-opentelemetry";
 * import { createOtelLogBridge } from "vextjs-opentelemetry/log";
 *
 * const bridge = createOtelLogBridge(() => getOtelLogger("chat"));
 * bridge.emit("info", "user logged in", { "user.id": userId });
 */
export function getOtelLogger(name?: string) {
  return logs.getLogger(name ?? DEFAULT_SERVICE_NAME);
}
