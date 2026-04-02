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
//   - 端点读取来源：package.json vext.otel.endpoint（可选，默认 "none"）
//   - 不读取 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量（避免隐式行为）
//   - **默认 none 模式**：未配置 endpoint 时 SDK 初始化但不导出数据（安全默认值）
//   - 支持导出模式：
//       未配置 / "none"             → SDK 初始化但不导出（默认，控制台仅打印一行摘要）
//       绝对路径（推荐）             → 本地文件，如 join(process.cwd(), "otel-data")
//       "./relative/path"           → 相对路径本地文件（基于 process.cwd() 解析）
//       "file:./relative/path"     → 向后兼容 file: 前缀
//       "file:///absolute/path"    → 向后兼容 file:/// 前缀
//       HTTP/HTTPS URL             → 标准 OTLP 网络上报
//   - auto-instrumentations-node 为可选项，未安装时降级并输出 warning

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type {
  Instrumentation,
  InstrumentationConfig,
} from "@opentelemetry/instrumentation";

// ── 导出模式类型 ─────────────────────────────────────────────
type ExportMode = "otlp" | "file" | "none";

/**
 * 解析 endpoint 字符串的导出模式
 *
 * 支持以下格式（按检测顺序）：
 *   - "none"                          → none 模式（SDK 初始化但不导出数据，默认）
 *   - "http://..." / "https://..."    → otlp 模式（标准网络上报）
 *   - "file:./relative" / "file:///"  → file 模式（向后兼容 file: 前缀）
 *   - 绝对路径（如 join(process.cwd(), "otel-data") 的结果）→ file 模式
 *   - 相对路径（"./otel-data"）       → file 模式（基于 process.cwd() 解析）
 *   - 其他                            → otlp 模式（视为 hostname:port）
 */
function resolveExportMode(endpoint: string): {
  mode: ExportMode;
  dir?: string;
} {
  if (endpoint === "none") {
    return { mode: "none" };
  }

  // ── HTTP/HTTPS URL → OTLP 网络上报 ──────────────────────
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return { mode: "otlp" };
  }

  // ── file: 前缀 → file 模式（向后兼容）──────────────────
  if (endpoint.startsWith("file:")) {
    let dir: string;
    if (endpoint.startsWith("file:///")) {
      // 绝对路径: file:///C:/path 或 file:///home/user/path
      try {
        dir = new URL(endpoint).pathname;
        // Windows: URL pathname 可能是 /C:/path，需去掉前导 /
        if (
          process.platform === "win32" &&
          dir.startsWith("/") &&
          dir[2] === ":"
        ) {
          dir = dir.slice(1);
        }
      } catch {
        dir = endpoint.slice(7); // 兜底：直接去掉 file://
      }
    } else {
      // 相对路径: file:./otel-data 或 file:otel-data
      // 去掉 "file:" 前缀，resolve() 自动基于 cwd() 解析为绝对路径
      dir = endpoint.slice(5);
    }
    return { mode: "file", dir: resolve(process.cwd(), dir) };
  }

  // ── 绝对路径 → file 模式 ───────────────────────────────
  // 如 join(process.cwd(), "otel-data") → "E:\project\otel-data" 或 "/home/user/otel-data"
  if (isAbsolute(endpoint)) {
    return { mode: "file", dir: endpoint };
  }

  // ── 相对路径 → file 模式 ───────────────────────────────
  // 如 "./otel-data" 或 "../otel-data"
  if (
    endpoint.startsWith("./") ||
    endpoint.startsWith("../") ||
    endpoint.startsWith(".\\") ||
    endpoint.startsWith("..\\")
  ) {
    return { mode: "file", dir: resolve(process.cwd(), endpoint) };
  }

  // ── 其他 → OTLP 模式（可能是 hostname:port 形式）────
  return { mode: "otlp" };
}

// ── 读取 OTLP 端点 ──────────────────────────────────────────────
//
// 读取来源：package.json vext.otel.endpoint 字段（可选）
//
// 不读取 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量（避免隐式行为导致意外上报）。
// **未配置时默认返回 "none"**：SDK 初始化但不导出数据（安全默认值）。
// 仅在需要网络上报或文件导出时才需配置此字段。
//
function resolveOtlpEndpoint(): string {
  try {
    const pkgPath = join(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(
        readFileSync(pkgPath, "utf-8"),
      ) as Record<string, unknown>;
      const otelField = (
        pkg?.vext as Record<string, unknown> | undefined
      )?.otel as Record<string, unknown> | undefined;
      if (typeof otelField?.endpoint === "string" && otelField.endpoint) {
        return otelField.endpoint;
      }
    }
  } catch {
    // package.json 读取失败时静默降级，不影响启动
  }
  // 默认：none 模式（SDK 初始化但不导出，安全默认值）
  return "none";
}

// ── 读取 OTLP Headers（仅从 package.json 代码级配置）─────────
//
// 唯一配置来源：package.json vext.otel.headers 字段（对象 → key=value,... 格式）
// 不读取 OTEL_EXPORTER_OTLP_HEADERS 环境变量。
//
function resolveOtlpHeaders(): string | undefined {
  try {
    const pkgPath = join(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(
        readFileSync(pkgPath, "utf-8"),
      ) as Record<string, unknown>;
      const otelField = (
        pkg?.vext as Record<string, unknown> | undefined
      )?.otel as Record<string, unknown> | undefined;
      const headers = otelField?.headers as
        | Record<string, string>
        | undefined;
      if (headers && typeof headers === "object") {
        return Object.entries(headers)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join(",");
      }
    }
  } catch {
    // 静默降级
  }
  return undefined;
}

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

  // 返回值始终是 string（默认 "none"）
  const baseEndpoint = resolveOtlpEndpoint();

  // 若 package.json 有 headers 配置，注入为 env var（供 exporter 读取）
  const resolvedHeaders = resolveOtlpHeaders();
  if (resolvedHeaders) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = resolvedHeaders;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "vext-app",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    "deployment.environment": process.env.NODE_ENV ?? "development",
  });

  // ── SDK 配置 ──────────────────────────────────────────────

  const { mode: exportMode, dir: exportDir } = resolveExportMode(baseEndpoint);

  // 设置导出模式信号（供 /_otel/status 读取）
  process.env.VEXT_OTEL_EXPORT_MODE = exportMode;
  if (exportDir) {
    process.env.VEXT_OTEL_EXPORT_DIR = exportDir;
  }

  let sdkOptions: ConstructorParameters<typeof NodeSDK>[0];

  if (exportMode === "none") {
    // ── None 模式：SDK 初始化但不导出数据（默认，安全静默）────
    //
    // Noop exporters 丢弃所有 Span/Metrics，零 I/O 开销。
    // auto-instrumentation 仍生效（ALS trace context 可用），
    // 但不会向控制台、文件或网络输出遥测数据。
    //
    const noopSpanExporter = {
      export(
        _spans: unknown[],
        resultCallback: (result: { code: number }) => void,
      ) {
        resultCallback({ code: 0 }); // SUCCESS, discard silently
      },
      shutdown() { return Promise.resolve(); },
      forceFlush() { return Promise.resolve(); },
    };

    const noopMetricExporter = {
      export(
        _metrics: unknown[],
        resultCallback: (result: { code: number }) => void,
      ) {
        resultCallback({ code: 0 });
      },
      shutdown() { return Promise.resolve(); },
      forceFlush() { return Promise.resolve(); },
      selectAggregationTemporality() { return 1; /* CUMULATIVE */ },
    };

    sdkOptions = {
      resource,
      traceExporter: noopSpanExporter as never,
      metricReader: new PeriodicExportingMetricReader({
        exporter: noopMetricExporter as never,
        exportIntervalMillis: 60000, // 长间隔，noop 无需频繁触发
      }),
    };
  } else if (exportMode === "file" && exportDir) {
    // ── File 模式：写入本地 JSON 文件（本地测试）──────────
    // 路径已由 resolveExportMode 解析为绝对路径（支持相对路径）
    mkdirSync(exportDir, { recursive: true });

    const traceFile = join(exportDir, "traces.jsonl");
    const fileSpanExporter = {
      export(
        spans: Array<{ toJSON?: () => unknown; [key: string]: unknown }>,
        resultCallback: (result: { code: number }) => void,
      ) {
        try {
          for (const span of spans) {
            const data = typeof span.toJSON === "function" ? span.toJSON() : span;
            appendFileSync(traceFile, JSON.stringify(data) + "\n", "utf-8");
          }
          resultCallback({ code: 0 }); // SUCCESS
        } catch {
          resultCallback({ code: 1 }); // FAILED
        }
      },
      shutdown() { return Promise.resolve(); },
      forceFlush() { return Promise.resolve(); },
    };

    const metricsFile = join(exportDir, "metrics.jsonl");
    const fileMetricExporter = {
      export(
        metrics: Array<Record<string, unknown>>,
        resultCallback: (result: { code: number }) => void,
      ) {
        try {
          const timestamp = new Date().toISOString();
          appendFileSync(
            metricsFile,
            JSON.stringify({ timestamp, metrics }) + "\n",
            "utf-8",
          );
          resultCallback({ code: 0 });
        } catch {
          resultCallback({ code: 1 });
        }
      },
      shutdown() { return Promise.resolve(); },
      forceFlush() { return Promise.resolve(); },
      selectAggregationTemporality() { return 1; /* CUMULATIVE */ },
    };

    sdkOptions = {
      resource,
      traceExporter: fileSpanExporter as never,
      metricReader: new PeriodicExportingMetricReader({
        exporter: fileMetricExporter as never,
        exportIntervalMillis: Number(
          process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000,
        ),
      }),
    };
  } else {
    // ── OTLP 模式：标准网络上报 ─────────────────────────────
    sdkOptions = {
      resource,
      traceExporter: new OTLPTraceExporter({
        url: `${baseEndpoint}/v1/traces`,
      }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${baseEndpoint}/v1/metrics`,
        }),
        exportIntervalMillis: Number(
          process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000,
        ),
      }),
    };
  }

  // ── 自动检测（可选）──────────────────────────────────────
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

  // ── SDK 启动信号（供 /_otel/status 接口读取）─────────────
  process.env.VEXT_OTEL_SDK_STARTED = "1";
  if (getNodeAutoInstrumentations) {
    process.env.VEXT_OTEL_AUTO_INSTRUMENTATION = "1";
  }

  console.log(
    "[vextjs-opentelemetry] SDK initialized" +
      (getNodeAutoInstrumentations ? " (with auto-instrumentation)" : "") +
      (exportMode === "none"
        ? " → no export (configure endpoint to enable)"
        : exportMode === "file"
          ? ` → exporting to ${exportDir}`
          : ` → exporting to ${baseEndpoint}`),
  );

  // ── 优雅关闭 ─────────────────────────────────────────────
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("[vextjs-opentelemetry] SDK shutdown complete"))
      .catch((err: Error) =>
        console.error("[vextjs-opentelemetry] SDK shutdown error:", err.message),
      );
  });
} catch (err) {
  if (!sdkStarted) {
    console.warn(
      "[vextjs-opentelemetry/instrumentation] Failed to initialize SDK:",
      (err as Error).message,
      "\nMake sure the required packages are installed:\n" +
        "  npm install @opentelemetry/sdk-node \\\n" +
        "              @opentelemetry/exporter-trace-otlp-http \\\n" +
        "              @opentelemetry/exporter-metrics-otlp-http",
    );
  }
}

// ESM 需要显式导出以作为模块使用
export {};
