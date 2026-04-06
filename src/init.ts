/**
 * src/init.ts
 *
 * 框架无关的 OTel SDK 初始化入口（esbuild 打包为 CJS，--require 友好）
 *
 * 用法（消费方，如 chat/app/otel-init.cjs）：
 *   const { initOtel } = require('vextjs-opentelemetry/init');
 *   const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
 *   initOtel({
 *     serviceName: 'my-app',
 *     endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || 'host:port',
 *     instrumentations: [new MongoDBInstrumentation()],
 *   });
 *
 * endpoint 格式决定传输模式：
 *   'host:port'  → h2c gRPC（Node.js 原生 http2，兼容自建采集器）
 *   'none' / ''  → 不上报（SDK 初始化，context propagation 生效，数据被丢弃）
 *
 * h2c gRPC 设计说明：
 *   @grpc/grpc-js 与部分自建采集器的 h2c（明文 HTTP/2）握手不兼容。
 *   本实现直接使用 node:http2，三路协议会话（Trace/Metric/Log）独立管理，
 *   断连自动重建（单例工厂 + onClose 回调）。
 */

import os from "node:os";
import http2 from "node:http2";

import type { ClientHttp2Session } from "node:http2";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableLogRecord, LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { ExportResult } from "@opentelemetry/core";

import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { metrics } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { ProtobufTraceSerializer, ProtobufMetricsSerializer, ProtobufLogsSerializer } from "@opentelemetry/otlp-transformer";

// ── 公开接口 ──────────────────────────────────────────────────

export interface InitOptions {
    /** 服务名称，写入 Resource service.name */
    serviceName: string;
    /**
     * 上报端点（格式决定传输模式）：
     *   - `'host:port'`  → h2c gRPC（原生 http2，兼容自建采集器）
     *   - `'none'` / `''` → 不上报（安全默认值）
     */
    endpoint?: string;
    /**
     * 仪表化插件实例列表（由调用方负责实例化与传入）。
     * @example
     *   [new MongoDBInstrumentation(), new IORedisInstrumentation()]
     */
    instrumentations?: Instrumentation[];
    /** Metric 周期性上报间隔（ms）。默认 `30000` */
    metricExportIntervalMs?: number;
    /**
     * 注入到 `globalThis` 的 OTel Logger key。
     * 需与 `createOtelLogBridge()` 读取的 key 保持一致。默认 `'_otelLogger'`
     */
    globalLoggerKey?: string;
}

// ── 内部工具 ──────────────────────────────────────────────────

function otelLog(msg: string): void {
    process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function buildResource(serviceName: string) {
    return resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        "deployment.environment": process.env.NODE_ENV ?? "production",
        "host.name": os.hostname(),
        "telemetry.sdk.language": "nodejs",
        "webengine.name": "egg.js",
    });
}

// ── h2c gRPC 会话管理 ─────────────────────────────────────────

type SessionFactory = () => ClientHttp2Session;

/**
 * 创建惰性单例 h2c 会话工厂。
 * 首次调用时建立连接；会话关闭后自动标记为 null，下次调用时重新建立。
 */
function makeSessionFactory(baseUrl: string): SessionFactory {
    let session: ClientHttp2Session | null = null;

    return () => {
        if (!session || session.destroyed) {
            const s = http2.connect(baseUrl);
            s.on("error", () => { }); // 防止未捕获异常崩溃进程
            s.on("close", () => {
                session = null;
            });
            session = s;
        }
        return session;
    };
}

/**
 * 发送 gRPC Unary RPC（h2c，明文 HTTP/2）。
 * 消息帧格式：[压缩标志 1B][消息长度 4B][Protobuf 消息体]
 */
function grpcSend(
    getSession: SessionFactory,
    path: string,
    body: Uint8Array,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const frame = Buffer.allocUnsafe(5 + body.length);
        frame[0] = 0; // 不压缩
        frame.writeUInt32BE(body.length, 1);
        Buffer.from(body).copy(frame, 5);

        const req = getSession().request({
            ":method": "POST",
            ":path": path,
            "content-type": "application/grpc+proto",
            te: "trailers",
        });

        const timer = setTimeout(() => reject(new Error("grpcSend timeout 10s")), 10_000);
        let grpcStatus: string | number | null = null;

        req.on("trailers", (t) => {
            grpcStatus = t["grpc-status"];
        });
        req.on("response", () => {
            req.on("data", () => { }); // 消费响应体，防止流阻塞
        });
        req.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        req.on("close", () => {
            clearTimeout(timer);
            if (grpcStatus === "0" || grpcStatus === 0) resolve();
            else reject(new Error(`gRPC status ${grpcStatus}`));
        });
        req.end(frame);
    });
}

// ── h2c gRPC Exporter 工厂 ────────────────────────────────────

const TRACE_PATH = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";
const METRIC_PATH = "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";
const LOG_PATH = "/opentelemetry.proto.collector.logs.v1.LogsService/Export";

function makeH2cTraceExporter(getSession: SessionFactory): SpanExporter {
    return {
        export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
            const body = ProtobufTraceSerializer.serializeRequest(spans);
            if (!body?.length) {
                cb({ code: ExportResultCode.SUCCESS });
                return;
            }
            grpcSend(getSession, TRACE_PATH, body)
                .then(() => {
                    otelLog("[otel] Trace export SUCCESS (grpc-status:0)");
                    cb({ code: ExportResultCode.SUCCESS });
                })
                .catch((err: Error) => {
                    otelLog(`[otel] Trace export FAILED: ${err.message}`);
                    cb({ code: ExportResultCode.FAILED, error: err });
                });
        },
        shutdown: () => Promise.resolve(),
    };
}

function makeH2cMetricExporter(getSession: SessionFactory): PushMetricExporter {
    return {
        export(rm: ResourceMetrics, cb: (r: ExportResult) => void): void {
            const body = ProtobufMetricsSerializer.serializeRequest(rm);
            if (!body?.length) {
                cb({ code: ExportResultCode.SUCCESS });
                return;
            }
            grpcSend(getSession, METRIC_PATH, body)
                .then(() => {
                    otelLog("[otel] Metric export SUCCESS (grpc-status:0)");
                    cb({ code: ExportResultCode.SUCCESS });
                })
                .catch((err: Error) => {
                    otelLog(`[otel] Metric export FAILED: ${err.message}`);
                    cb({ code: ExportResultCode.FAILED, error: err });
                });
        },
        selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
    };
}

function makeH2cLogExporter(getSession: SessionFactory): LogRecordExporter {
    return {
        export(logs: ReadableLogRecord[], cb: (r: ExportResult) => void): void {
            const body = ProtobufLogsSerializer.serializeRequest(logs);
            if (!body?.length) {
                cb({ code: ExportResultCode.SUCCESS });
                return;
            }
            grpcSend(getSession, LOG_PATH, body)
                .then(() => {
                    otelLog("[otel] Log export SUCCESS (grpc-status:0)");
                    cb({ code: ExportResultCode.SUCCESS });
                })
                .catch((err: Error) => {
                    otelLog(`[otel] Log export FAILED: ${err.message}`);
                    cb({ code: ExportResultCode.FAILED, error: err });
                });
        },
        shutdown: () => Promise.resolve(),
    };
}

// ── Noop Exporters（endpoint = 'none'）────────────────────────

const noopSpanExporter: SpanExporter = {
    export: (_spans, cb) => cb({ code: ExportResultCode.SUCCESS }),
    shutdown: () => Promise.resolve(),
};

const noopMetricExporter: PushMetricExporter = {
    export: (_rm, cb) => cb({ code: ExportResultCode.SUCCESS }),
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
};

const noopLogExporter: LogRecordExporter = {
    export: (_logs, cb) => cb({ code: ExportResultCode.SUCCESS }),
    shutdown: () => Promise.resolve(),
};

// ── initOtel ──────────────────────────────────────────────────

/**
 * 初始化 OTel SDK（Trace + Metric + Log）。
 *
 * 各 SDK 独立 try/catch，任一初始化失败不影响其他 SDK。
 * 适合在应用主模块加载前通过 `--require` 调用。
 */
export function initOtel(options: InitOptions): void {
    const {
        serviceName,
        endpoint = "none",
        instrumentations = [],
        metricExportIntervalMs = 30_000,
        globalLoggerKey = "_otelLogger",
    } = options;

    const trimmed = endpoint.trim();
    const isNone = trimmed === "none" || trimmed === "";
    const isGrpc = !isNone;

    const baseUrl = `http://${trimmed}`;
    const resource = buildResource(serviceName);

    // 为三路协议各自创建独立的 h2c 会话工厂（互不干扰）
    const sessions = isGrpc
        ? {
            trace: makeSessionFactory(baseUrl),
            metric: makeSessionFactory(baseUrl),
            log: makeSessionFactory(baseUrl),
        }
        : null;

    // 进程退出时销毁 h2c 会话，避免端口占用
    if (sessions) {
        process.once("beforeExit", () => {
            try {
                sessions.trace().destroy();
            } catch (_) { }
            try {
                sessions.metric().destroy();
            } catch (_) { }
            try {
                sessions.log().destroy();
            } catch (_) { }
        });
    }

    const modeLabel = isGrpc ? `${baseUrl} (h2c gRPC)` : "noop";
    const instrNames = instrumentations
        .map((i) => i.instrumentationName ?? "?")
        .join("/");

    // ── Trace SDK ──────────────────────────────────────────────
    try {
        const traceExporter = isGrpc
            ? makeH2cTraceExporter(sessions!.trace)
            : noopSpanExporter;

        const provider = new NodeTracerProvider({
            resource,
            spanProcessors: [new BatchSpanProcessor(traceExporter)],
        });
        provider.register();

        if (instrumentations.length > 0) {
            registerInstrumentations({ instrumentations });
        }

        otelLog(
            `[otel] Trace SDK initialized → ${modeLabel}` +
            (instrNames ? ` [${instrNames}]` : ""),
        );
        process.env.VEXT_OTEL_SDK_STARTED = "1";
        if (isGrpc) process.env.VEXT_OTEL_EXPORT_MODE = "grpc";
    } catch (e) {
        otelLog(`[otel] Trace SDK init skipped: ${(e as Error).message}`);
    }

    // ── Metric SDK ─────────────────────────────────────────────
    try {
        const metricExporter = isGrpc
            ? makeH2cMetricExporter(sessions!.metric)
            : noopMetricExporter;

        const meterProvider = new MeterProvider({
            resource,
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: metricExportIntervalMs,
                }),
            ],
        });
        metrics.setGlobalMeterProvider(meterProvider);

        otelLog(`[otel] Metric SDK initialized → ${modeLabel}`);
    } catch (e) {
        otelLog(`[otel] Metric SDK init skipped: ${(e as Error).message}`);
    }

    // ── Log SDK ────────────────────────────────────────────────
    try {
        const logExporter = isGrpc
            ? makeH2cLogExporter(sessions!.log)
            : noopLogExporter;

        const loggerProvider = new LoggerProvider({
            resource,
            processors: [new BatchLogRecordProcessor(logExporter)],
        });

        (globalThis as Record<string, unknown>)[globalLoggerKey] =
            loggerProvider.getLogger(serviceName);

        otelLog(`[otel] Log SDK initialized → ${modeLabel}`);
    } catch (e) {
        otelLog(`[otel] Log SDK init skipped: ${(e as Error).message}`);
    }
}
