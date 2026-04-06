// src/core.ts
// 框架无关的 HTTP 追踪核心处理器
//
// 职责：
//   为各框架适配器提供统一的三阶段钩子（onRequestStart / onRequestEnd / onRequestError），
//   完成 Span 标注、HTTP 指标记录等框架无关逻辑。
//
// 使用方式：
//   const handlers = buildCoreHandlers(options);
//   // 在框架中间件/hook 内：
//   const state = handlers.onRequestStart(ctx);
//   // ... 执行请求 ...
//   handlers.onRequestEnd(state, ctx, statusCode);
//
// 注意：
//   - 适配器中禁止执行 SDK 初始化（遵守架构约束）
//   - 仅 import @opentelemetry/api，不 import 任何 SDK 包

import { trace, metrics as otelMetrics, SpanStatusCode } from "@opentelemetry/api";
import type { Span, SpanOptions } from "@opentelemetry/api";

import type { OtelHttpContext, HttpOtelOptions, OnEndInfo } from "./types.js";

// ── 内置默认分桶（毫秒）───────────────────────────────────────

const DEFAULT_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// ── 指标名称（遵循 OTEL 语义约定）───────────────────────────

const METRIC_DURATION = "http.server.duration";
const METRIC_TOTAL = "http.server.request.total";
const METRIC_ACTIVE = "http.server.active_requests";

// ── 公开类型 ─────────────────────────────────────────────────

/**
 * `onRequestStart` 返回的请求状态快照，跨调用传递
 *
 * - `startTime`：`performance.now()` 时间戳
 * - `shouldTrace`：是否进行 Span 标注（ignorePaths 已过滤）
 * - `activeSpan`：在 `onRequestStart` 时捕获的 Span 引用；
 *   后续直接引用而非重新调用 `trace.getActiveSpan()`，
 *   避免 Express `res.on('finish')` 等回调中 Context 已变更的问题
 */
export interface CoreRequestState {
    readonly startTime: number;
    readonly shouldTrace: boolean;
    readonly activeSpan: Span | undefined;
}

/** `buildCoreHandlers` 返回的三阶段处理器 */
export interface CoreHandlers {
    /**
     * 请求开始阶段
     *
     * - 获取当前活跃 Span 并存入 state
     * - 检查 ignorePaths；shouldTrace=false 时后续 Span 操作跳过
     * - 调用 extraAttributes（在 route 匹配前，ctx.route 可能为 undefined）
     * - 活跃请求数 +1
     */
    onRequestStart(ctx: OtelHttpContext): CoreRequestState;

    /**
     * 请求成功结束阶段（await next() 或 res.on('finish') 之后）
     *
     * - 更新 `http.route`、`http.status_code`
     * - 调用 spanNameResolver（此时 ctx.route 应已由适配器填充）
     * - 设置 Span status（4xx/5xx → ERROR）
     * - 记录 httpRequestDuration / httpRequestTotal
     * - 活跃请求数 -1
     */
    onRequestEnd(state: CoreRequestState, ctx: OtelHttpContext, statusCode: number): void;

    /**
     * 请求异常阶段（未捕获异常）
     *
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
 * @param options 通用追踪选项（`HttpOtelOptions`）
 * @param meterName 可选 meter 名称，默认 `"vextjs-opentelemetry-http"`
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

    // ── 指标创建（SDK 未初始化时为 Noop，isRecording=false，全部静默）────
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

    // ── 辅助：ignorePaths 匹配 ───────────────────────────────
    function isIgnoredPath(urlPath: string): boolean {
        return ignorePaths.some((pattern) =>
            typeof pattern === "string" ? pattern === urlPath : pattern.test(urlPath),
        );
    }

    // ── 辅助：resolveLabels ──────────────────────────────────
    function resolveCustomLabels(
        ctx: OtelHttpContext,
    ): Record<string, string | number | boolean> {
        if (!customLabelsFn) return {};
        try {
            return typeof customLabelsFn === "function"
                ? customLabelsFn(ctx)
                : customLabelsFn;
        } catch {
            console.warn(
                "[vextjs-opentelemetry] customLabels function threw an error, using defaults",
            );
            return {};
        }
    }

    // ── 辅助：resolveExtraAttributes ────────────────────────
    function resolveExtraAttributes(
        ctx: OtelHttpContext,
    ): Record<string, string | number | boolean> {
        if (!extraAttributesFn) return {};
        try {
            return typeof extraAttributesFn === "function"
                ? extraAttributesFn(ctx)
                : extraAttributesFn;
        } catch {
            console.warn(
                "[vextjs-opentelemetry] extraAttributes function threw an error, using defaults",
            );
            return {};
        }
    }

    return {
        // ────────────────────────────────────────────────────────
        onRequestStart(ctx: OtelHttpContext): CoreRequestState {
            const startTime = performance.now();

            // 活跃请求 +1
            if (metricsEnabled) {
                httpActiveRequests.add(1, { "http.method": ctx.method });
            }

            const shouldTrace = tracingEnabled && !isIgnoredPath(ctx.path);
            const activeSpan = trace.getActiveSpan();

            if (shouldTrace && activeSpan?.isRecording()) {
                const extra = resolveExtraAttributes(ctx);
                activeSpan.setAttributes({
                    "http.request_id": ctx.requestId ?? "",
                    "vext.service": serviceName,
                    ...extra,
                });
            }

            return { startTime, shouldTrace, activeSpan };
        },

        // ────────────────────────────────────────────────────────
        onRequestEnd(
            state: CoreRequestState,
            ctx: OtelHttpContext,
            statusCode: number,
        ): void {
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

            if (metricsEnabled) {
                const labels = {
                    "http.method": ctx.method,
                    "http.status_code": statusCode,
                    "http.route": route,
                    ...resolveCustomLabels(ctx),
                };
                httpRequestTotal.add(1, labels);
                httpRequestDuration.record(duration, labels);
                httpActiveRequests.add(-1, { "http.method": ctx.method });
            }

            // onEnd 回调：在 Span/指标操作完成后触发，try/catch 保护主链路
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

        // ────────────────────────────────────────────────────────
        onRequestError(
            state: CoreRequestState,
            ctx: OtelHttpContext,
            err: unknown,
        ): void {
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

            if (metricsEnabled) {
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

            // onEnd 回调：try/catch 保护主链路
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

// ── 框架无关工具函数 ──────────────────────────────────────────

/**
 * 创建绑定到指定 tracer 的 withSpan 辅助方法
 *
 * 可在任意 Node.js Web 框架中使用（不依赖任何框架）。
 *
 * @param tracerName - Tracer 名称（通常与服务名一致，如 `'chat'`、`'payment'`）
 *
 * @example
 * // Egg.js / Koa / Express：注入到 ctx 或 app
 * import { createWithSpan } from 'vextjs-opentelemetry';
 * export default { withSpan: createWithSpan('chat') };
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
 * 框架无关，各框架自行决定注册的路由路径。
 *
 * @example
 * // Egg.js router
 * import { getOtelStatus } from 'vextjs-opentelemetry';
 * router.get('/_otel/status', async (ctx) => {
 *   ctx.body = getOtelStatus({ serviceName: 'chat', endpoint: '...' });
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
