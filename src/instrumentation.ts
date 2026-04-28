// src/instrumentation.ts
//
// OpenTelemetry SDK 初始化入口（v1.0.0 重构）
//
// 唯一推荐初始化方式：
//   node --import vextjs-opentelemetry/instrumentation server.js
//
// 框架 CLI 等价（自动注入）：
//   vext start / vext dev
//
// Docker / K8s 环境变量方式：
//   ENV NODE_OPTIONS="--import vextjs-opentelemetry/instrumentation"
//
// 配置来源（优先级从高到低）：
//   1. 消费应用 package.json 的 vext.otel.*
//   2. OTel 标准环境变量（OTEL_SERVICE_NAME / OTEL_EXPORTER_OTLP_ENDPOINT 等）
//   3. 消费应用 package.json.name（serviceName 回退）
//   4. 内置默认值（serviceName: "vext-app", protocol: "http", endpoint: "none"）

import type {
  Instrumentation,
  InstrumentationConfig,
} from "@opentelemetry/instrumentation";

import { resolveOtelConfig, headersToEnvString } from "./core/config.js";
import {
  resolveExportMode,
  createFileSpanExporter,
  createFileMetricExporter,
  createFileLogExporter,
  tryCreateGrpcExporters,
} from "./core/exporter.js";
import { getDeferredState } from "./core/deferred.js";

let sdkStarted = false;

try {
  const config = resolveOtelConfig();

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { OTLPLogExporter },
    { PeriodicExportingMetricReader },
    { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
    { BatchLogRecordProcessor, LoggerProvider },
    autoInstrumentationsResult,
    { resourceFromAttributes, detectResources, processDetector, envDetector },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/auto-instrumentations-node").catch(() => ({
      getNodeAutoInstrumentations: null,
    })),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  const { getNodeAutoInstrumentations } = autoInstrumentationsResult as {
    getNodeAutoInstrumentations:
      | ((config?: Record<string, unknown>) => Instrumentation<InstrumentationConfig>[])
      | null;
  };

  // ── 注入 headers 到环境变量（供 OTLP exporter 读取）────────
  if (config.headers && Object.keys(config.headers).length > 0) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = headersToEnvString(config.headers);
  }

  // ── Resource 构建 ─────────────────────────────────────────
  const manualResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    "deployment.environment": process.env.NODE_ENV ?? "development",
  });
  const detectedResource = detectResources({ detectors: [processDetector, envDetector] });
  const resource = detectedResource.merge(manualResource);

  // ── 采样率 ───────────────────────────────────────────────
  const { ratio } = config.sampling;
  const samplerOption =
    ratio < 1.0
      ? { sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }) }
      : {};

  // ── 延迟处理器（跨 ESM/CJS 共享，插件 setup 时配置真正的 exporter）─
  const deferredState = getDeferredState();

  // ── 解析导出模式（用于 instrumentation.ts 直接配置时）──────
  const { mode: exportMode, dir: exportDir } = resolveExportMode(
    config.endpoint,
    config.protocol,
  );

  // 若 instrumentation.ts 阶段已有端点配置，立即配置延迟处理器
  if (exportMode === "file" && exportDir) {
    deferredState.spanProcessor.configure(
      new BatchSpanProcessor(createFileSpanExporter(exportDir) as never),
    );
    deferredState.metricExporter.configure(createFileMetricExporter(exportDir) as never);
    deferredState.logProcessor.configure(
      new BatchLogRecordProcessor(createFileLogExporter(exportDir) as never),
    );
  } else if (exportMode === "otlp-grpc") {
    const grpc = await tryCreateGrpcExporters(config.endpoint, config.headers);
    if (grpc.ok) {
      deferredState.spanProcessor.configure(
        new BatchSpanProcessor(grpc.traceExporter as never),
      );
      deferredState.metricExporter.configure(grpc.metricExporter as never);
    } else {
      deferredState.spanProcessor.configure(
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` }),
        ),
      );
      deferredState.metricExporter.configure(
        new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics` }),
      );
    }
    // gRPC 模式 Logs 降级为 HTTP
    deferredState.logProcessor.configure(
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${config.endpoint}/v1/logs` }),
      ),
    );
  } else if (exportMode === "otlp-http") {
    deferredState.spanProcessor.configure(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` }),
      ),
    );
    deferredState.metricExporter.configure(
      new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics` }),
    );
    deferredState.logProcessor.configure(
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${config.endpoint}/v1/logs` }),
      ),
    );
  }
  // exportMode === "none" → deferred 保持未配置（等待插件 setup 配置）

  // 写入环境变量信号供 getOtelStatus() 读取
  process.env.VEXT_OTEL_EXPORT_MODE = exportMode;
  process.env.VEXT_OTEL_PROTOCOL = config.protocol;
  process.env.OTEL_SERVICE_NAME = config.serviceName;
  process.env.VEXT_OTEL_SERVICE_NAME = config.serviceName;
  if (exportDir) process.env.VEXT_OTEL_EXPORT_DIR = exportDir;
  if (ratio !== 1.0) process.env.OTEL_TRACES_SAMPLER_ARG = String(ratio);

  // ── LoggerProvider（Logs signal）──────────────────────────
  // sdk-logs v0.214+ 不支持 addLogRecordProcessor()，需在构造器传入
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [deferredState.logProcessor],
  });
  // 注册为全局 LoggerProvider（供 logs.getLogger() 使用）
  const { logs: otelLogs } = await import("@opentelemetry/api-logs");
  otelLogs.setGlobalLoggerProvider(loggerProvider);

  // ── SDK 选项（spanProcessors/metricReaders，兼容 v2.x）────
  const deferredMetricReader = new PeriodicExportingMetricReader({
    exporter: deferredState.metricExporter as never,
    exportIntervalMillis: config.metricIntervalMs,
  });

  const sdkOptions: ConstructorParameters<typeof NodeSDK>[0] = {
    ...samplerOption,
    resource,
    spanProcessors: [deferredState.spanProcessor],
    metricReaders: [deferredMetricReader],
  };

  // ── 自动检测（可选）────────────────────────────────────────
  if (getNodeAutoInstrumentations) {
    sdkOptions.instrumentations = getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    });
  } else {
    console.warn(
      "[vextjs-opentelemetry/instrumentation] " +
        "@opentelemetry/auto-instrumentations-node is not installed. " +
        "Auto-instrumentation (HTTP, DB, fetch, etc.) is disabled.\n" +
        "  npm install @opentelemetry/auto-instrumentations-node",
    );
  }

  // ── 启动 SDK ──────────────────────────────────────────────
  const sdk = new NodeSDK(sdkOptions);
  sdk.start();
  sdkStarted = true;

  // 写入 SDK 启动信号
  process.env.VEXT_OTEL_SDK_STARTED = "1";
  if (getNodeAutoInstrumentations) {
    process.env.VEXT_OTEL_AUTO_INSTRUMENTATION = "1";
  }

  const exportDesc =
    exportMode === "none"
      ? "deferred export (waiting for plugin setup or package.json vext.otel.endpoint)"
      : exportMode === "file"
        ? `exporting to ${exportDir}`
        : `exporting to ${config.endpoint} [${config.protocol}]`;

  console.log(
    `[vextjs-opentelemetry] SDK initialized` +
      (getNodeAutoInstrumentations ? " (with auto-instrumentation)" : "") +
      ` → ${exportDesc}`,
  );

  // ── 优雅关闭 ─────────────────────────────────────────────
  const shutdownHandler = () => {
    Promise.all([
      sdk.shutdown(),
      loggerProvider.shutdown(),
    ])
      .then(() => console.log("[vextjs-opentelemetry] SDK shutdown complete"))
      .catch((err: Error) =>
        console.error("[vextjs-opentelemetry] SDK shutdown error:", err.message),
      );
  };
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);
} catch (err) {
  if (!sdkStarted) {
    console.warn(
      "[vextjs-opentelemetry/instrumentation] Failed to initialize SDK:",
      (err as Error).message,
      "\nMake sure the required packages are installed:\n" +
        "  npm install @opentelemetry/sdk-node \\\n" +
        "              @opentelemetry/exporter-trace-otlp-http \\\n" +
        "              @opentelemetry/exporter-metrics-otlp-http \\\n" +
        "              @opentelemetry/exporter-logs-otlp-http \\\n" +
        "              @opentelemetry/sdk-logs",
    );
  }
}

export {};
