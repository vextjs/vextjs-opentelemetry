// src/instrumentation.ts
//
// OpenTelemetry SDK 初始化入口
//
// 用法（在应用启动前通过 --import 加载）：
//   node --import vextjs-opentelemetry/instrumentation server.js
//
// 特性：
//   - 全部使用动态 import，确保缺失 optional peer dep 时优雅降级而非崩溃
//   - 支持 top-level await（需要 "type": "module" 和 target >= ES2022）
//   - 环境变量优先：OTEL_SERVICE_NAME / OTEL_EXPORTER_OTLP_ENDPOINT 等
//   - auto-instrumentations-node 为可选项，未安装时降级并输出 warning

import type {
  Instrumentation,
  InstrumentationConfig,
} from "@opentelemetry/instrumentation";

let sdkStarted = false;

try {
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    autoInstrumentationsResult,
    { Resource },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    // auto-instrumentations-node 为可选 peer dep，未安装时静默降级
    import("@opentelemetry/auto-instrumentations-node").catch(() => ({
      getNodeAutoInstrumentations: null,
    })),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  const { getNodeAutoInstrumentations } = autoInstrumentationsResult as {
    getNodeAutoInstrumentations:
      | ((
          config?: Record<string, unknown>,
        ) => Instrumentation<InstrumentationConfig>[])
      | null;
  };

  // ── 基础配置 ──────────────────────────────────────────────

  const baseEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "vext-app",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    "deployment.environment": process.env.NODE_ENV ?? "development",
  });

  // ── SDK 配置 ──────────────────────────────────────────────

  const sdkOptions: ConstructorParameters<typeof NodeSDK>[0] = {
    resource,
    traceExporter: new OTLPTraceExporter({
      url:
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        `${baseEndpoint}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url:
          process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
          `${baseEndpoint}/v1/metrics`,
      }),
      exportIntervalMillis: Number(
        process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000,
      ),
    }),
  };

  // ── 自动检测（可选）──────────────────────────────────────
  //
  // @opentelemetry/auto-instrumentations-node 为可选 peer dep。
  // 未安装时跳过自动检测，输出 warning 提示用户。
  // 已安装时注入，覆盖 HTTP / fetch / DB / 文件系统等常见操作。

  if (getNodeAutoInstrumentations) {
    // getNodeAutoInstrumentations() 已返回 Instrumentation[]，直接赋值
    sdkOptions.instrumentations = getNodeAutoInstrumentations({
      // fs 检测会产生大量噪音，默认禁用
      "@opentelemetry/instrumentation-fs": { enabled: false },
    });
  } else {
    console.warn(
      "[vextjs-opentelemetry/instrumentation] " +
        "@opentelemetry/auto-instrumentations-node is not installed. " +
        "Auto-instrumentation (HTTP, DB, fetch, etc.) is disabled. " +
        "Install it for full tracing coverage:\n" +
        "  npm install @opentelemetry/auto-instrumentations-node",
    );
  }

  // ── 启动 SDK ──────────────────────────────────────────────

  const sdk = new NodeSDK(sdkOptions);
  sdk.start();
  sdkStarted = true;

  console.log(
    "[vextjs-opentelemetry] SDK initialized" +
      (getNodeAutoInstrumentations ? " (with auto-instrumentation)" : ""),
  );

  // ── 优雅关闭 ─────────────────────────────────────────────
  //
  // vext 框架也会注册 SIGTERM handler 用于 HTTP 服务关闭。
  // 两个 handler 并发执行：
  //   - vext: 完成 onClose 钩子后调用 process.exit(0)
  //   - 此处: 异步执行 sdk.shutdown()，flush 未发送的 span/metric
  //
  // 注意：若 vext shutdown timeout（默认 30s）比 SDK flush 时间短，
  // 可能存在最后一批遥测数据丢失的风险。
  // 生产环境建议将 VextShutdownConfig.timeout 调整为 ≥60s。
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("[vextjs-opentelemetry] SDK shutdown complete"))
      .catch((err: Error) =>
        console.error(
          "[vextjs-opentelemetry] SDK shutdown error:",
          err.message,
        ),
      );
  });
} catch (err) {
  if (!sdkStarted) {
    // SDK 启动失败时，仅输出 warning，不阻止应用启动。
    // 应用将以无遥测状态继续运行（所有 OTEL 操作降级为 Noop）。
    console.warn(
      "[vextjs-opentelemetry/instrumentation] Failed to initialize SDK:",
      (err as Error).message,
      "\nMake sure the required packages are installed:\n" +
        "  npm install @opentelemetry/sdk-node \\\n" +
        "              @opentelemetry/exporter-trace-otlp-http \\\n" +
        "              @opentelemetry/exporter-metrics-otlp-http",
    );
    // 不 throw，允许应用以无 OTEL 状态继续启动
  }
}

// ESM 需要显式导出以作为模块使用
export {};
