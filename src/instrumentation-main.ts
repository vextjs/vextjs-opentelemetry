// Internal continuation for the public instrumentation preload entry.
//
// This module intentionally loads after instrumentation.ts has registered the
// ESM hook. Keep SDK and configuration imports here so they cannot preempt
// hook registration.

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
