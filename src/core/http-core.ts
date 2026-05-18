// src/core/http-core.ts
// 框架无关的 HTTP 追踪核心处理器（v1.0.0 重构）
//
// 职责：
//   为各框架适配器提供统一的三阶段钩子（onRequestStart / onRequestEnd / onRequestError），
//   完成 Span 标注、HTTP 指标记录等框架无关逻辑。
//
// 约束：
//   - 仅 import @opentelemetry/api，不 import 任何 SDK 包
//   - 适配器中禁止执行 SDK 初始化

import { trace, metrics as otelMetrics, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type {
  CaptureInput,
  CaptureFieldRule,
  CaptureSourceOptions,
  HttpObservationContext,
  HttpOtelOptions,
  ObservationAttributeMap,
  ObservationAttributeResolver,
  RequestCaptureOptions,
  RequestLifecycleInfo,
} from "./types.js";

// ── 内置默认分桶（毫秒）──────────────────────────────────────

const DEFAULT_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// 请求/响应体大小分桶（字节）：100B / 1KB / 10KB / 100KB / 1MB / 10MB
const DEFAULT_SIZE_BUCKETS = [100, 1_024, 10_240, 102_400, 1_048_576, 10_485_760];

// ── 指标名称（遵循 OTEL 语义约定）──────────────────────────

const METRIC_DURATION  = "http.server.duration";
const METRIC_TOTAL     = "http.server.request.total";
const METRIC_ACTIVE    = "http.server.active_requests";
const METRIC_REQ_SIZE  = "http.server.request.size";
const METRIC_RESP_SIZE = "http.server.response.size";

const DEFAULT_CAPTURE_MAX_VALUE_LENGTH = 256;
const DEFAULT_CAPTURE_MAX_DEPTH = 6;
const DEFAULT_CAPTURE_MAX_ITEMS = 50;
const REDACTED_VALUE = "[REDACTED]";
const DEFAULT_SENSITIVE_KEYS: (string | RegExp)[] = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /pwd/i,
  /session/i,
];

// ── 公开类型 ─────────────────────────────────────────────────

/**
 * onRequestStart 返回的请求状态快照，跨调用传递
 *
 * - startTime：performance.now() 时间戳
 * - shouldTrace：是否进行 Span 标注（ignorePaths 已过滤）
 * - activeSpan：在 onRequestStart 时捕获的 Span 引用；
 *   后续直接引用而非重新调用 trace.getActiveSpan()，
 *   避免 Express res.on('finish') 等回调中 Context 已变更的问题
 */
export interface CoreRequestState {
  readonly startTime: number;
  readonly shouldTrace: boolean;
  readonly shouldMetric: boolean;
  readonly activeSpan: Span | undefined;
}

/** buildCoreHandlers 返回的三阶段处理器 */
export interface CoreHandlers {
  /**
   * 请求开始阶段
   * - 获取当前活跃 Span 并存入 state
   * - 检查 ignorePaths；shouldTrace=false 时后续 Span 操作跳过
   * - 调用 startAttributes（route 可能为 undefined）
   * - 活跃请求数 +1
   */
  onRequestStart(ctx: HttpObservationContext, raw: unknown): CoreRequestState;

  /**
   * 请求成功结束阶段（await next() 或 res.on('finish') 之后）
   * - 更新 http.route、http.status_code
   * - 调用 spanNameResolver（ctx.route 应已由适配器填充）
   * - 设置 Span status（4xx/5xx → ERROR）
   * - 记录 httpRequestDuration / httpRequestTotal
   * - 活跃请求数 -1
   */
  onRequestEnd(state: CoreRequestState, ctx: HttpObservationContext, statusCode: number, raw: unknown): void;

  /**
   * 请求异常阶段（未捕获异常）
   * - recordException + setStatus(ERROR)
   * - 以 statusCode=500 记录指标
   * - 活跃请求数 -1
   */
  onRequestError(state: CoreRequestState, ctx: HttpObservationContext, err: unknown, raw: unknown): void;
}

interface NormalizedCaptureField {
  attributeKey: string;
  sourceKey: string;
  rule: CaptureFieldRule;
}

interface NormalizedCaptureSelection {
  all: boolean;
  fields: NormalizedCaptureField[];
  exclude: (string | RegExp)[];
  sensitiveKeys?: (string | RegExp)[];
  maxValueLength?: number;
  maxDepth: number;
  maxItems: number;
  output: "attributes" | "snapshot" | "both";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCaptureAllSelection(selection: CaptureInput | undefined): selection is true | "*" {
  return selection === true || selection === "*";
}

function isCaptureSourceOptions(selection: CaptureInput | undefined): selection is CaptureSourceOptions {
  if (!isRecord(selection) || Array.isArray(selection)) return false;
  return [
    "mode",
    "fields",
    "exclude",
    "sensitiveKeys",
    "maxValueLength",
    "maxDepth",
    "maxItems",
    "snapshot",
    "output",
  ].some((key) => key in selection);
}

function matchesCaptureKey(
  attributeKey: string,
  sourceKey: string,
  patterns: (string | RegExp)[],
): boolean {
  const candidates = [
    attributeKey,
    sourceKey,
    attributeKey.split(".").pop() ?? attributeKey,
    sourceKey.split(".").pop() ?? sourceKey,
  ];
  return patterns.some((pattern) =>
    candidates.some((candidate) =>
      typeof pattern === "string"
        ? candidate.toLowerCase() === pattern.toLowerCase()
        : pattern.test(candidate),
    ),
  );
}

function shouldExclude(
  attributeKey: string,
  sourceKey: string,
  patterns: (string | RegExp)[],
): boolean {
  return patterns.length > 0 && matchesCaptureKey(attributeKey, sourceKey, patterns);
}

function getEffectiveSensitiveKeys(
  normalized: NormalizedCaptureSelection,
  capture: RequestCaptureOptions<unknown>,
): (string | RegExp)[] {
  return normalized.sensitiveKeys ?? capture.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
}

function getEffectiveMaxValueLength(
  normalized: NormalizedCaptureSelection,
  capture: RequestCaptureOptions<unknown>,
): number {
  return normalized.maxValueLength ?? capture.maxValueLength ?? DEFAULT_CAPTURE_MAX_VALUE_LENGTH;
}

function getValueByPath(source: unknown, sourcePath: string): unknown {
  if (!sourcePath) return undefined;

  if (typeof FormData !== "undefined" && source instanceof FormData) {
    const entry = source.get(sourcePath);
    return typeof entry === "string" ? entry : undefined;
  }

  if (!isRecord(source) && !Array.isArray(source)) return undefined;

  const segments = sourcePath.split(".").filter(Boolean);
  let current: unknown = source;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setValueByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return;

  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

function serializeSnapshot(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length > maxLength ? serialized.slice(0, maxLength) : serialized;
}

function toAttributeValue(
  value: unknown,
  attributeKey: string,
  sourceKey: string,
  rule: CaptureFieldRule,
  capture: RequestCaptureOptions<unknown>,
  normalized?: NormalizedCaptureSelection,
): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;

  const sensitiveKeys = normalized ? getEffectiveSensitiveKeys(normalized, capture) : capture.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  if (rule.redact !== undefined || matchesCaptureKey(attributeKey, sourceKey, sensitiveKeys)) {
    if (typeof rule.redact === "string") return rule.redact;
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      value = value.map((item) => String(item)).join(",");
    } else {
      return undefined;
    }
  }

  if (typeof value === "string") {
    const maxLength = rule.maxLength ?? (normalized ? getEffectiveMaxValueLength(normalized, capture) : capture.maxValueLength ?? DEFAULT_CAPTURE_MAX_VALUE_LENGTH);
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

export function normalizeCaptureSelection(
  selection: CaptureInput | undefined,
): NormalizedCaptureSelection {
  if (!selection) {
    return {
      all: false,
      fields: [],
      exclude: [],
      maxDepth: DEFAULT_CAPTURE_MAX_DEPTH,
      maxItems: DEFAULT_CAPTURE_MAX_ITEMS,
      output: "attributes",
    };
  }
  if (isCaptureAllSelection(selection)) {
    return {
      all: true,
      fields: [],
      exclude: [],
      maxDepth: DEFAULT_CAPTURE_MAX_DEPTH,
      maxItems: DEFAULT_CAPTURE_MAX_ITEMS,
      output: "attributes",
    };
  }
  if (isCaptureSourceOptions(selection)) {
    const fields = selection.fields;
    const normalizedFields = fields
      ? Array.isArray(fields)
        ? fields.map((key) => ({ attributeKey: key, sourceKey: key, rule: {} }))
        : Object.entries(fields).map(([attributeKey, rule]) => ({
            attributeKey,
            sourceKey: rule.from ?? attributeKey,
            rule,
          }))
      : [];
    return {
      all: selection.mode === "all",
      fields: normalizedFields,
      exclude: selection.exclude ?? [],
      sensitiveKeys: selection.sensitiveKeys,
      maxValueLength: selection.maxValueLength,
      maxDepth: selection.maxDepth ?? DEFAULT_CAPTURE_MAX_DEPTH,
      maxItems: selection.maxItems ?? DEFAULT_CAPTURE_MAX_ITEMS,
      output: selection.output ?? (selection.snapshot ? "both" : "attributes"),
    };
  }
  if (Array.isArray(selection)) {
    return {
      all: false,
      fields: selection.map((key) => ({ attributeKey: key, sourceKey: key, rule: {} })),
      exclude: [],
      maxDepth: DEFAULT_CAPTURE_MAX_DEPTH,
      maxItems: DEFAULT_CAPTURE_MAX_ITEMS,
      output: "attributes",
    };
  }
  return {
    all: false,
    fields: Object.entries(selection).map(([attributeKey, rule]) => ({
      attributeKey,
      sourceKey: rule.from ?? attributeKey,
      rule,
    })),
    exclude: [],
    maxDepth: DEFAULT_CAPTURE_MAX_DEPTH,
    maxItems: DEFAULT_CAPTURE_MAX_ITEMS,
    output: "attributes",
  };
}

export function normalizeQueryRecord(
  value: unknown,
): Record<string, string | string[] | undefined> | undefined {
  if (!isRecord(value)) return undefined;

  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      normalized[key] = String(rawValue);
      continue;
    }
    if (Array.isArray(rawValue)) {
      const scalarArray = rawValue.filter(
        (item): item is string | number | boolean =>
          typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      );
      if (scalarArray.length > 0 && scalarArray.length === rawValue.length) {
        normalized[key] = scalarArray.map((item) => String(item));
      }
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeParamsRecord(
  value: unknown,
): Record<string, string | undefined> | undefined {
  if (!isRecord(value)) return undefined;

  const normalized: Record<string, string | undefined> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      normalized[key] = String(rawValue);
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function shouldEmitExpandedAttributes(normalized: NormalizedCaptureSelection): boolean {
  return normalized.output === "attributes" || normalized.output === "both";
}

function shouldEmitSnapshot(normalized: NormalizedCaptureSelection): boolean {
  return normalized.output === "snapshot" || normalized.output === "both";
}

function projectCaptureSource(source: unknown, normalized: NormalizedCaptureSelection): unknown {
  if (normalized.all || normalized.fields.length === 0) return source;

  const projected: Record<string, unknown> = {};
  for (const field of normalized.fields) {
    const rawValue = getValueByPath(source, field.sourceKey);
    if (rawValue !== undefined) {
      setValueByPath(projected, field.attributeKey, rawValue);
    }
  }
  return projected;
}

function sanitizeSnapshotValue(
  value: unknown,
  normalized: NormalizedCaptureSelection,
  capture: RequestCaptureOptions<unknown>,
  currentPath = "",
  depth = 0,
): unknown {
  if (value === undefined) return undefined;
  if (currentPath && shouldExclude(currentPath, currentPath, normalized.exclude)) return undefined;
  if (currentPath && matchesCaptureKey(currentPath, currentPath, getEffectiveSensitiveKeys(normalized, capture))) {
    return REDACTED_VALUE;
  }

  if (typeof value === "string") {
    const maxLength = getEffectiveMaxValueLength(normalized, capture);
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= normalized.maxDepth) return "[Truncated]";
    return value
      .slice(0, normalized.maxItems)
      .map((item, index) => sanitizeSnapshotValue(
        item,
        normalized,
        capture,
        currentPath ? `${currentPath}.${index}` : String(index),
        depth + 1,
      ))
      .filter((item) => item !== undefined);
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    const formDataObject: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      if (typeof entry !== "string") continue;
      const existing = formDataObject[key];
      if (existing === undefined) {
        formDataObject[key] = entry;
      } else if (Array.isArray(existing)) {
        existing.push(entry);
      } else {
        formDataObject[key] = [existing, entry];
      }
    }
    return sanitizeSnapshotValue(formDataObject, normalized, capture, currentPath, depth);
  }
  if (!isRecord(value)) return undefined;
  if (depth >= normalized.maxDepth) return "[Truncated]";

  const sanitized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const childPath = currentPath ? `${currentPath}.${key}` : key;
    const nextValue = sanitizeSnapshotValue(childValue, normalized, capture, childPath, depth + 1);
    if (nextValue !== undefined) {
      sanitized[key] = nextValue;
    }
  }
  return sanitized;
}

function buildSnapshotAttributes(
  attributeName: string,
  source: unknown,
  normalized: NormalizedCaptureSelection,
  capture: RequestCaptureOptions<unknown>,
): ObservationAttributeMap {
  if (!shouldEmitSnapshot(normalized) || source === undefined) return {};

  const snapshotSource = projectCaptureSource(source, normalized);
  const sanitized = sanitizeSnapshotValue(snapshotSource, normalized, capture);
  const serialized = serializeSnapshot(sanitized, getEffectiveMaxValueLength(normalized, capture));
  if (!serialized || serialized === "{}" || serialized === "[]") return {};

  return { [attributeName]: serialized };
}

function flattenBodyAttributes(
  value: unknown,
  currentPath: string,
  depth: number,
  attributes: ObservationAttributeMap,
  normalized: NormalizedCaptureSelection,
  capture: RequestCaptureOptions<unknown>,
): void {
  if (value === undefined || value === null) return;
  if (currentPath && shouldExclude(currentPath, currentPath, normalized.exclude)) return;
  if (currentPath && matchesCaptureKey(currentPath, currentPath, getEffectiveSensitiveKeys(normalized, capture))) {
    attributes[`http.request.body.${currentPath}`] = REDACTED_VALUE;
    return;
  }

  if (Array.isArray(value)) {
    if (depth >= normalized.maxDepth) return;
    for (const [index, item] of value.slice(0, normalized.maxItems).entries()) {
      const nextPath = currentPath ? `${currentPath}.${index}` : String(index);
      flattenBodyAttributes(item, nextPath, depth + 1, attributes, normalized, capture);
    }
    return;
  }

  if (typeof FormData !== "undefined" && value instanceof FormData) {
    const formDataObject: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      if (typeof entry !== "string") continue;
      const existing = formDataObject[key];
      if (existing === undefined) {
        formDataObject[key] = entry;
      } else if (Array.isArray(existing)) {
        existing.push(entry);
      } else {
        formDataObject[key] = [existing, entry];
      }
    }
    flattenBodyAttributes(formDataObject, currentPath, depth, attributes, normalized, capture);
    return;
  }

  if (isRecord(value)) {
    if (depth >= normalized.maxDepth) return;
    for (const [key, childValue] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      flattenBodyAttributes(childValue, nextPath, depth + 1, attributes, normalized, capture);
    }
    return;
  }

  if (!currentPath) return;
  const attributeValue = toAttributeValue(value, currentPath, currentPath, {}, capture, normalized);
  if (attributeValue !== undefined) {
    attributes[`http.request.body.${currentPath}`] = attributeValue;
  }
}

function resolveSelectionAttributes(
  prefix: string,
  selection: CaptureInput | undefined,
  source: Record<string, unknown> | undefined,
  capture: RequestCaptureOptions<unknown>,
  snapshotAttributeName: string,
): ObservationAttributeMap {
  if (!selection || !source) return {};

  const normalized = normalizeCaptureSelection(selection);
  const attributes: ObservationAttributeMap = {};

  if (shouldEmitExpandedAttributes(normalized)) {
    if (normalized.all) {
      for (const [key, rawValue] of Object.entries(source)) {
        if (shouldExclude(key, key, normalized.exclude)) continue;
        const attributeValue = toAttributeValue(rawValue, key, key, {}, capture, normalized);
        if (attributeValue !== undefined) {
          attributes[`${prefix}${key}`] = attributeValue;
        }
      }
    } else {
      for (const field of normalized.fields) {
        if (shouldExclude(field.attributeKey, field.sourceKey, normalized.exclude)) continue;
        const rawValue = source[field.sourceKey];
        const attributeValue = toAttributeValue(rawValue, field.attributeKey, field.sourceKey, field.rule, capture, normalized);
        if (attributeValue !== undefined) {
          attributes[`${prefix}${field.attributeKey}`] = attributeValue;
        }
      }
    }
  }

  return {
    ...attributes,
    ...buildSnapshotAttributes(snapshotAttributeName, source, normalized, capture),
  };
}

function resolveBodyAttributes(
  selection: CaptureInput | undefined,
  body: unknown,
  capture: RequestCaptureOptions<unknown>,
): ObservationAttributeMap {
  if (!selection || body === undefined) return {};

  const normalized = normalizeCaptureSelection(selection);
  const attributes: ObservationAttributeMap = {};

  if (shouldEmitExpandedAttributes(normalized)) {
    if (normalized.all) {
      flattenBodyAttributes(body, "", 0, attributes, normalized, capture);
    } else {
      for (const field of normalized.fields) {
        if (shouldExclude(field.attributeKey, field.sourceKey, normalized.exclude)) continue;
        const rawValue = getValueByPath(body, field.sourceKey);
        const attributeValue = toAttributeValue(
          rawValue,
          field.attributeKey,
          field.sourceKey,
          field.rule,
          capture,
          normalized,
        );
        if (attributeValue !== undefined) {
          attributes[`http.request.body.${field.attributeKey}`] = attributeValue;
        }
      }
    }
  }

  return {
    ...attributes,
    ...buildSnapshotAttributes("request.body.raw", body, normalized, capture),
  };
}

export function resolveCapturedAttributes(
  ctx: HttpObservationContext,
  capture: RequestCaptureOptions<unknown> | undefined,
): ObservationAttributeMap {
  if (!capture) return {};

  if (ctx.phase === "start") {
    return resolveSelectionAttributes(
      "http.request.header.",
      capture.headers,
      ctx.headers as Record<string, unknown> | undefined,
      capture,
      "request.headers.raw",
    );
  }

  return {
    ...resolveSelectionAttributes(
      "http.request.query.",
      capture.query,
      ctx.query as Record<string, unknown> | undefined,
      capture,
      "request.query.raw",
    ),
    ...resolveSelectionAttributes(
      "http.request.param.",
      capture.params,
      ctx.params as Record<string, unknown> | undefined,
      capture,
      "request.params.raw",
    ),
    ...resolveBodyAttributes(capture.body, ctx.body, capture),
  };
}

// ── 工厂函数 ─────────────────────────────────────────────────

/**
 * 构建框架无关的 HTTP 追踪处理器
 *
 * 每次调用适配器工厂函数时调用一次，内部自动创建 Meter + 指标对象。
 *
 * @param options 通用追踪选项（HttpOtelOptions）
 * @param meterName 可选 meter 名称，默认 "vextjs-opentelemetry-http"
 */
export function buildCoreHandlers<TRaw = unknown>(
  options: HttpOtelOptions<TRaw>,
  meterName = "vextjs-opentelemetry-http",
): CoreHandlers {
  const metricsEnabled = options.metrics?.enabled !== false;
  const tracingEnabled = options.tracing?.enabled !== false;
  const serviceName = options.serviceName ?? "http-app";
  const ignorePaths = options.tracing?.ignorePaths ?? [];
  const labelsFn = options.metrics?.labels;
  const startAttributesFn = options.tracing?.startAttributes;
  const endAttributesFn = options.tracing?.endAttributes;
  const spanNameResolver = options.tracing?.spanNameResolver;
  const lifecycle = options.lifecycle;
  const capture = options.capture;

  // 指标创建（SDK 未初始化时为 Noop，isRecording=false，全部静默）
  const meter = otelMetrics.getMeter(meterName);
  const durationBuckets = options.metrics?.durationBuckets ?? DEFAULT_DURATION_BUCKETS;
  const httpRequestDuration = meter.createHistogram(METRIC_DURATION, {
    description: "HTTP server request duration (ms)",
    unit: "ms",
    advice: { explicitBucketBoundaries: durationBuckets },
  });
  const httpRequestTotal = meter.createCounter(METRIC_TOTAL, {
    description: "Total HTTP server requests",
  });
  const httpActiveRequests = meter.createUpDownCounter(METRIC_ACTIVE, {
    description: "Current active HTTP server requests",
  });
  const httpRequestSize = meter.createHistogram(METRIC_REQ_SIZE, {
    description: "HTTP server request body size (bytes)",
    unit: "By",
    advice: { explicitBucketBoundaries: DEFAULT_SIZE_BUCKETS },
  });
  const httpResponseSize = meter.createHistogram(METRIC_RESP_SIZE, {
    description: "HTTP server response body size (bytes)",
    unit: "By",
    advice: { explicitBucketBoundaries: DEFAULT_SIZE_BUCKETS },
  });

  function isIgnoredPath(urlPath: string): boolean {
    return ignorePaths.some((pattern) =>
      typeof pattern === "string" ? pattern === urlPath : pattern.test(urlPath),
    );
  }

  function resolveLabels(ctx: HttpObservationContext, raw: TRaw): Record<string, string | number | boolean> {
    if (!labelsFn) return {};
    try {
      return typeof labelsFn === "function" ? labelsFn(ctx, raw) : labelsFn;
    } catch {
      console.warn("[vextjs-opentelemetry] metrics.labels resolver threw an error, using defaults");
      return {};
    }
  }

  function resolveAttributes(
    resolver: ObservationAttributeResolver<TRaw> | undefined,
    ctx: HttpObservationContext,
    raw: TRaw,
  ): ObservationAttributeMap {
    if (!resolver) return {};
    try {
      return typeof resolver === "function" ? resolver(ctx, raw) : resolver;
    } catch {
      console.warn("[vextjs-opentelemetry] attribute resolver threw an error, using defaults");
      return {};
    }
  }

  function invokeLifecycleStart(ctx: HttpObservationContext, raw: TRaw): void {
    if (!lifecycle?.onStart) return;
    try {
      lifecycle.onStart(ctx, raw);
    } catch (e) {
      console.warn("[vextjs-opentelemetry] lifecycle.onStart threw:", (e as Error).message ?? e);
    }
  }

  function invokeLifecycleEnd(ctx: HttpObservationContext, raw: TRaw, info: RequestLifecycleInfo): void {
    if (!lifecycle?.onEnd) return;
    try {
      lifecycle.onEnd(ctx, raw, info);
    } catch (e) {
      console.warn("[vextjs-opentelemetry] lifecycle.onEnd threw:", (e as Error).message ?? e);
    }
  }

  function getTraceId(activeSpan: Span | undefined): string {
    try {
      return activeSpan?.spanContext?.().traceId ?? "";
    } catch {
      return "";
    }
  }

  return {
    onRequestStart(ctx: HttpObservationContext, raw: TRaw): CoreRequestState {
      const startTime = performance.now();

      const shouldTrace = tracingEnabled && !isIgnoredPath(ctx.path);
      const shouldMetric = metricsEnabled && !isIgnoredPath(ctx.path);
      const activeSpan = trace.getActiveSpan();
      const startCtx: HttpObservationContext = {
        ...ctx,
        phase: "start",
        route: ctx.route,
        statusCode: undefined,
        latencyMs: undefined,
      };

      if (shouldMetric) {
        httpActiveRequests.add(1, { "http.method": startCtx.method });
        if (startCtx.requestSize !== undefined) {
          httpRequestSize.record(startCtx.requestSize, { "http.method": startCtx.method });
        }
      }

      invokeLifecycleStart(startCtx, raw);

      if (shouldTrace && activeSpan?.isRecording()) {
        const captured = resolveCapturedAttributes(startCtx, capture as RequestCaptureOptions<unknown> | undefined);
        const extra = resolveAttributes(startAttributesFn, startCtx, raw);
        activeSpan.setAttributes({
          "http.request_id": startCtx.requestId ?? "",
          "vext.service": serviceName,
          ...captured,
          ...extra,
        });
      }

      return { startTime, shouldTrace, shouldMetric, activeSpan };
    },

    onRequestEnd(state: CoreRequestState, ctx: HttpObservationContext, statusCode: number, raw: TRaw): void {
      const duration = Math.round(performance.now() - state.startTime);
      const route = ctx.route ?? ctx.path;
      const finalCtx: HttpObservationContext = {
        ...ctx,
        phase: "end",
        route,
        statusCode,
        latencyMs: duration,
      };

      if (state.shouldTrace && state.activeSpan?.isRecording()) {
        const captured = resolveCapturedAttributes(finalCtx, capture as RequestCaptureOptions<unknown> | undefined);
        const late = resolveAttributes(endAttributesFn, finalCtx, raw);
        state.activeSpan.setAttributes({
          "http.route": route,
          "http.status_code": statusCode,
          ...captured,
          ...late,
        });

        if (spanNameResolver) {
          state.activeSpan.updateName(spanNameResolver(finalCtx, raw));
        }

        if (statusCode >= 400) {
          state.activeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${statusCode}`,
          });
        }
      }

      if (state.shouldMetric) {
        const labels = {
          "http.method": finalCtx.method,
          "http.status_code": statusCode,
          "http.route": route,
          ...resolveLabels(finalCtx, raw),
        };
        httpRequestTotal.add(1, labels);
        httpRequestDuration.record(duration, labels);
        httpActiveRequests.add(-1, { "http.method": finalCtx.method });
        if (finalCtx.responseSize !== undefined) {
          httpResponseSize.record(finalCtx.responseSize, { "http.method": finalCtx.method, "http.status_code": statusCode });
        }
      }

      if (lifecycle?.onEnd) {
        invokeLifecycleEnd(finalCtx, raw, {
          traceId: getTraceId(state.activeSpan),
          statusCode,
          latencyMs: duration,
        });
      }
    },

    onRequestError(state: CoreRequestState, ctx: HttpObservationContext, err: unknown, raw: TRaw): void {
      const duration = Math.round(performance.now() - state.startTime);
      const route = ctx.route ?? ctx.path;
      const finalCtx: HttpObservationContext = {
        ...ctx,
        phase: "end",
        route,
        statusCode: 500,
        latencyMs: duration,
      };

      if (state.shouldTrace && state.activeSpan?.isRecording()) {
        const captured = resolveCapturedAttributes(finalCtx, capture as RequestCaptureOptions<unknown> | undefined);
        const late = resolveAttributes(endAttributesFn, finalCtx, raw);
        state.activeSpan.setAttributes({
          "http.route": route,
          "http.status_code": 500,
          ...captured,
          ...late,
        });
        if (spanNameResolver) {
          state.activeSpan.updateName(spanNameResolver(finalCtx, raw));
        }
        if (err instanceof Error) {
          state.activeSpan.recordException(err);
        }
        state.activeSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (state.shouldMetric) {
        const labels = {
          "http.method": finalCtx.method,
          "http.status_code": 500,
          "http.route": route,
          ...resolveLabels(finalCtx, raw),
        };
        httpRequestTotal.add(1, labels);
        httpRequestDuration.record(duration, labels);
        httpActiveRequests.add(-1, { "http.method": finalCtx.method });
      }

      if (lifecycle?.onEnd) {
        invokeLifecycleEnd(finalCtx, raw, {
          traceId: getTraceId(state.activeSpan),
          statusCode: 500,
          latencyMs: duration,
          error: err,
        });
      }
    },
  };
}
