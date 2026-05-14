import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock instances ─────────────────────────────────────────────────

const {
  mockSpan,
  mockGetActiveSpan,
  mockHistogram,
  mockCounter,
  mockUpDownCounter,
  mockMeter,
  mockGetMeter,
} = vi.hoisted(() => {
  const span = {
    isRecording: vi.fn(() => true),
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    updateName: vi.fn(),
    spanContext: vi.fn(() => ({
      traceId: "abc123",
      spanId: "def456",
    })),
  };
  const histogram = { record: vi.fn() };
  const counter = { add: vi.fn() };
  const upDownCounter = { add: vi.fn() };
  const meter = {
    createHistogram: vi.fn(() => histogram),
    createCounter: vi.fn(() => counter),
    createUpDownCounter: vi.fn(() => upDownCounter),
  };
  return {
    mockSpan: span,
    mockGetActiveSpan: vi.fn(() => span as typeof span | undefined),
    mockHistogram: histogram,
    mockCounter: counter,
    mockUpDownCounter: upDownCounter,
    mockMeter: meter,
    mockGetMeter: vi.fn(() => meter),
  };
});

vi.mock("@opentelemetry/api", () => ({
  trace: { getActiveSpan: mockGetActiveSpan },
  metrics: { getMeter: mockGetMeter },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

import { buildCoreHandlers } from "../src/core/http-core.js";
import type { HttpObservationContext } from "../src/core/types.js";

vi.spyOn(console, "warn").mockImplementation(() => {});

// ── 测试工具 ──────────────────────────────────────────────────

function makeCtx(overrides: Partial<HttpObservationContext> = {}): HttpObservationContext {
  return {
    phase: "start",
    method: "GET",
    path: "/test",
    route: undefined,
    requestId: "req-001",
    headers: { "x-tenant-id": "abc" },
    ...overrides,
  };
}

describe("buildCoreHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(mockSpan as never);
  });

  // ── onRequestStart ──────────────────────────────────────────

  describe("onRequestStart", () => {
    it("应返回包含 shouldTrace=true 和 activeSpan 的 state", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      expect(state.shouldTrace).toBe(true);
      expect(state.activeSpan).toBe(mockSpan);
      expect(state.startTime).toBeGreaterThan(0);
    });

    it("ignorePaths 字符串完全匹配时 shouldTrace=false 且 shouldMetric=false", () => {
      const handlers = buildCoreHandlers({ tracing: { ignorePaths: ["/health"] } });
      const state = handlers.onRequestStart(makeCtx({ path: "/health" }), undefined);
      expect(state.shouldTrace).toBe(false);
      expect(state.shouldMetric).toBe(false);
    });

    it("ignorePaths 正则匹配时 shouldTrace=false 且 shouldMetric=false", () => {
      const handlers = buildCoreHandlers({ tracing: { ignorePaths: [/^\/internal\//] } });
      const state = handlers.onRequestStart(makeCtx({ path: "/internal/debug" }), undefined);
      expect(state.shouldTrace).toBe(false);
      expect(state.shouldMetric).toBe(false);
    });

    it("tracing.enabled=false 时 shouldTrace=false", () => {
      const handlers = buildCoreHandlers({ tracing: { enabled: false } });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      expect(state.shouldTrace).toBe(false);
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("调用 httpActiveRequests.add(1)", () => {
      const handlers = buildCoreHandlers({});
      handlers.onRequestStart(makeCtx(), undefined);
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(1, { "http.method": "GET" });
    });

    it("SDK 未初始化（span 为 undefined）时不崩溃", () => {
      mockGetActiveSpan.mockReturnValueOnce(undefined);
      const handlers = buildCoreHandlers({});
      expect(() => handlers.onRequestStart(makeCtx(), undefined)).not.toThrow();
    });

    it("span.isRecording()=false 时不设置属性", () => {
      mockSpan.isRecording.mockReturnValueOnce(false);
      const handlers = buildCoreHandlers({});
      handlers.onRequestStart(makeCtx(), undefined);
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("extraAttributes 函数被调用时注入属性", () => {
      const startAttributes = vi.fn(() => ({ "custom.key": "val" }));
      const handlers = buildCoreHandlers({ tracing: { startAttributes } });
      handlers.onRequestStart(makeCtx(), undefined);
      expect(startAttributes).toHaveBeenCalled();
      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ "custom.key": "val" }),
      );
    });

    it("extraAttributes 函数抛错时不崩溃（降级为空对象）", () => {
      const handlers = buildCoreHandlers({
        tracing: {
          startAttributes: () => {
            throw new Error("boom");
          },
        },
      });
      expect(() => handlers.onRequestStart(makeCtx(), undefined)).not.toThrow();
    });
  });

  // ── onRequestEnd ───────────────────────────────────────────

  describe("onRequestEnd", () => {
    it("200 响应时记录指标且不设置 ERROR 状态", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end", route: "/test/:id" }), 200, undefined);

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 200, "http.route": "/test/:id" }),
      );
      expect(mockHistogram.record).toHaveBeenCalled();
      expect(mockSpan.setStatus).not.toHaveBeenCalled();
    });

    it("4xx 响应时设置 Span ERROR 状态", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 404, undefined);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });

    it("5xx 响应时设置 Span ERROR 状态", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 500, undefined);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });

    it("spanNameResolver 被调用时更新 Span 名称", () => {
      const spanNameResolver = vi.fn(() => "GET /test/:id");
      const handlers = buildCoreHandlers({ tracing: { spanNameResolver } });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end", route: "/test/:id" }), 200, undefined);
      expect(spanNameResolver).toHaveBeenCalled();
      expect(mockSpan.updateName).toHaveBeenCalledWith("GET /test/:id");
    });

    it("activeRequests.add(-1) 应被调用", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 200, undefined);
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(-1, { "http.method": "GET" });
    });

    it("metrics.labels 函数附加到指标标签", () => {
      const handlers = buildCoreHandlers({
        metrics: { labels: () => ({ "tenant.id": "xyz" }) },
      });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 200, undefined);
      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "tenant.id": "xyz" }),
      );
    });

    it("shouldTrace=false 时不调用 span 方法", () => {
      const handlers = buildCoreHandlers({ tracing: { ignorePaths: ["/health"] } });
      const state = handlers.onRequestStart(makeCtx({ path: "/health" }), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end", path: "/health" }), 200, undefined);
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
      expect(mockSpan.setStatus).not.toHaveBeenCalled();
    });

    it("endAttributes 在请求结束阶段可读取 raw 并注入额外属性", () => {
      const raw = { framework: "koa" };
      const endAttributes = vi.fn(() => ({ "tenant.plan": "pro" }));
      const handlers = buildCoreHandlers({ tracing: { endAttributes } });
      const state = handlers.onRequestStart(makeCtx(), raw);
      vi.clearAllMocks();

      handlers.onRequestEnd(state, makeCtx({ phase: "end", route: "/users/:id" }), 200, raw);

      expect(endAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "end", route: "/users/:id", statusCode: 200 }),
        raw,
      );
      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.route": "/users/:id",
          "http.status_code": 200,
          "tenant.plan": "pro",
        }),
      );
    });
  });

  // ── onRequestError ─────────────────────────────────────────

  describe("onRequestError", () => {
    it("Error 对象：recordException + setStatus(ERROR)", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      const err = new Error("boom");
      handlers.onRequestError(state, makeCtx({ phase: "end" }), err, undefined);
      expect(mockSpan.recordException).toHaveBeenCalledWith(err);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });

    it("非 Error 对象不崩溃", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      expect(() => handlers.onRequestError(state, makeCtx({ phase: "end" }), "string error", undefined)).not.toThrow();
    });

    it("以 statusCode=500 记录指标", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestError(state, makeCtx({ phase: "end" }), new Error("x"), undefined);
      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 500 }),
      );
    });

    it("activeRequests.add(-1) 应被调用", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestError(state, makeCtx({ phase: "end" }), new Error("x"), undefined);
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(-1, { "http.method": "GET" });
    });

    it("异常路径也会写入 http.route 与 http.status_code", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestError(state, makeCtx({ phase: "end", route: "/orders/:id" }), new Error("x"), undefined);

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.route": "/orders/:id",
          "http.status_code": 500,
        }),
      );
    });

    it("异常路径也会使用 spanNameResolver 更新 Span 名称", () => {
      const spanNameResolver = vi.fn((ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`);
      const handlers = buildCoreHandlers({ tracing: { spanNameResolver } });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestError(state, makeCtx({ phase: "end", route: "/orders/:id" }), new Error("x"), undefined);

      expect(spanNameResolver).toHaveBeenCalledWith(
        expect.objectContaining({ route: "/orders/:id" }),
        undefined,
      );
      expect(mockSpan.updateName).toHaveBeenCalledWith("GET /orders/:id");
    });
  });

  // ── metrics.enabled=false ──────────────────────────────────

  describe("metrics.enabled=false", () => {
    it("不调用任何指标方法", () => {
      const handlers = buildCoreHandlers({ metrics: { enabled: false } });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 200, undefined);
      expect(mockUpDownCounter.add).not.toHaveBeenCalled();
      expect(mockCounter.add).not.toHaveBeenCalled();
      expect(mockHistogram.record).not.toHaveBeenCalled();
    });
  });
});
