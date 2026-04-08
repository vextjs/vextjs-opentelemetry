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
 * 框架无关的 HTTP 请求上下文
 *
 * 各框架适配器将自己的请求对象映射到此结构，
 * 再传入 buildCoreHandlers 的三阶段钩子。
 *
 * 注意：在全局中间件阶段（如 Express app.use()），
 * route 可能为 undefined（路由匹配尚未发生）。
 */
export interface OtelHttpContext {
  /** HTTP 方法（大写），如 "GET"、"POST" */
  method: string;
  /** 请求路径（不含 query string），如 "/users/123" */
  path: string;
  /** 路由模板，如 "/users/:id"；全局中间件阶段可能为 undefined */
  route: string | undefined;
  /** 请求 ID，通常来自 x-request-id 请求头 */
  requestId: string | undefined;
  /** 原始请求头（用于 extraAttributes 等回调动态读取） */
  headers: Record<string, string | string[] | undefined>;
}

// ── HTTP 追踪选项 ─────────────────────────────────────────────

/**
 * 通用 HTTP 追踪选项
 *
 * 用于 createExpressMiddleware / createKoaMiddleware /
 * createHonoMiddleware / createFastifyPlugin 等工厂函数。
 */
export interface HttpOtelOptions {
  /** 服务名称，写入 vext.service Span 属性，默认 "http-app" */
  serviceName?: string;

  /** 追踪配置 */
  tracing?: {
    /** 是否启用追踪，默认 true */
    enabled?: boolean;
    /** 忽略路径列表（字符串精确匹配或正则）*/
    ignorePaths?: (string | RegExp)[];
    /** 自定义 Span 名称解析器（请求结束后调用，route 已知） */
    spanNameResolver?: (ctx: OtelHttpContext) => string;
    /**
     * 请求开始阶段额外 Span 属性（route 可能为 undefined）
     * ⚠️ 避免高基数字段
     */
    extraAttributes?:
      | Record<string, string | number | boolean>
      | ((ctx: OtelHttpContext) => Record<string, string | number | boolean>);
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
    customLabels?:
      | Record<string, string | number | boolean>
      | ((ctx: OtelHttpContext) => Record<string, string | number | boolean>);
  };

  /**
   * 请求完成回调（成功或异常均触发）
   * 在 Span/指标操作完成后调用，try/catch 保护主链路
   */
  onEnd?: (info: OnEndInfo) => void;

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

// ── 请求完成回调信息 ──────────────────────────────────────────

/**
 * onEnd 回调接收的请求完成信息
 *
 * 在每次 HTTP 请求处理完成后由各适配器触发。
 * 可用于将 traceId 注入业务上下文（如日志关联）。
 */
export interface OnEndInfo {
  /** 十六进制 Trace ID（32 位小写），无活跃 Span 时为空字符串 */
  traceId: string;
  /** HTTP 方法（大写），如 "GET" */
  method: string;
  /** 解析后的路由模板（如 "/users/:id"），无法解析时为原始 path */
  route: string;
  /** 请求耗时（毫秒整数，performance.now() 精度） */
  latencyMs: number;
  /** HTTP 响应状态码；异常路径固定为 500 */
  statusCode: number;
}

// ── SDK 配置 ──────────────────────────────────────────────────

/** SDK 导出模式 */
export type ExportMode = "none" | "file" | "otlp-http" | "otlp-grpc";

/** instrumentation.ts 读取并使用的完整 SDK 配置 */
export interface OtelConfig {
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
