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

import { buildCoreHandlers } from "../src/core.js";
import type { OtelHttpContext } from "../src/types.js";

// ── 测试工具 ──────────────────────────────────────────────────

function makeCtx(overrides: Partial<OtelHttpContext> = {}): OtelHttpContext {
  return {
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
      const state = handlers.onRequestStart(makeCtx());
      expect(state.shouldTrace).toBe(true);
      expect(state.activeSpan).toBe(mockSpan);
      expect(state.startTime).toBeGreaterThan(0);
    });

    it("ignorePaths 字符串完全匹配时 shouldTrace=false", () => {
      const handlers = buildCoreHandlers({ tracing: { ignorePaths: ["/health"] } });
      const state = handlers.onRequestStart(makeCtx({ path: "/health" }));
      expect(state.shouldTrace).toBe(false);
    });

    it("ignorePaths 正则匹配时 shouldTrace=false", () => {
      const handlers = buildCoreHandlers({ tracing: { ignorePaths: [/^\/internal\//] } });
      const state = handlers.onRequestStart(makeCtx({ path: "/internal/debug" }));
      expect(state.shouldTrace).toBe(false);
    });

    it("tracing.enabled=false 时 shouldTrace=false", () => {
      const handlers = buildCoreHandlers({ tracing: { enabled: false } });
      const state = handlers.onRequestStart(makeCtx());
      expect(state.shouldTrace).toBe(false);
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("调用 httpActiveRequests.add(1)", () => {
      const handlers = buildCoreHandlers({});
      handlers.onRequestStart(makeCtx());
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(1, { "http.method": "GET" });
    });

    it("SDK 未初始化（span 为 undefined）时不崩溃", () => {
      mockGetActiveSpan.mockReturnValueOnce(undefined);
      const handlers = buildCoreHandlers({});
      expect(() => handlers.onRequestStart(makeCtx())).not.toThrow();
    });

    it("span.isRecording()=false 时不设置属性", () => {
      mockSpan.isRecording.mockReturnValueOnce(false);
      const handlers = buildCoreHandlers({});
      handlers.onRequestStart(makeCtx());
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("extraAttributes 函数被调用时注入属性", () => {
      const extraAttributes = vi.fn(() => ({ "custom.key": "val" }));
      const handlers = buildCoreHandlers({ tracing: { extraAttributes } });
      handlers.onRequestStart(makeCtx());
      expect(extraAttributes).toHaveBeenCalled();
      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ "custom.key": "val" }),
      );
    });

    it("extraAttributes 函数抛错时不崩溃（降级为空对象）", () => {
      const handlers = buildCoreHandlers({
        tracing: {
          extraAttributes: () => {
            throw new Error("boom");
          },
        },
      });
      expect(() => handlers.onRequestStart(makeCtx())).not.toThrow();
    });
  });

  // ── onRequestEnd ───────────────────────────────────────────

  describe("onRequestEnd", () => {
    it("200 响应时记录指标且不设置 ERROR 状态", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ route: "/test/:id" }), 200);

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 200, "http.route": "/test/:id" }),
      );
      expect(mockHistogram.record).toHaveBeenCalled();
      expect(mockSpan.setStatus).not.toHaveBeenCalled();
    });

    it("4xx 响应时设置 Span ERROR 状态", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx(), 404);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });

    it("5xx 响应时设置 Span ERROR 状态", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx(), 500);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });

    it("spanNameResolver 被调用时更新 Span 名称", () => {
      const spanNameResolver = vi.fn(() => "GET /test/:id");
      const handlers = buildCoreHandlers({ tracing: { spanNameResolver } });
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ route: "/test/:id" }), 200);
      expect(spanNameResolver).toHaveBeenCalled();
      expect(mockSpan.updateName).toHaveBeenCalledWith("GET /test/:id");
    });

    it("activeRequests.add(-1) 应被调用", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx(), 200);
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(-1, { "http.method": "GET" });
    });

    it("customLabels 函数附加到指标标签", () => {
      const handlers = buildCoreHandlers({
        metrics: { customLabels: () => ({ "tenant.id": "xyz" }) },
      });
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx(), 200);
      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "tenant.id": "xyz" }),
      );
    });

    it("shouldTrace=false 时不调用 span 方法", () => {
      const handlers = buildCoreHandlers({ tracing: { ignorePaths: ["/health"] } });
      const state = handlers.onRequestStart(makeCtx({ path: "/health" }));
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx({ path: "/health" }), 200);
      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
      expect(mockSpan.setStatus).not.toHaveBeenCalled();
    });
  });

  // ── onRequestError ─────────────────────────────────────────

  describe("onRequestError", () => {
    it("Error 对象：recordException + setStatus(ERROR)", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      const err = new Error("boom");
      handlers.onRequestError(state, makeCtx(), err);
      expect(mockSpan.recordException).toHaveBeenCalledWith(err);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }),
      );
    });

    it("非 Error 对象不崩溃", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      expect(() => handlers.onRequestError(state, makeCtx(), "string error")).not.toThrow();
    });

    it("以 statusCode=500 记录指标", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestError(state, makeCtx(), new Error("x"));
      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 500 }),
      );
    });

    it("activeRequests.add(-1) 应被调用", () => {
      const handlers = buildCoreHandlers({});
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestError(state, makeCtx(), new Error("x"));
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(-1, { "http.method": "GET" });
    });
  });

  // ── metrics.enabled=false ──────────────────────────────────

  describe("metrics.enabled=false", () => {
    it("不调用任何指标方法", () => {
      const handlers = buildCoreHandlers({ metrics: { enabled: false } });
      const state = handlers.onRequestStart(makeCtx());
      vi.clearAllMocks();
      handlers.onRequestEnd(state, makeCtx(), 200);
      expect(mockUpDownCounter.add).not.toHaveBeenCalled();
      expect(mockCounter.add).not.toHaveBeenCalled();
      expect(mockHistogram.record).not.toHaveBeenCalled();
    });
  });
});
