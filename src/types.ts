import type {
  Tracer,
  Meter,
  Histogram,
  Counter,
  UpDownCounter,
} from "@opentelemetry/api";
import type { VextRequest } from "vextjs";

// ── 插件配置选项 ─────────────────────────────────────────────

/**
 * opentelemetryPlugin() 工厂函数选项
 *
 * 所有字段均为可选，插件内置合理默认值。
 * 优先级：工厂函数参数 > vext config.otel > 环境变量 > 内置默认值
 */
export interface OpenTelemetryPluginOptions {
  /**
   * 服务名称
   *
   * 用于 OTEL tracer/meter 名称及 Resource 的 service.name 属性。
   * 优先级：OTEL_SERVICE_NAME 环境变量 > options.serviceName > config.otel.serviceName > "vext-app"
   */
  serviceName?: string;

  /**
   * 是否启用插件（默认 true）
   *
   * false 时不注册中间件、不挂载 app.otel，完全 no-op。
   * 适合通过环境变量动态控制是否启用遥测。
   */
  enabled?: boolean;

  /**
   * 追踪配置
   */
  tracing?: {
    /**
     * 是否启用追踪中间件（默认 true）
     *
     * false 时跳过 Span 标注和 ALS 写入，但仍统计指标。
     */
    enabled?: boolean;

    /**
     * 为每个请求的 Span 添加额外属性
     *
     * 函数形式支持从 req 动态读取（如用户 ID、租户 ID）。
     *
     * @example
     * extraAttributes: (req) => ({ 'user.id': req.headers['x-user-id'] })
     */
    extraAttributes?:
      | Record<string, string | number | boolean>
      | ((req: VextRequest) => Record<string, string | number | boolean>);
  };

  /**
   * 指标配置
   */
  metrics?: {
    /**
     * 是否启用 HTTP 指标（默认 true）
     *
     * false 时跳过所有指标统计（httpRequestDuration/httpRequestTotal/httpActiveRequests）。
     */
    enabled?: boolean;

    /**
     * HTTP 请求时长直方图的分桶边界（单位：毫秒）
     *
     * 默认分桶：[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
     * 可根据业务 SLO 调整，例如低延迟场景可使用更细粒度的小值分桶。
     */
    durationBuckets?: number[];
  };
}

// ── HTTP 指标对象 ─────────────────────────────────────────────

/**
 * 插件创建并管理的标准 HTTP 指标集合
 *
 * 由 opentelemetryPlugin() 在 setup() 阶段创建，
 * 通过 app.otel.metrics 暴露给用户，也传入追踪中间件内部使用。
 */
export interface OtelMetrics {
  /**
   * HTTP 请求时长直方图（单位：毫秒）
   *
   * OTEL 语义约定名称：http.server.duration
   * 标签：http.method / http.status_code / http.route
   */
  httpRequestDuration: Histogram;

  /**
   * HTTP 请求总数计数器
   *
   * OTEL 语义约定名称：http.server.request.total
   * 标签：http.method / http.status_code / http.route
   */
  httpRequestTotal: Counter;

  /**
   * 当前活跃请求数（UpDownCounter）
   *
   * OTEL 语义约定名称：http.server.active_requests
   * 标签：http.method
   */
  httpActiveRequests: UpDownCounter;
}

// ── app.otel 扩展对象 ─────────────────────────────────────────

/**
 * app.otel 扩展对象类型
 *
 * 通过 app.extend('otel', {...}) 挂载到 app 上，
 * 在路由 handler 和 service 层中通过 req.app.otel 访问。
 */
export interface OtelAppExtension {
  /** OTEL Tracer 实例（SDK 未初始化时为 NoopTracer） */
  tracer: Tracer;

  /** OTEL Meter 实例（SDK 未初始化时为 NoopMeter） */
  meter: Meter;

  /** 插件创建的标准 HTTP 指标集合 */
  metrics: OtelMetrics;
}

// ── declare module 'vextjs'：类型自动扩展 ───────────────────
//
// 用户安装 vextjs-opentelemetry 后，IDE 自动识别以下扩展类型。
// 用户无需手写任何 .d.ts 文件。

declare module "vextjs" {
  interface VextApp {
    /**
     * OpenTelemetry 集成对象（由 vextjs-opentelemetry 插件挂载）
     *
     * - `enabled: true`（默认）时插件执行 `app.extend('otel', {...})`，此字段始终有值，
     *   可安全直接访问：`req.app.otel.tracer` 或使用 non-null assertion `req.app.otel!.tracer`
     * - `enabled: false` 时插件提前返回，`app.extend()` 不执行，运行时为 `undefined`，
     *   必须使用 optional chaining：`req.app.otel?.tracer`
     *
     * 在路由 handler 或 service 中访问 tracer/meter/metrics：
     * @example
     * // enabled: true（默认）— 直接访问
     * const { tracer } = req.app.otel!;
     * const span = tracer.startSpan("db.query");
     *
     * // enabled: false — optional chaining 防御
     * req.app.otel?.tracer.startSpan("db.query");
     */
    otel?: OtelAppExtension;
  }

  interface VextConfig {
    /**
     * OpenTelemetry 插件配置（由 vextjs-opentelemetry 插件读取）
     *
     * 也可在 opentelemetryPlugin(options) 工厂函数参数中配置，
     * 两者功能相同，工厂函数参数优先级更高。
     */
    otel?: {
      serviceName?: string;
      enabled?: boolean;
    };
  }
}
