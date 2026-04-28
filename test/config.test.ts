import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOtelConfig } from "../src/core/config.js";

const originalCwd = process.cwd();
const managedEnvKeys = [
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_TRACES_SAMPLER_ARG",
  "OTEL_METRIC_EXPORT_INTERVAL",
] as const;

function withTempPackageJson(content: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "otel-config-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(content, null, 2),
    "utf8",
  );
  process.chdir(dir);
  return dir;
}

function clearManagedEnv() {
  for (const key of managedEnvKeys) {
    delete process.env[key];
  }
}

afterEach(() => {
  process.chdir(originalCwd);
  clearManagedEnv();
});

describe("resolveOtelConfig", () => {
  it("无显式 serviceName 时优先回退到消费应用 package.json 的 name", () => {
    const dir = withTempPackageJson({ name: "admin" });

    try {
      const config = resolveOtelConfig();
      expect(config.serviceName).toBe("admin");
      expect(config.endpoint).toBe("none");
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("package.json vext.otel 配置优先于环境变量", () => {
    process.env.OTEL_SERVICE_NAME = "env-service";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://env-collector:4318";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer%20env";
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.1";
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "30000";

    const dir = withTempPackageJson({
      name: "admin",
      vext: {
        otel: {
          serviceName: "package-service",
          endpoint: "collector:4317",
          protocol: "grpc",
          headers: {
            authorization: "Bearer package",
          },
          sampling: {
            ratio: 0.5,
          },
          metricIntervalMs: 5000,
        },
      },
    });

    try {
      const config = resolveOtelConfig();
      expect(config).toEqual({
        serviceName: "package-service",
        endpoint: "collector:4317",
        protocol: "grpc",
        headers: {
          authorization: "Bearer package",
        },
        sampling: {
          ratio: 0.5,
        },
        metricIntervalMs: 5000,
      });
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("当前工作目录就是插件仓库自身时，默认值仍保持 vext-app", () => {
    const dir = withTempPackageJson({ name: "vextjs-opentelemetry" });

    try {
      const config = resolveOtelConfig();
      expect(config.serviceName).toBe("vext-app");
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
