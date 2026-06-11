import type {
  Instrumentation,
  InstrumentationConfig,
} from "@opentelemetry/instrumentation";

import { headersToEnvString } from "./config.js";
import {
  createFileLogExporter,
  createFileMetricExporter,
  createFileSpanExporter,
  resolveExportMode,
  tryCreateGrpcExporters,
} from "./exporter.js";
import { getDeferredState } from "./deferred.js";
import { formatStartupExportDesc, shouldLogStartupSummary } from "./startup-log.js";
import type { ExportMode, OtelConfig } from "./types.js";

interface SdkRuntimeState {
  started: boolean;
  startPromise?: Promise<void>;
}

const SDK_RUNTIME_KEY = Symbol.for("vextjs-opentelemetry.v1.sdk-runtime");

function getRuntimeState(): SdkRuntimeState {
  const globalState = globalThis as Record<symbol, SdkRuntimeState | undefined>;
  globalState[SDK_RUNTIME_KEY] ??= { started: process.env.VEXT_OTEL_SDK_STARTED === "1" };
  return globalState[SDK_RUNTIME_KEY];
}

export function isOtelSdkStarted(): boolean {
  return getRuntimeState().started || process.env.VEXT_OTEL_SDK_STARTED === "1";
}

export interface StartOtelSdkOptions {
  exportMode?: ExportMode;
  exportDir?: string;
}

export async function startOtelSdk(
  config: OtelConfig,
  options: StartOtelSdkOptions = {},
): Promise<void> {
  const runtime = getRuntimeState();
  if (runtime.started) return;
  if (runtime.startPromise) return runtime.startPromise;

  runtime.startPromise = startOtelSdkOnce(config, options)
    .then(() => {
      runtime.started = true;
    })
    .catch((error) => {
      runtime.startPromise = undefined;
      throw error;
    });

  return runtime.startPromise;
}

function toOtlpHttpBase(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/$/, "").replace(/^grpc:\/\//, "");
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `http://${normalized}`;
}

async function startOtelSdkOnce(
  config: OtelConfig,
  options: StartOtelSdkOptions,
): Promise<void> {
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

  if (config.headers && Object.keys(config.headers).length > 0) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = headersToEnvString(config.headers);
  }

  const manualResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    "deployment.environment": process.env.NODE_ENV ?? "development",
  });
  const detectedResource = detectResources({ detectors: [processDetector, envDetector] });
  const resource = detectedResource.merge(manualResource);

  const { ratio } = config.sampling;
  const samplerOption =
    ratio < 1.0
      ? { sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }) }
      : {};

  const deferredState = getDeferredState();
  const resolvedExport =
    options.exportMode !== undefined
      ? { mode: options.exportMode, dir: options.exportDir }
      : resolveExportMode(config.endpoint, config.protocol);
  const { mode: exportMode, dir: exportDir } = resolvedExport;
  const httpBase = exportMode === "otlp-http" || exportMode === "otlp-grpc"
    ? toOtlpHttpBase(config.endpoint)
    : config.endpoint;

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
          new OTLPTraceExporter({ url: `${httpBase}/v1/traces` }),
        ),
      );
      deferredState.metricExporter.configure(
        new OTLPMetricExporter({ url: `${httpBase}/v1/metrics` }),
      );
    }
    deferredState.logProcessor.configure(
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${httpBase}/v1/logs` }),
      ),
    );
  } else if (exportMode === "otlp-http") {
    deferredState.spanProcessor.configure(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${httpBase}/v1/traces` }),
      ),
    );
    deferredState.metricExporter.configure(
      new OTLPMetricExporter({ url: `${httpBase}/v1/metrics` }),
    );
    deferredState.logProcessor.configure(
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${httpBase}/v1/logs` }),
      ),
    );
  }

  process.env.VEXT_OTEL_EXPORT_MODE = exportMode;
  process.env.VEXT_OTEL_PROTOCOL = config.protocol;
  process.env.OTEL_SERVICE_NAME = config.serviceName;
  process.env.VEXT_OTEL_SERVICE_NAME = config.serviceName;
  if (exportDir) process.env.VEXT_OTEL_EXPORT_DIR = exportDir;
  if (ratio !== 1.0) process.env.OTEL_TRACES_SAMPLER_ARG = String(ratio);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [deferredState.logProcessor],
  });
  const { logs: otelLogs } = await import("@opentelemetry/api-logs");
  otelLogs.setGlobalLoggerProvider(loggerProvider);

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

  const sdk = new NodeSDK(sdkOptions);
  sdk.start();

  process.env.VEXT_OTEL_SDK_STARTED = "1";
  delete process.env.VEXT_OTEL_PRELOAD_DISABLED;
  delete process.env.VEXT_OTEL_PRELOAD_DISABLED_REASON;
  delete process.env.VEXT_OTEL_PRELOAD_SKIPPED;
  delete process.env.VEXT_OTEL_PRELOAD_SKIPPED_REASON;
  if (getNodeAutoInstrumentations) {
    process.env.VEXT_OTEL_AUTO_INSTRUMENTATION = "1";
  }

  if (shouldLogStartupSummary(exportMode)) {
    const exportDesc = formatStartupExportDesc(
      exportMode,
      exportDir,
      config.endpoint,
      config.protocol,
    );

    console.log(
      `[vextjs-opentelemetry] SDK initialized` +
        (getNodeAutoInstrumentations ? " (with auto-instrumentation)" : "") +
        ` → ${exportDesc}`,
    );
  }

  const shutdownHandler = () => {
    Promise.all([sdk.shutdown(), loggerProvider.shutdown()])
      .then(() => console.log("[vextjs-opentelemetry] SDK shutdown complete"))
      .catch((err: Error) =>
        console.error("[vextjs-opentelemetry] SDK shutdown error:", err.message),
      );
  };
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);
}
