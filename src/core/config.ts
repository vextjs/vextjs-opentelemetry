// src/core/config.ts
// SDK 配置读取器
//
// 配置来源优先级（高→低）：
//   1. OTel 标准环境变量（OTEL_SERVICE_NAME / OTEL_EXPORTER_OTLP_ENDPOINT 等）
//   2. 内置默认值

import type { OtelConfig } from "./types.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";

// ── 协议解析 ──────────────────────────────────────────────────

/**
 * 从 OTEL_EXPORTER_OTLP_PROTOCOL 环境变量解析协议
 * OTel 标准值：http/protobuf（→ http）、grpc（→ grpc）
 */
function resolveProtocolFromEnv(): "http" | "grpc" | undefined {
  const proto = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (!proto) return undefined;
  if (proto === "grpc") return "grpc";
  if (proto.startsWith("http")) return "http";
  return undefined;
}

// ── 请求头解析 ────────────────────────────────────────────────

/**
 * 从 OTEL_EXPORTER_OTLP_HEADERS 环境变量解析请求头
 * 格式：key1=value1,key2=value2
 */
function parseHeadersFromEnv(): Record<string, string> | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!raw) return undefined;
  try {
    const result: Record<string, string> = {};
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        result[decodeURIComponent(pair.slice(0, idx).trim())] =
          decodeURIComponent(pair.slice(idx + 1).trim());
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

// ── 主函数 ────────────────────────────────────────────────────

/**
 * 解析完整 OTel SDK 配置
 *
 * 优先级：OTel 标准环境变量 > 内置默认值
 */
export function resolveOtelConfig(): OtelConfig {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "none";

  const protocol: "http" | "grpc" = resolveProtocolFromEnv() ?? "http";

  const headers = parseHeadersFromEnv();

  const samplingRatio = (() => {
    const envRatio = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? "");
    if (!isNaN(envRatio) && envRatio >= 0 && envRatio <= 1) return envRatio;
    return 1.0;
  })();

  const metricIntervalMs = (() => {
    const env = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? "", 10);
    if (!isNaN(env) && env > 0) return env;
    return 15000;
  })();

  return {
    serviceName,
    endpoint,
    protocol,
    headers,
    sampling: { ratio: samplingRatio },
    metricIntervalMs,
  };
}

/** 将 headers 对象序列化为 OTLP 标准格式（key=value,key=value）*/
export function headersToEnvString(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join(",");
}
