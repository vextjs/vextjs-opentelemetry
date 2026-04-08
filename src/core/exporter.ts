// src/core/exporter.ts
// 导出器工厂（v1.0.0 重构）
//
// 支持四种模式：
//   none       → SDK 初始化但不上报（默认，安全静默）
//   file       → 写入本地 JSONL 文件（本地测试）
//   otlp-http  → OTLP HTTP 上报（默认协议）
//   otlp-grpc  → OTLP gRPC 上报（需安装可选依赖）
//
// endpoint 值解析规则：
//   "none" 或空        → none 模式
//   "file" / "local"  → file 模式，目录 ./otel-data
//   相对路径 "./xxx"   → file 模式，基于 cwd() 解析
//   绝对路径           → file 模式，直接使用
//   "file:" 前缀       → file 模式（向后兼容）
//   http(s):// URL    → otlp-http 或 otlp-grpc（取决于 protocol）
//   hostname:port     → otlp-http 或 otlp-grpc（取决于 protocol）

import {
  readFileSync as _readFileSync,
  mkdirSync,
  appendFileSync,
  existsSync as _existsSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { ExportMode, OtelConfig } from "./types.js";

// ── endpoint 解析 ─────────────────────────────────────────────

export interface ResolvedExport {
  mode: ExportMode;
  dir?: string; // file 模式下的绝对路径
}

/**
 * 解析 endpoint 字符串的导出模式和目标路径
 */
export function resolveExportMode(
  endpoint: string,
  protocol: "http" | "grpc",
): ResolvedExport {
  const ep = endpoint.trim();

  // ── none ─────────────────────────────────────────────────
  if (!ep || ep === "none") {
    return { mode: "none" };
  }

  // ── 快捷值 ───────────────────────────────────────────────
  if (ep === "file" || ep === "local") {
    return {
      mode: "file",
      dir: resolve(process.cwd(), "otel-data"),
    };
  }

  // ── file: 前缀（向后兼容）────────────────────────────────
  if (ep.startsWith("file:")) {
    let dir: string;
    if (ep.startsWith("file:///")) {
      try {
        dir = new URL(ep).pathname;
        if (process.platform === "win32" && dir.startsWith("/") && dir[2] === ":") {
          dir = dir.slice(1);
        }
      } catch {
        dir = ep.slice(7);
      }
    } else {
      dir = ep.slice(5); // "file:./xxx" → "./xxx"
    }
    return { mode: "file", dir: resolve(process.cwd(), dir) };
  }

  // ── 绝对路径 ─────────────────────────────────────────────
  if (isAbsolute(ep)) {
    return { mode: "file", dir: ep };
  }

  // ── 相对路径 ─────────────────────────────────────────────
  if (
    ep.startsWith("./") ||
    ep.startsWith("../") ||
    ep.startsWith(".\\") ||
    ep.startsWith("..\\")
  ) {
    return { mode: "file", dir: resolve(process.cwd(), ep) };
  }

  // ── HTTP/HTTPS URL 或 hostname:port ───────────────────────
  return {
    mode: protocol === "grpc" ? "otlp-grpc" : "otlp-http",
  };
}

// ── Noop 导出器 ───────────────────────────────────────────────

export function createNoopSpanExporter() {
  return {
    export(_spans: unknown[], resultCallback: (result: { code: number }) => void) {
      resultCallback({ code: 0 });
    },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
  };
}

export function createNoopMetricExporter() {
  return {
    export(_metrics: unknown[], resultCallback: (result: { code: number }) => void) {
      resultCallback({ code: 0 });
    },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
    selectAggregationTemporality() { return 1; /* CUMULATIVE */ },
  };
}

// ── 本地文件导出器 ────────────────────────────────────────────
//
// 集群安全：每个 worker 写入独立文件（traces.<pid>.jsonl）。
// 使用 process.pid 避免多 worker 同时写同一文件导致的数据混乱。
// 分析工具可通过 glob traces.*.jsonl 合并所有 worker 数据。

const PID = process.pid;

export function createFileSpanExporter(exportDir: string) {
  mkdirSync(exportDir, { recursive: true });
  const traceFile = join(exportDir, `traces.${PID}.jsonl`);

  return {
    export(
      spans: Array<Record<string, unknown>>,
      resultCallback: (result: { code: number }) => void,
    ) {
      try {
        for (const span of spans) {
          const ctx =
            typeof (span as Record<string, unknown> & { spanContext?: () => unknown }).spanContext === "function"
              ? (span as { spanContext: () => Record<string, unknown> }).spanContext()
              : undefined;
          const data = {
            traceId: (ctx as Record<string, unknown> | undefined)?.traceId,
            spanId: (ctx as Record<string, unknown> | undefined)?.spanId,
            traceFlags: (ctx as Record<string, unknown> | undefined)?.traceFlags,
            parentSpanId: span.parentSpanId,
            name: span.name,
            kind: span.kind,
            startTime: span.startTime,
            endTime: span.endTime,
            duration: span.duration,
            status: span.status,
            attributes: span.attributes,
            events: span.events,
            links: span.links,
            resource: (span.resource as Record<string, unknown> | undefined)?._attributes,
            instrumentationLibrary: span.instrumentationLibrary,
            droppedAttributesCount: span.droppedAttributesCount,
            droppedEventsCount: span.droppedEventsCount,
            droppedLinksCount: span.droppedLinksCount,
          };
          appendFileSync(traceFile, JSON.stringify(data) + "\n", "utf-8");
        }
        resultCallback({ code: 0 });
      } catch {
        resultCallback({ code: 1 });
      }
    },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
  };
}

export function createFileMetricExporter(exportDir: string) {
  mkdirSync(exportDir, { recursive: true });
  const metricsFile = join(exportDir, `metrics.${PID}.jsonl`);

  return {
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
}

export function createFileLogExporter(exportDir: string) {
  mkdirSync(exportDir, { recursive: true });
  const logFile = join(exportDir, `logs.${PID}.jsonl`);

  return {
    export(
      logRecords: Array<Record<string, unknown>>,
      resultCallback: (result: { code: number }) => void,
    ) {
      try {
        for (const record of logRecords) {
          appendFileSync(logFile, JSON.stringify(record) + "\n", "utf-8");
        }
        resultCallback({ code: 0 });
      } catch {
        resultCallback({ code: 1 });
      }
    },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
  };
}

// ── gRPC 导出器（动态 import，降级处理）─────────────────────

export async function tryCreateGrpcExporters(endpoint: string, headers?: Record<string, string>): Promise<{
  traceExporter: unknown;
  metricExporter: unknown;
  ok: boolean;
}> {
  try {
    const [
      { OTLPTraceExporter },
      { OTLPMetricExporter },
    ] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-grpc"),
      import("@opentelemetry/exporter-metrics-otlp-grpc"),
    ]);

    const grpcOptions = {
      url: endpoint,
      ...(headers ? { metadata: headersToGrpcMetadata(headers) } : {}),
    };

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceExporter: new OTLPTraceExporter(grpcOptions as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metricExporter: new OTLPMetricExporter(grpcOptions as any),
      ok: true,
    };
  } catch {
    console.warn(
      "[vextjs-opentelemetry/instrumentation] gRPC exporters not available. " +
      "Falling back to HTTP.\n" +
      "  npm install @opentelemetry/exporter-trace-otlp-grpc " +
      "@opentelemetry/exporter-metrics-otlp-grpc",
    );
    return { traceExporter: null, metricExporter: null, ok: false };
  }
}

function headersToGrpcMetadata(headers: Record<string, string>) {
  // 动态构建 grpc.Metadata 以避免编译期依赖
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const grpc = require("@grpc/grpc-js") as { Metadata: new () => { add(k: string, v: string): void } };
    const metadata = new grpc.Metadata();
    for (const [k, v] of Object.entries(headers)) {
      metadata.add(k, v);
    }
    return metadata;
  } catch {
    return undefined;
  }
}
