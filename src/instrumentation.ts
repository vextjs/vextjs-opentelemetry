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

import { resolveOtelConfig } from "./core/config.js";
import { resolveExportMode } from "./core/exporter.js";
import {
  isVextAutoPreload,
  resolvePreloadGate,
  shouldForcePreloadSdk,
  type PreloadSkipReason,
} from "./core/preload-gate.js";
import type { OtelConfig } from "./core/types.js";

function markPreloadSkipped(config: OtelConfig, reason: PreloadSkipReason): void {
  process.env.VEXT_OTEL_SDK_STARTED = "0";
  process.env.VEXT_OTEL_EXPORT_MODE = "none";
  process.env.VEXT_OTEL_PROTOCOL = config.protocol;
  process.env.OTEL_SERVICE_NAME = config.serviceName;
  process.env.VEXT_OTEL_SERVICE_NAME = config.serviceName;
  process.env.VEXT_OTEL_PRELOAD_SKIPPED = "1";
  process.env.VEXT_OTEL_PRELOAD_SKIPPED_REASON = reason;
  if (reason === "otel-sdk-disabled" || reason === "vext-disabled" || reason === "vext-preload-disabled" || reason === "package-disabled") {
    process.env.VEXT_OTEL_PRELOAD_DISABLED = "1";
    process.env.VEXT_OTEL_PRELOAD_DISABLED_REASON = reason;
  }
  if (config.sampling.ratio !== 1.0) {
    process.env.OTEL_TRACES_SAMPLER_ARG = String(config.sampling.ratio);
  }
}

try {
  const config = resolveOtelConfig();
  const gate = resolvePreloadGate(config);

  if (gate.disabled) {
    markPreloadSkipped(config, gate.reason ?? "vext-disabled");
  } else {
    const { mode: exportMode, dir: exportDir } = resolveExportMode(
      config.endpoint,
      config.protocol,
    );
    const forceSdk = shouldForcePreloadSdk(config);

    if (isVextAutoPreload() && !forceSdk) {
      markPreloadSkipped(config, "vext-deferred");
    } else if (exportMode === "none" && !forceSdk) {
      markPreloadSkipped(config, "export-none");
    } else {
      const { startOtelSdk } = await import("./core/sdk-start.js");
      await startOtelSdk(config, { exportMode, exportDir });
    }
  }
} catch (err) {
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

export {};
