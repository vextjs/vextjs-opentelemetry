// src/log.ts
// 日志集成工具
//
// 提供两个框架无关的工厂函数：
//   createStructuredLogFormatter — Schema A 结构化 JSON 日志格式化器
//   createOtelLogBridge          — OTel LogRecord 桥接（Schema B）
//
// 约束：
//   - 仅依赖 @opentelemetry/api-logs（API 层），不引入任何 SDK 包
//   - 纯函数工厂，不依赖任何全局状态

import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import type { Attributes } from "@opentelemetry/api";
import type { OtelLogBridge, OtelLogBridgeOptions } from "./core/types.js";
import { hostname } from "node:os";

// ── 内部常量 ─────────────────────────────────────────────────

/**
 * egg-logger / winston 常见 level 字符串 → OTel SeverityNumber 映射表
 *
 * 键为小写 level 字符串。未命中时降级为 UNSPECIFIED。
 */
const LEVEL_TO_SEVERITY: Record<string, SeverityNumber> = {
    trace: SeverityNumber.TRACE,
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
    fatal: SeverityNumber.FATAL,
};

// ── F-01: createStructuredLogFormatter ───────────────────────

/**
 * `createStructuredLogFormatter` 的配置选项
 *
 * `Meta` 泛型参数为日志框架传入的元数据对象类型（如 egg-logger 的 `meta` 参数）。
 */
export interface StructuredLogFormatterOptions<
    Meta extends Record<string, unknown> = Record<string, unknown>,
> {
    /**
     * 服务名称
     *
     * 对应 Schema A 的 `service.name` 字段。
     */
    serviceName: string;

    /**
     * 运行环境
     *
     * 默认读取 `process.env.NODE_ENV`，不存在时为 `"production"`。
     */
    env?: string;

    /**
     * 主机名
     *
     * 默认 `os.hostname()`。
     */
    host?: string;

    /**
     * 从日志元数据中提取追踪/上下文字段回调
     *
     * 在 Egg.js 中，可从 `meta` 对象中取出通过 `ctx.trace_id` 等注入的字段。
     * 返回值中 `undefined` 的字段仍会以空字符串写入输出（保持固定 Schema）。
     *
     * @example
     * getTraceFields: (meta) => ({
     *   trace_id: (meta as any).ctx?.trace_id ?? '',
     *   span:     (meta as any).ctx?.span_name ?? '',   // ctx.span_name 由 createEggMiddleware 注入
     *   endpoint: (meta as any).ctx?.endpoint ?? '',
     *   latency_ms: (meta as any).ctx?.latency_ms ?? 0,
     *   user_id:  (meta as any).ctx?.user_id ?? '',
     * })
     */
    getTraceFields?: (meta: Meta) => {
        trace_id?: string;
        span?: string;
        endpoint?: string;
        latency_ms?: number | string;
        user_id?: string;
        [key: string]: unknown;
    };

    /**
     * 提取业务自定义字段回调（如 `'feature.flag'`）
     *
     * 返回的键值对会展开合并到 Schema A JSON 的末尾。
     *
     * @example
     * getCustomFields: (meta) => ({
     *   'feature.flag': (meta as any).ctx?.feature_flag ?? '',
     * })
     */
    getCustomFields?: (meta: Meta) => Record<string, unknown>;
}

/**
 * 创建 Schema A 结构化日志格式化器
 *
 * 返回值可直接用于 egg-logger 的 `formatter` 配置项或类似接口。
 * 输出固定字段顺序：timestamp → level → message → service.name → env → host
 * → traceFields（trace_id/span/endpoint/latency_ms/user_id）→ customFields → exception.*
 *
 * @param options 配置选项
 * @returns `(meta: Meta) => string` — 接收元数据，返回 JSON 字符串
 *
 * @example
 * // Egg.js config/config.default.ts
 * import { createStructuredLogFormatter } from 'vextjs-opentelemetry/log';
 *
 * const formatter = createStructuredLogFormatter({
 *   serviceName: 'chat',
 *   getTraceFields: (meta) => ({
 *     trace_id: meta.ctx?.trace_id ?? '',
 *     span:     meta.ctx?.span_name ?? '',   // ctx.span_name 由 createEggMiddleware 注入
 *   }),
 *   getCustomFields: (meta) => ({
 *     'feature.flag': meta.ctx?.feature_flag ?? '',
 *   }),
 * });
 *
 * config.logger.formatter = formatter;
 */
export function createStructuredLogFormatter<
    Meta extends Record<string, unknown> = Record<string, unknown>,
>(options: StructuredLogFormatterOptions<Meta>): (meta: Meta) => string {
    const resolvedEnv = options.env ?? process.env["NODE_ENV"] ?? "production";
    const resolvedHost = options.host ?? hostname();

    return function structuredLogFormatter(meta: Meta): string {
        const level = (meta["level"] as string | undefined) ?? "info";
        const message = (meta["message"] as string | undefined) ?? "";

        // ── 时间戳格式：YYYY-MM-DD HH:mm:ss ─────────────────────
        const now = new Date();
        const pad2 = (n: number) => String(n).padStart(2, "0");
        const timestamp =
            `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
            `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

        // ── 追踪字段（try/catch 保护用户回调）───────────────────
        let traceFields: ReturnType<NonNullable<typeof options.getTraceFields>> = {};
        if (options.getTraceFields) {
            try {
                traceFields = options.getTraceFields(meta);
            } catch (e) {
                console.warn(
                    "[vextjs-opentelemetry] getTraceFields callback threw:",
                    (e as Error).message ?? e,
                );
            }
        }

        // ── 自定义字段（try/catch 保护用户回调）─────────────────
        let customFields: Record<string, unknown> = {};
        if (options.getCustomFields) {
            try {
                customFields = options.getCustomFields(meta);
            } catch (e) {
                console.warn(
                    "[vextjs-opentelemetry] getCustomFields callback threw:",
                    (e as Error).message ?? e,
                );
            }
        }

        // ── exception 字段（如果有异常信息则展开）───────────────
        const exceptionFields: Record<string, unknown> = {};
        const err = meta["err"] ?? meta["error"];
        if (err instanceof Error) {
            exceptionFields["exception.type"] = err.name;
            exceptionFields["exception.message"] = err.message;
            exceptionFields["exception.stacktrace"] = err.stack ?? "";
        }

        // ── 固定字段顺序组装 ─────────────────────────────────────
        const record: Record<string, unknown> = {
            timestamp,
            level,
            message,
            "service.name": options.serviceName,
            env: resolvedEnv,
            host: resolvedHost,
            trace_id: traceFields.trace_id ?? "",
            span: traceFields.span ?? "",
            endpoint: traceFields.endpoint ?? "",
            latency_ms: traceFields.latency_ms ?? 0,
            user_id: traceFields.user_id ?? "",
            ...customFields,
            ...exceptionFields,
        };

        return JSON.stringify(record, null, 0);
    };
}

// ── F-02: createOtelLogBridge ─────────────────────────────────

// 类型从 core/types.ts 统一定义，此处重新导出供 ./log 子路径用户直接使用
export type { OtelLogBridge, OtelLogBridgeOptions } from "./core/types.js";

/**
 * 创建 OTel LogRecord 桥接（Schema B）
 *
 * 封装 level → SeverityNumber 映射和 `logger.emit()` 调用，支持延迟求值的
 * `getLogger` 工厂函数（在 SDK 初始化前调用时可返回 null/undefined 以静默 noop）。
 *
 * @param getLogger 返回 OTel `Logger` 实例的工厂函数；返回 null/undefined 时 emit 为 noop
 * @param options   可选配置，支持 `globalAttributes` 全局静态字段
 * @returns `{ emit(level, message, attributes?) }` 桥接对象
 *
 * @example
 * import { createOtelLogBridge, getOtelLogger } from 'vextjs-opentelemetry/log';
 *
 * const bridge = createOtelLogBridge(() => getOtelLogger("chat"), {
 *   globalAttributes: {
 *     "deployment.environment": process.env.NODE_ENV ?? "production",
 *     "app.version": "1.2.3",
 *   },
 * });
 * bridge.emit("error", "db timeout", { "db.system": "postgres", "db.latency_ms": 3200 });
 */
export function createOtelLogBridge(
    getLogger: () => Pick<Logger, "emit"> | null | undefined,
    options?: OtelLogBridgeOptions,
): OtelLogBridge {
    const globalAttrs = options?.globalAttributes;

    return {
        emit(
            level: string,
            message: string,
            attributes?: Attributes,
        ): void {
            let logger: Pick<Logger, "emit"> | null | undefined;
            try {
                logger = getLogger();
            } catch {
                return;
            }

            if (!logger) return;

            const severityText = level.toUpperCase();
            const severityNumber =
                LEVEL_TO_SEVERITY[level.toLowerCase()] ?? SeverityNumber.UNSPECIFIED;

            const merged: Attributes | undefined =
                globalAttrs || attributes
                    ? { ...globalAttrs, ...attributes }
                    : undefined;

            logger.emit({
                severityText,
                severityNumber,
                body: message,
                ...(merged && Object.keys(merged).length > 0
                    ? { attributes: merged }
                    : {}),
            });
        },
    };
}
