// src/core/types.ts
// 所有共享类型定义（v1.0.0 重构）
//
// 原则：此文件只包含类型，不包含任何运行时逻辑。
// 所有适配器和 instrumentation.ts 均从此文件导入类型。

import type {
  Span,
  SpanOptions,
  Tracer,
  Meter,
  Histogram,
  Counter,
  UpDownCounter,
  Attributes,
} from "@opentelemetry/api";

// ── 通用常量 ──────────────────────────────────────────────────

/**
 * 默认服务名称（用于所有 fallback，统一管理避免写死）
 * 可通过 OTEL_SERVICE_NAME 环境变量覆盖
 */
export const DEFAULT_SERVICE_NAME = "vext-app";

/**
 * 框架无关的 HTTP 观测上下文
 *
 * 各框架适配器将自己的请求对象映射到此结构，
 * 再传入 buildCoreHandlers 的三阶段钩子。
 *
 * 注意：在全局中间件阶段（如 Express app.use()），
 * route 可能为 undefined（路由匹配尚未发生）。
 */
export interface HttpObservationContext {
  /** 当前所处阶段：start（请求开始）/ end（请求结束或异常收口） */
  phase: "start" | "end";
  /** HTTP 方法（大写），如 "GET"、"POST" */
  method: string;
  /** 请求路径（不含 query string），如 "/users/123" */
  path: string;
  /** 路由模板，如 "/users/:id"；全局中间件阶段可能为 undefined */
  route: string | undefined;
  /** 请求 ID，通常来自 x-request-id 请求头 */
  requestId: string | undefined;
  /** 原始请求头（用于 startAttributes / endAttributes / metrics.labels / lifecycle 动态读取） */
  headers: Record<string, string | string[] | undefined>;
  /** 已归一化的 query 参数，仅保留 string / string[] 值 */
  query?: Record<string, string | string[] | undefined>;
  /** 已归一化的路由参数，仅保留 string 值 */
  params?: Record<string, string | undefined>;
  /** 已解析的请求体；不同框架可为对象 / FormData / 其他已缓存结果 */
  body?: unknown;
  /** 请求体大小（bytes），来自 Content-Length 请求头；未提供时为 undefined */
  requestSize?: number;
  /** 响应体大小（bytes），来自 Content-Length 响应头；由适配器在 onRequestEnd 前写入 */
  responseSize?: number;
  /** HTTP 响应状态码；start 阶段通常为 undefined */
  statusCode?: number;
  /** 请求耗时（毫秒）；start 阶段通常为 undefined */
  latencyMs?: number;
}

export type ObservationAttributeMap = Record<string, string | number | boolean>;

export type ObservationAttributeResolver<TRaw = unknown> =
  | ObservationAttributeMap
  | ((ctx: HttpObservationContext, raw: TRaw) => ObservationAttributeMap);

export interface CaptureFieldRule {
  /** 实际读取的源字段名；不填时默认等于对象 key */
  from?: string;
  /** 是否脱敏；传字符串时作为脱敏后的固定值 */
  redact?: boolean | string;
  /** 当前字段独立的最大长度限制；仅对 string 生效 */
  maxLength?: number;
}

export type CaptureFieldSelection = string[] | Record<string, CaptureFieldRule>;

/** 显式全量采集开关，仅用于 query / params 这类已归一化集合 */
export type CaptureAllSelection = true | "*";

export interface CaptureSourceOptions {
  /** 采集模式：allowlist（默认）/ all（显式全量） */
  mode?: "allowlist" | "all";
  /** 白名单字段；未指定时沿用简写 selection */
  fields?: CaptureFieldSelection;
  /** 排除字段或路径 */
  exclude?: (string | RegExp)[];
  /** 当前 source 的敏感字段规则；优先于全局 sensitiveKeys */
  sensitiveKeys?: (string | RegExp)[];
  /** 当前 source 的字符串截断长度；优先于全局 maxValueLength */
  maxValueLength?: number;
  /** 展开对象时的最大递归深度（主要用于 body） */
  maxDepth?: number;
  /** 展开数组时的最大元素数量（主要用于 body） */
  maxItems?: number;
  /** 兼容快捷开关：为 true 时等价于 output='both' */
  snapshot?: boolean;
  /** 输出形式：展开属性 / 原始快照 / 两者都输出 */
  output?: "attributes" | "snapshot" | "both";
}

/** query / params / headers / body 的统一 capture 输入 */
export type CaptureInput = CaptureAllSelection | CaptureFieldSelection | CaptureSourceOptions;

export interface RequestCaptureOptions<TRaw = unknown> {
  /** 请求头采集：支持白名单、显式全量与规则对象；在 start 阶段采集 */
  headers?: CaptureInput;
  /** query 参数采集：支持白名单、显式全量与规则对象 */
  query?: CaptureInput;
  /** 路由参数采集：支持白名单、显式全量与规则对象 */
  params?: CaptureInput;
  /** body 字段采集：支持白名单、显式全量与规则对象；在 end 阶段采集，且仅消费已解析 body */
  body?: CaptureInput;
  /** 敏感字段命中规则；命中后默认写入 [REDACTED] */
  sensitiveKeys?: (string | RegExp)[];
  /** 全局字符串截断长度，默认 256 */
  maxValueLength?: number;
}

export interface RequestLifecycleInfo {
  /** 十六进制 Trace ID（32 位小写），无活跃 Span 时为空字符串 */
  traceId: string;
  /** HTTP 响应状态码；异常路径固定为 500 */
  statusCode: number;
  /** 请求耗时（毫秒整数，performance.now() 精度） */
  latencyMs: number;
  /** 异常对象；成功路径为 undefined */
  error?: unknown;
}

export interface RequestLifecycleHooks<TRaw = unknown> {
  /** 请求开始阶段生命周期回调（非 attributes 副作用入口） */
  onStart?: (ctx: HttpObservationContext, raw: TRaw) => void;
  /** 请求结束阶段生命周期回调（非 attributes 副作用入口） */
  onEnd?: (ctx: HttpObservationContext, raw: TRaw, info: RequestLifecycleInfo) => void;
}

// ── HTTP 追踪选项 ─────────────────────────────────────────────

/**
 * 通用 HTTP 追踪选项
 *
 * 用于 createExpressMiddleware / createKoaMiddleware /
 * createHonoMiddleware / createFastifyPlugin 等工厂函数。
 */
export interface HttpOtelOptions<TRaw = unknown> {
  /** 服务名称，写入 vext.service Span 属性，默认 "http-app" */
  serviceName?: string;

  /** 追踪配置 */
  tracing?: {
    /** 是否启用追踪，默认 true */
    enabled?: boolean;
    /** 忽略路径列表（字符串精确匹配或正则）*/
    ignorePaths?: (string | RegExp)[];
    /** 自定义 Span 名称解析器（请求结束后调用，route 已知） */
    spanNameResolver?: (ctx: HttpObservationContext, raw: TRaw) => string;
    /**
     * 请求开始阶段额外 Span 属性（route/statusCode 可能为 undefined）
     * ⚠️ 避免高基数字段
     */
    startAttributes?: ObservationAttributeResolver<TRaw>;
    /**
     * 请求结束阶段额外 Span 属性（route / statusCode 已知，适合读取框架原始上下文）
     * ⚠️ 避免高基数字段
     */
    endAttributes?: ObservationAttributeResolver<TRaw>;
  };

  /** 指标配置 */
  metrics?: {
    /** 是否启用 HTTP 指标，默认 true */
    enabled?: boolean;
    /**
     * HTTP 请求时长直方图分桶边界（ms）
     * 默认：[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
     */
    durationBuckets?: number[];
    /**
     * 自定义业务标签，合并到 duration + total 指标
     * ⚠️ 避免高基数字段（如 user.id）
     */
    labels?: ObservationAttributeResolver<TRaw>;
  };

  /** 请求生命周期回调（成功或异常均触发） */
  lifecycle?: RequestLifecycleHooks<TRaw>;

  /** 常见请求字段的声明式采集配置 */
  capture?: RequestCaptureOptions<TRaw>;

  /** Logs 配置 */
  logs?: {
    /**
     * 全局静态属性（注入到所有通过适配器 logger 发出的 log record）
     *
     * 适合写入应用级不变字段：app.version / tenant.id / feature.flag
     * per-emit attributes 优先级更高
     */
    globalAttributes?: Attributes;
  };
}


// ── SDK 配置 ──────────────────────────────────────────────────

/** SDK 导出模式 */
export type ExportMode = "none" | "file" | "otlp-http" | "otlp-grpc";

/** instrumentation.ts 读取并使用的完整 SDK 配置 */
export interface OtelConfig {
  /** SDK 总开关；package.json vext.otel.enabled=false 时为 false */
  enabled?: boolean;
  /** Vext 自动 preload 场景下是否显式启用进程最早期 SDK */
  preloadSdk?: boolean;
  serviceName: string;
  endpoint: string;
  /** 上报协议：http（默认）或 grpc */
  protocol: "http" | "grpc";
  headers?: Record<string, string>;
  sampling: { ratio: number };
  metricIntervalMs: number;
}

// ── OTel 状态 ─────────────────────────────────────────────────

/** getOtelStatus() 返回的 SDK 运行状态 */
export interface OtelStatus {
  sdk: "initialized" | "noop";
  serviceName: string;
  exportMode: ExportMode;
  /** 上报地址或本地文件目录 */
  exportTarget: string;
  protocol: "http" | "grpc";
  autoInstrumentation: boolean;
  samplingRatio: number;
}

// ── HTTP 指标对象 ─────────────────────────────────────────────

/**
 * 插件创建并管理的标准 HTTP 指标集合
 * 通过 app.otel.metrics 暴露，也在 http-core 内部使用
 */
export interface OtelMetrics {
  /** HTTP 请求时长直方图（ms）— http.server.duration */
  httpRequestDuration: Histogram;
  /** HTTP 请求总数计数器 — http.server.request.total */
  httpRequestTotal: Counter;
  /** 当前活跃请求数 — http.server.active_requests */
  httpActiveRequests: UpDownCounter;
  /** HTTP 请求体大小直方图（bytes）— http.server.request.size */
  httpRequestSize?: Histogram;
  /** HTTP 响应体大小直方图（bytes）— http.server.response.size */
  httpResponseSize?: Histogram;
}

// ── VextJS app.otel 扩展类型 ──────────────────────────────────

/** app.otel 扩展对象类型（由 /vextjs 适配器挂载） */
export interface OtelAppExtension {
  /** OTEL Tracer 实例（SDK 未初始化时为 NoopTracer） */
  tracer: Tracer;
  /** OTEL Meter 实例（SDK 未初始化时为 NoopMeter） */
  meter: Meter;
  /** 插件创建的标准 HTTP 指标集合 */
  metrics: OtelMetrics;
  /**
   * 预配置了 globalAttributes 的 OTel Log 桥接
   *
   * 直接 emit 即可，全局字段自动合并：
   * @example
   * app.otel.logger.emit("info", "user login", { "user.id": userId })
   */
  logger: OtelLogBridge;
  /**
   * 追踪任意操作的辅助方法（绑定服务名 Tracer）
   * 成功路径自动 span.end()；异常路径 recordException + setStatus(ERROR) + end + re-throw
   */
  withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions,
  ): Promise<T>;
  /** 获取当前请求的 traceId，用于日志关联 */
  getTraceId(): string;
  /** 获取 SDK 当前运行状态 */
  getStatus(): OtelStatus;
}

// ── OTel Log 桥接接口 ─────────────────────────────────────────

/**
 * `createOtelLogBridge` 的配置选项
 */
export interface OtelLogBridgeOptions {
  /**
   * 全局静态属性（注入到所有 emit 调用）
   *
   * 适合写入 pod.name / region / app.version 等不变的环境标识。
   * per-emit attributes 同名 key 优先级更高。
   */
  globalAttributes?: Attributes;
}

/**
 * OTel LogRecord 桥接接口
 *
 * 封装 level → SeverityNumber 映射，支持全局属性注入。
 * 通过 `createOtelLogBridge()` 创建；各框架适配器将其挂载到 app.otel.logger。
 */
export interface OtelLogBridge {
  /**
   * 发送一条 OTel LogRecord
   *
   * @param level      日志级别字符串（'debug'/'info'/'warn'/'error'/'fatal'）
   * @param message    日志正文（对应 LogRecord.body）
   * @param attributes 可选附加属性（string/number/boolean），与 globalAttributes 合并
   */
  emit(level: string, message: string, attributes?: Attributes): void;
}
