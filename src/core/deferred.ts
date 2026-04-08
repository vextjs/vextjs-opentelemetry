// src/core/deferred.ts
// 延迟配置的 SpanProcessor + MetricExporter + LogRecordProcessor
//
// 设计说明：
//   OTel SDK v2.x 移除了 addSpanProcessor/addMetricReader（不再允许启动后追加）。
//   为使插件在 setup() 时配置 exporter，采用以下方案：
//     1. instrumentation.ts 用 DeferredSpanProcessor / DeferredMetricExporter 启动 SDK
//     2. 框架适配器（插件）调用 attachExporterToSdk() 时配置真正的 delegate
//     3. 使用 globalThis[Symbol.for(...)] 跨 ESM/CJS 模块边界共享实例

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Span } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { ExportResult } from "@opentelemetry/core";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { AggregationTemporality } from "@opentelemetry/sdk-metrics";

/**
 * SpanProcessor 代理，在 configure() 前静默丢弃所有 span，
 * configure() 后转发给真正的 delegate（如 BatchSpanProcessor）。
 */
export class DeferredSpanProcessor implements SpanProcessor {
  private _delegate: SpanProcessor | null = null;

  configure(delegate: SpanProcessor): void {
    this._delegate = delegate;
  }

  isConfigured(): boolean {
    return this._delegate !== null;
  }

  onStart(span: Span, parentContext: Context): void {
    this._delegate?.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this._delegate?.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    this._delegate?.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this._delegate?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this._delegate?.shutdown() ?? Promise.resolve();
  }
}

/**
 * MetricExporter 代理，在 configure() 前静默丢弃所有 metrics，
 * configure() 后转发给真正的 delegate（如 OTLPMetricExporter / FileMetricExporter）。
 */
export class DeferredMetricExporter implements PushMetricExporter {
  private _delegate: PushMetricExporter | null = null;

  configure(delegate: PushMetricExporter): void {
    this._delegate = delegate;
  }

  isConfigured(): boolean {
    return this._delegate !== null;
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    if (!this._delegate) {
      resultCallback({ code: 0 }); // ExportResultCode.SUCCESS — 静默丢弃
      return;
    }
    this._delegate.export(metrics, resultCallback);
  }

  forceFlush(): Promise<void> {
    return this._delegate?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this._delegate?.shutdown() ?? Promise.resolve();
  }

  selectAggregationTemporality(instrumentType: Parameters<NonNullable<PushMetricExporter["selectAggregationTemporality"]>>[0]): AggregationTemporality {
    return (
      this._delegate?.selectAggregationTemporality?.(instrumentType) ??
      AggregationTemporality.CUMULATIVE
    );
  }
}

/**
 * LogRecordProcessor 代理，在 configure() 前静默丢弃所有 log record，
 * configure() 后转发给真正的 delegate（如 BatchLogRecordProcessor）。
 */
export class DeferredLogProcessor implements LogRecordProcessor {
  private _delegate: LogRecordProcessor | null = null;

  configure(delegate: LogRecordProcessor): void {
    this._delegate = delegate;
  }

  isConfigured(): boolean {
    return this._delegate !== null;
  }

  onEmit(logRecord: SdkLogRecord, context?: Context): void {
    this._delegate?.onEmit(logRecord, context);
  }

  forceFlush(): Promise<void> {
    return this._delegate?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this._delegate?.shutdown() ?? Promise.resolve();
  }
}

// ── 跨 ESM/CJS 共享单例 ──────────────────────────────────────────────────────

const DEFERRED_STATE_KEY = Symbol.for("vextjs-opentelemetry.v1.deferred");

export interface DeferredState {
  spanProcessor: DeferredSpanProcessor;
  metricExporter: DeferredMetricExporter;
  logProcessor: DeferredLogProcessor;
}

/**
 * 获取（或初始化）全局唯一的延迟处理器状态。
 * 使用 Symbol.for 确保 ESM 和 CJS 模块看到同一个实例。
 */
export function getDeferredState(): DeferredState {
  const g = globalThis as Record<symbol, DeferredState | undefined>;
  if (!g[DEFERRED_STATE_KEY]) {
    g[DEFERRED_STATE_KEY] = {
      spanProcessor: new DeferredSpanProcessor(),
      metricExporter: new DeferredMetricExporter(),
      logProcessor: new DeferredLogProcessor(),
    };
  }
  return g[DEFERRED_STATE_KEY]!;
}
