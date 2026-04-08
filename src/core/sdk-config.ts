// src/core/sdk-config.ts
// 向已启动的 SDK 配置 Exporter（插件驱动配置）
//
// 设计说明：
//   instrumentation.ts 通过 --import 早于 app 代码加载，以默认 "none"（deferred）模式启动 SDK。
//   各框架适配器（插件）在 setup() 阶段调用 attachExporterToSdk()，
//   配置 DeferredSpanProcessor / DeferredMetricExporter / DeferredLogProcessor 的 delegate，
//   使插件 options 成为 exporter 配置的唯一来源。
//
// OTel SDK v2.x 兼容：
//   v2.x 移除了 addSpanProcessor() / addMetricReader()，不再支持启动后追加。
//   改为通过 globalThis[Symbol.for('vextjs-opentelemetry.v1.deferred')] 共享
//   DeferredSpanProcessor / DeferredMetricExporter / DeferredLogProcessor 实例。
//
// ⚠️  metricIntervalMs 只能在 instrumentation.ts 启动阶段生效（通过
//   OTEL_METRIC_EXPORT_INTERVAL 环境变量配置），插件阶段无法修改已创建的 reader 间隔。

import {
  resolveExportMode,
  createFileSpanExporter,
  createFileMetricExporter,
  createFileLogExporter,
} from "./exporter.js";
import { getDeferredState } from "./deferred.js";

export interface AttachExporterConfig {
  /** 导出目标：文件路径 / OTLP URL / "file" / "none"（同 instrumentation.ts endpoint 语义） */
  endpoint: string;
  /** 上报协议，默认 "http" */
  protocol?: "http" | "grpc";
  /** OTLP 请求头（endpoint 为 HTTP/gRPC URL 时有效） */
  headers?: Record<string, string>;
  /** 服务名（仅更新 getOtelStatus 显示，不改变已启动的 SDK Resource） */
  serviceName?: string;
  /**
   * gRPC 是否使用明文连接（不验证 TLS）
   *
   * - `true`（默认）：禁用 TLS，适合内网 / 自建 Collector（Jaeger、Docker、K8s 内网等）
   * - `false`：启用 TLS，适合公网 / 有证书的 Collector（Grafana Cloud、GCP 等生产环境）
   */
  insecure?: boolean;
}

/**
 * 配置已启动的全局 OTel SDK 的 Exporter（Traces + Metrics + Logs）
 *
 * 调用时机：框架适配器（插件）的 setup() 阶段。
 * 原理：通过 getDeferredState() 获取 instrumentation.ts 创建的三个 Deferred 实例，
 *       将各自的 delegate 设为真正的 exporter/processor。
 *
 * ⚠️  如果 instrumentation.ts 阶段已通过环境变量配置了端点，
 *     Deferred 实例已被配置，此处调用将静默跳过（isConfigured() = true）。
 *
 * @example
 * // VextJS 插件 setup()
 * await attachExporterToSdk({ endpoint: "./otel-data", serviceName: "my-app" });
 *
 * @example
 * // Express 应用启动（直接调用，无需框架插件系统）
 * import { attachExporterToSdk } from "vextjs-opentelemetry";
 * await attachExporterToSdk({ endpoint: process.env.OTEL_ENDPOINT ?? "none" });
 */
export async function attachExporterToSdk(config: AttachExporterConfig): Promise<void> {
  const protocol = config.protocol ?? "http";
  const { mode, dir } = resolveExportMode(config.endpoint, protocol);

  if (mode === "none") return;

  // 更新 serviceName 显示（不影响已启动 SDK 的 Resource，但更新 getOtelStatus 读取的 env var）
  if (config.serviceName) {
    process.env.OTEL_SERVICE_NAME = config.serviceName;
    process.env.VEXT_OTEL_SERVICE_NAME = config.serviceName;
  }

  try {
    const deferredState = getDeferredState();

    // ── file 模式 ────────────────────────────────────────────
    if (mode === "file" && dir) {
      const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
      const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");

      if (!deferredState.spanProcessor.isConfigured()) {
        deferredState.spanProcessor.configure(
          new BatchSpanProcessor(createFileSpanExporter(dir) as never),
        );
      }

      if (!deferredState.metricExporter.isConfigured()) {
        deferredState.metricExporter.configure(createFileMetricExporter(dir) as never);
      }

      if (!deferredState.logProcessor.isConfigured()) {
        deferredState.logProcessor.configure(
          new BatchLogRecordProcessor(createFileLogExporter(dir) as never),
        );
      }

      process.env.VEXT_OTEL_EXPORT_MODE = "file";
      process.env.VEXT_OTEL_EXPORT_DIR = dir;
      return;
    }

    // ── otlp-http 模式 ────────────────────────────────────────
    if (mode === "otlp-http") {
      const [
        { OTLPTraceExporter },
        { OTLPMetricExporter },
        { OTLPLogExporter },
        { BatchSpanProcessor },
        { BatchLogRecordProcessor },
      ] = await Promise.all([
        import("@opentelemetry/exporter-trace-otlp-http"),
        import("@opentelemetry/exporter-metrics-otlp-http"),
        import("@opentelemetry/exporter-logs-otlp-http"),
        import("@opentelemetry/sdk-trace-base"),
        import("@opentelemetry/sdk-logs"),
      ]);

      if (!deferredState.spanProcessor.isConfigured()) {
        deferredState.spanProcessor.configure(
          new BatchSpanProcessor(
            new OTLPTraceExporter({
              url: `${config.endpoint}/v1/traces`,
              headers: config.headers,
            }),
          ),
        );
      }

      if (!deferredState.metricExporter.isConfigured()) {
        deferredState.metricExporter.configure(
          new OTLPMetricExporter({
            url: `${config.endpoint}/v1/metrics`,
            headers: config.headers,
          }),
        );
      }

      if (!deferredState.logProcessor.isConfigured()) {
        deferredState.logProcessor.configure(
          new BatchLogRecordProcessor(
            new OTLPLogExporter({
              url: `${config.endpoint}/v1/logs`,
              headers: config.headers,
            }),
          ),
        );
      }

      process.env.VEXT_OTEL_EXPORT_MODE = "otlp-http";
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = config.endpoint;
    } else if (mode === "otlp-grpc") {
      // ── otlp-grpc 模式 ──────────────────────────────────────────────
      //
      // 实现策略（由 insecure 控制）：
      //
      //   insecure: true（默认）→ node:http2 原生 h2c 实现
      //     @grpc/grpc-js 的 h2c 握手与部分自建 Collector（Jaeger / K8s OTel Collector）
      //     不兼容，会导致 Channel 永远 CONNECTING 直到 DEADLINE_EXCEEDED。
      //     node:http2 直接发 HTTP/2 请求，兼容性更好，适合内网 / 自建 Collector。
      //
      //   insecure: false → @grpc/grpc-js + TLS（createSsl）
      //     标准 TLS gRPC，适合公网 / 有证书的 Collector（Grafana Cloud、GCP 等）。
      //     @grpc/grpc-js 的 TLS 实现才是其强项，且支持 mTLS / 自定义证书扩展。

      const grpcHost = config.endpoint
        .replace(/^(grpc|http|https):\/\//, "")
        .replace(/\/$/, "");
      const useInsecure = config.insecure !== false;

      const [
        { BatchSpanProcessor },
        { BatchLogRecordProcessor },
        { ProtobufTraceSerializer, ProtobufMetricsSerializer, ProtobufLogsSerializer },
        { ExportResultCode },
        { AggregationTemporality },
      ] = await Promise.all([
        import("@opentelemetry/sdk-trace-base"),
        import("@opentelemetry/sdk-logs"),
        import("@opentelemetry/otlp-transformer"),
        import("@opentelemetry/core"),
        import("@opentelemetry/sdk-metrics"),
      ]);

      const TRACE_PATH = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";
      const METRIC_PATH = "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";
      const LOG_PATH = "/opentelemetry.proto.collector.logs.v1.LogsService/Export";

      if (useInsecure) {
        // ── 分支 A：insecure=true → node:http2 h2c（兼容自建 collector）──
        const http2 = await import("node:http2");

        // 惰性单例 h2c 会话工厂（断连自动重建）
        function makeSessionFactory(url: string) {
          let session: ReturnType<typeof http2.connect> | null = null;
          return () => {
            if (!session || session.destroyed) {
              const s = http2.connect(url);
              s.on("error", () => {}); // 防止未捕获异常崩溃进程
              s.on("close", () => { session = null; });
              session = s;
            }
            return session!;
          };
        }

        // gRPC 帧格式：[压缩标志 1B][消息长度 4B][Protobuf 消息体]
        function grpcSend(
          getSession: () => ReturnType<typeof http2.connect>,
          path: string,
          body: Uint8Array,
        ): Promise<void> {
          return new Promise((resolve, reject) => {
            const frame = Buffer.allocUnsafe(5 + body.length);
            frame[0] = 0;
            frame.writeUInt32BE(body.length, 1);
            Buffer.from(body).copy(frame, 5);
            const req = getSession().request({
              ":method": "POST",
              ":path": path,
              "content-type": "application/grpc+proto",
              "te": "trailers",
            });
            const timer = setTimeout(() => reject(new Error("grpcSend timeout 10s")), 10_000);
            let grpcStatus: string | number | null = null;
            req.on("trailers", (t) => { grpcStatus = t["grpc-status"]; });
            req.on("response", () => { req.on("data", () => {}); });
            req.on("error", (err) => { clearTimeout(timer); reject(err); });
            req.on("close", () => {
              clearTimeout(timer);
              if (grpcStatus === "0" || grpcStatus === 0) resolve();
              else reject(new Error(`gRPC status ${grpcStatus ?? "null (no response)"}`));
            });
            req.end(frame);
          });
        }

        const getSession = makeSessionFactory(`http://${grpcHost}`);

        if (!deferredState.spanProcessor.isConfigured()) {
          deferredState.spanProcessor.configure(
            new BatchSpanProcessor({
              export(spans: unknown, cb: (r: { code: number; error?: Error }) => void) {
                const body = ProtobufTraceSerializer.serializeRequest(spans as never);
                if (!body?.length) { cb({ code: ExportResultCode.SUCCESS }); return; }
                grpcSend(getSession, TRACE_PATH, body)
                  .then(() => { console.log("[vextjs-opentelemetry] Trace export OK (grpc h2c)"); cb({ code: ExportResultCode.SUCCESS }); })
                  .catch(err => { console.warn("[vextjs-opentelemetry] Trace export FAILED:", err.message); cb({ code: ExportResultCode.FAILED, error: err }); });
              },
              shutdown() { return Promise.resolve(); },
            } as never),
          );
        }

        if (!deferredState.metricExporter.isConfigured()) {
          deferredState.metricExporter.configure({
            export(metrics: unknown, cb: (result: { code: number; error?: Error }) => void) {
              const body = ProtobufMetricsSerializer.serializeRequest(metrics as never);
              if (!body?.length) { cb({ code: ExportResultCode.SUCCESS }); return; }
              grpcSend(getSession, METRIC_PATH, body)
                .then(() => { console.log("[vextjs-opentelemetry] Metrics export OK (grpc h2c)"); cb({ code: ExportResultCode.SUCCESS }); })
                .catch(err => { console.warn("[vextjs-opentelemetry] Metrics export FAILED:", err.message); cb({ code: ExportResultCode.FAILED, error: err }); });
            },
            shutdown() { return Promise.resolve(); },
            forceFlush() { return Promise.resolve(); },
            selectAggregationTemporality() { return AggregationTemporality.CUMULATIVE; },
          } as never);
        }

        if (!deferredState.logProcessor.isConfigured()) {
          deferredState.logProcessor.configure(
            new BatchLogRecordProcessor({
              export(logs: unknown, cb: (r: { code: number; error?: Error }) => void) {
                const body = ProtobufLogsSerializer.serializeRequest(logs as never);
                if (!body?.length) { cb({ code: ExportResultCode.SUCCESS }); return; }
                grpcSend(getSession, LOG_PATH, body)
                  .then(() => { console.log("[vextjs-opentelemetry] Logs export OK (grpc h2c)"); cb({ code: ExportResultCode.SUCCESS }); })
                  .catch(err => { console.warn("[vextjs-opentelemetry] Logs export FAILED:", err.message); cb({ code: ExportResultCode.FAILED, error: err }); });
              },
              shutdown() { return Promise.resolve(); },
            } as never),
          );
        }

      } else {
        // ── 分支 B：insecure=false → @grpc/grpc-js TLS（公网 / 云端 collector）──
        const [
          { OTLPTraceExporter },
          { OTLPMetricExporter },
          { OTLPLogExporter },
          { credentials: grpcCredentials },
        ] = await Promise.all([
          import("@opentelemetry/exporter-trace-otlp-grpc"),
          import("@opentelemetry/exporter-metrics-otlp-grpc"),
          import("@opentelemetry/exporter-logs-otlp-grpc"),
          import("@grpc/grpc-js"),
        ]);

        const channelCredentials = grpcCredentials.createSsl();

        if (!deferredState.spanProcessor.isConfigured()) {
          deferredState.spanProcessor.configure(
            new BatchSpanProcessor(
              new OTLPTraceExporter({ url: grpcHost, credentials: channelCredentials }),
            ),
          );
        }

        if (!deferredState.metricExporter.isConfigured()) {
          deferredState.metricExporter.configure(
            new OTLPMetricExporter({ url: grpcHost, credentials: channelCredentials }) as never,
          );
        }

        if (!deferredState.logProcessor.isConfigured()) {
          deferredState.logProcessor.configure(
            new BatchLogRecordProcessor(
              new OTLPLogExporter({ url: grpcHost, credentials: channelCredentials }),
            ),
          );
        }
      }

      process.env.VEXT_OTEL_EXPORT_MODE = "otlp-grpc";
      process.env.VEXT_OTEL_PROTOCOL = "grpc";
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = grpcHost;
    }
  } catch (err) {
    console.warn(
      "[vextjs-opentelemetry] attachExporterToSdk failed:",
      (err as Error).message,
    );
  }
}
