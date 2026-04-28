// src/core/config.ts
// SDK 配置读取器
//
// 配置来源优先级（高→低）：
//   1. 消费应用 package.json 的 vext.otel.*
//   2. OTel 标准环境变量（OTEL_SERVICE_NAME / OTEL_EXPORTER_OTLP_ENDPOINT 等）
//   3. 消费应用 package.json.name（serviceName 回退）
//   4. 内置默认值

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OtelConfig } from "./types.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";

interface PackageJsonOtelConfig {
  serviceName?: string;
  endpoint?: string;
  protocol?: string;
  headers?: Record<string, string>;
  sampling?: { ratio?: number };
  metricIntervalMs?: number;
}

interface AppPackageJson {
  name?: string;
  vext?: {
    otel?: PackageJsonOtelConfig;
  };
}

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

function resolveProtocol(value: unknown): "http" | "grpc" | undefined {
  if (value === "grpc") return "grpc";
  if (typeof value === "string" && value.startsWith("http")) return "http";
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

function readAppPackageJson(): AppPackageJson | undefined {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    return JSON.parse(raw) as AppPackageJson;
  } catch {
    return undefined;
  }
}

function resolvePackageOtelConfig() {
  const packageJson = readAppPackageJson();
  const packageOtel = packageJson?.vext?.otel;
  const packageName =
    packageJson?.name && packageJson.name !== "vextjs-opentelemetry"
      ? packageJson.name
      : undefined;

  const headers = packageOtel?.headers;
  const normalizedHeaders =
    headers && typeof headers === "object"
      ? Object.fromEntries(
          Object.entries(headers).filter(
            ([key, value]) =>
              typeof key === "string" && typeof value === "string",
          ),
        )
      : undefined;

  return {
    packageName,
    serviceName: packageOtel?.serviceName,
    endpoint: packageOtel?.endpoint,
    protocol: resolveProtocol(packageOtel?.protocol),
    headers:
      normalizedHeaders && Object.keys(normalizedHeaders).length > 0
        ? normalizedHeaders
        : undefined,
    samplingRatio:
      typeof packageOtel?.sampling?.ratio === "number" &&
      packageOtel.sampling.ratio >= 0 &&
      packageOtel.sampling.ratio <= 1
        ? packageOtel.sampling.ratio
        : undefined,
    metricIntervalMs:
      typeof packageOtel?.metricIntervalMs === "number" &&
      packageOtel.metricIntervalMs > 0
        ? packageOtel.metricIntervalMs
        : undefined,
  };
}

// ── 主函数 ────────────────────────────────────────────────────

/**
 * 解析完整 OTel SDK 配置
 *
 * 优先级：package.json vext.otel.* > OTel 标准环境变量 > package.json.name > 内置默认值
 */
export function resolveOtelConfig(): OtelConfig {
  const packageConfig = resolvePackageOtelConfig();
  const serviceName =
    packageConfig.serviceName ??
    process.env.OTEL_SERVICE_NAME ??
    packageConfig.packageName ??
    DEFAULT_SERVICE_NAME;

  const endpoint =
    packageConfig.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "none";

  const protocol: "http" | "grpc" =
    packageConfig.protocol ?? resolveProtocolFromEnv() ?? "http";

  const headers = packageConfig.headers ?? parseHeadersFromEnv();

  const samplingRatio = (() => {
    if (packageConfig.samplingRatio !== undefined)
      return packageConfig.samplingRatio;
    const envRatio = parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? "");
    if (!isNaN(envRatio) && envRatio >= 0 && envRatio <= 1) return envRatio;
    return 1.0;
  })();

  const metricIntervalMs = (() => {
    if (packageConfig.metricIntervalMs !== undefined)
      return packageConfig.metricIntervalMs;
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
