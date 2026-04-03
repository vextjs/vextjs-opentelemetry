import type {
  Tracer,
  Meter,
  Histogram,
  Counter,
  UpDownCounter,
  Span,
  SpanOptions,
} from "@opentelemetry/api";
import type { VextRequest } from "vextjs";

// ── 插件配置选项 ─────────────────────────────────────────────

/**
 * opentelemetryPlugin() 工厂函数选项
 *
 * 所有字段均为可选，插件内置合理默认值。
 * 优先级：工厂函数参数 > vext config.otel > 内置默认值
 */
export interface OpenTelemetryPluginOptions {
  /**
   * 服务名称
   *
   * 用于 OTEL tracer/meter 名称及 Resource 的 service.name 属性。
   * 优先级：options.serviceName > config.otel.serviceName > "vext-app"
   */
  serviceName?: string;

  /**
   * OTLP 上报地址（Collector 端点）
   *
   * 由运维/监控平台提供，用于将 Traces 和 Metrics 发送到指定后端。
   *
   * **优先级（高→低）**：
   *   1. 此选项 `otlpEndpoint`（插件工厂函数参数）
   *   2. `app.config.otel?.endpoint`（vext.config.ts 配置）
   *   3. `"none"`（默认，SDK 初始化但不导出数据）
   *
   * **特殊值**：
   *   - 未配置 / `"none"` → SDK 初始化但不导出（安全默认值）
   *   - `join(process.cwd(), "otel-data")` → 存储到项目下 otel-data/ 目录（推荐本地调试）
   *   - `"./otel-data"` → 相对路径形式（自动基于 process.cwd() 解析）
   *   - `"file:./otel-data"` → 向后兼容 file: 前缀
   *   - HTTP/HTTPS URL → 标准 OTLP 网络上报
   *
   * **注意**：SDK 通过 `--import` 在模块加载前初始化，早于插件 `setup()`。
   * 仅在需要网络上报或文件导出时才需在 `package.json` 的
   * `vext.otel.endpoint` 中同步配置。
   *
   * @example
   * // 生产：上报到 Collector
   * opentelemetryPlugin({ otlpEndpoint: "http://otel-collector.internal:4318" })
   * // 本地调试：存储到项目下 otel-data/ 目录
   * import { join } from "node:path";
   * opentelemetryPlugin({ otlpEndpoint: join(process.cwd(), "otel-data") })
   */
  otlpEndpoint?: string;

  /**
   * OTLP 鉴权请求头（适用于需要认证的云厂商后端）
   *
   * 以对象形式配置。推荐在 `package.json` `vext.otel.headers` 中同步配置
   *（vext CLI 传播给 instrumentation.ts）。
   *
   * 优先级：此选项 `otlpHeaders` > `app.config.otel?.headers`
   *
   * @example
   * // New Relic
   * otlpHeaders: { "api-key": "YOUR_LICENSE_KEY" }
   *
   * // Grafana Cloud
   * otlpHeaders: { "Authorization": "Basic YOUR_BASE64_TOKEN" }
   */
  otlpHeaders?: Record<string, string>;

  /**
   * OTel 状态检查接口路径（默认：`"/_otel/status"`）
   *
   * 启动后可访问此接口快速验证 OTel SDK 初始化状态：
   *   GET /_otel/status → { sdk, serviceName, endpoint, autoInstrumentation }
   *
   * 设为 `false` 禁用该接口（生产环境建议在网关层限制访问）。
   *
   * @default "/_otel/status"
   * @example
   * statusEndpoint: "/_otel/health"   // 自定义路径
   * statusEndpoint: false             // 禁用
   */
  statusEndpoint?: string | false;

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

    /**
     * 为每次请求的 HTTP 指标附加自定义业务标签
     *
     * 支持静态对象或函数形式（函数形式可动态读取 req）。
     * 自定义标签会合并到 httpRequestTotal 和 httpRequestDuration 的 labels 中。
     *
     * ⚠️ 注意：避免高基数字段（如 user.id、session.id）作为标签，
     * 高基数标签会导致时间序列数据库资源消耗剧增。
     *
     * 注：不合并到 httpActiveRequests（该指标仅使用 http.method，符合 OTEL 语义约定）。
     *
     * @example
     * // 静态对象形式
     * customLabels: { "tenant.id": "us-east", "env": "prod" }
     *
     * // 函数形式（动态读取）
     * customLabels: (req) => ({ "api.version": req.headers["x-api-version"] ?? "v1" })
     */
    customLabels?:
    | Record<string, string | number | boolean>
    | ((req: VextRequest) => Record<string, string | number | boolean>);
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

  /**
   * 追踪任意操作的辅助方法
   *
   * 对 `tracer.startActiveSpan()` 进行 try/catch/finally 封装：
   * - **成功路径**：`span.end()` 自动调用
   * - **异常路径**：`span.recordException()` + `span.setStatus(ERROR)` + `span.end()` + re-throw
   *
   * `options` 直接为原生 `SpanOptions`（`attributes` / `kind` / `links` 均支持）。
   * `options.attributes` 由 SDK 在 span 创建阶段自动写入，无需在回调内手动调用 `setAttributes()`。
   *
   * @param name    - Span 名称
   * @param fn      - 被追踪的操作（span 实例为可选参数，仅在需要动态属性时才使用）
   * @param options - 原生 SpanOptions，可通过 `attributes` 传静态初始属性
   *
   * @example
   * // 不接触 span（仅追踪生命周期）
   * const result = await req.app.otel!.withSpan("payment.process", () => processPayment(id));
   *
   * // 带静态初始属性（通过 SpanOptions.attributes）
   * const result = await req.app.otel!.withSpan(
   *   "payment.process",
   *   () => processPayment(id),
   *   { attributes: { "payment.provider": "stripe" } },
   * );
   *
   * // 动态属性（依赖回调结果时才需要接收 span）
   * const result = await req.app.otel!.withSpan("payment.process", async (span) => {
   *   const res = await processPayment(id);
   *   span.setAttribute("payment.result", res.status);
   *   return res;
   * });
   */
  withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions,
  ): Promise<T>;
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
      /**
       * OTLP 上报地址（Collector 端点）
       *
       * 写入此字段后 vext CLI 会自动传播，instrumentation 模块在 SDK 初始化时读取。
       *
       * 优先级：`opentelemetryPlugin()` 工厂函数参数 `otlpEndpoint` >
       *         此字段 >
       *         `"none"`（默认）
       *
       * 特殊值：
       *   - 未配置 / `"none"` → SDK 初始化但不导出（安全默认值）
       *   - `"./otel-data"` → 存储到项目下 otel-data/ 目录（自动基于 process.cwd() 解析）
       *   - HTTP/HTTPS URL → 标准 OTLP 网络上报
       *
       * **注意**：仅在需要网络上报或文件导出时配置。
       * 未配置时 SDK 正常工作但不导出数据。
       */
      endpoint?: string;
      /**
       * OTLP 鉴权请求头
       *
       * 以对象形式配置，vext CLI 会传播为 `OTEL_EXPORTER_OTLP_HEADERS` 环境变量。
       * 适用于需要认证的云厂商后端（New Relic、Grafana Cloud 等）。
       *
       * @example
       * headers: { "api-key": "YOUR_LICENSE_KEY" }
       */
      headers?: Record<string, string>;
    };
  }
}
