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

    it("capture.headers 在 start 阶段注入请求头属性", () => {
      const handlers = buildCoreHandlers({
        capture: { headers: ["x-tenant-id"] },
      });

      handlers.onRequestStart(makeCtx({ headers: { "x-tenant-id": "tenant-a" } }), undefined);

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.request.header.x-tenant-id": "tenant-a",
        }),
      );
    });

    it("capture.headers 支持显式全量、排除、脱敏与快照", () => {
      const handlers = buildCoreHandlers({
        capture: {
          headers: {
            mode: "all",
            exclude: ["cookie"],
            sensitiveKeys: ["authorization"],
            output: "both",
          },
        },
      });

      handlers.onRequestStart(
        makeCtx({
          headers: {
            authorization: "Bearer token-123",
            cookie: "sid=abc",
            "x-tenant-id": "tenant-a",
          },
        }),
        undefined,
      );

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.request.header.authorization": "[REDACTED]",
          "http.request.header.x-tenant-id": "tenant-a",
          "request.headers.raw": JSON.stringify({
            authorization: "[REDACTED]",
            "x-tenant-id": "tenant-a",
          }),
        }),
      );
      const attrs = mockSpan.setAttributes.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(attrs["http.request.header.cookie"]).toBeUndefined();
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

    it("capture.query/query=true 与 capture.params/params=true 支持显式全量采集", () => {
      const handlers = buildCoreHandlers({
        capture: {
          query: true,
          params: true,
        },
      });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestEnd(
        state,
        makeCtx({
          phase: "end",
          route: "/orders/:id",
          query: { page: "1", tags: ["a", "b"] },
          params: { id: "42", tenantId: "t-1" },
        }),
        200,
        undefined,
      );

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.request.query.page": "1",
          "http.request.query.tags": "a,b",
          "http.request.param.id": "42",
          "http.request.param.tenantId": "t-1",
        }),
      );
    });

    it("capture.body 支持点路径、脱敏、截断，并跳过非标量值", () => {
      const handlers = buildCoreHandlers({
        capture: {
          body: {
            orderNo: {},
            customerId: { from: "customer.id" },
            authToken: { from: "token", redact: true },
            summary: { maxLength: 4 },
            wholeCustomer: { from: "customer" },
          },
        },
      });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestEnd(
        state,
        makeCtx({
          phase: "end",
          route: "/orders/:id",
          body: {
            orderNo: "A001",
            customer: { id: "U1001" },
            token: "secret-token",
            summary: "abcdef",
          },
        }),
        200,
        undefined,
      );

      const attrs = mockSpan.setAttributes.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(attrs).toMatchObject({
        "http.request.body.orderNo": "A001",
        "http.request.body.customerId": "U1001",
        "http.request.body.authToken": "[REDACTED]",
        "http.request.body.summary": "abcd",
      });
      expect(attrs["http.request.body.wholeCustomer"]).toBeUndefined();
    });

    it("capture.body=true 支持递归叶子展开、数组上限、排除与快照", () => {
      const handlers = buildCoreHandlers({
        capture: {
          body: {
            mode: "all",
            exclude: ["password"],
            sensitiveKeys: [/token/i],
            maxItems: 2,
            output: "both",
          },
        },
      });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestEnd(
        state,
        makeCtx({
          phase: "end",
          route: "/orders/:id",
          body: {
            orderNo: "A001",
            items: [
              { sku: "sku-1" },
              { sku: "sku-2" },
              { sku: "sku-3" },
            ],
            authToken: "secret-token",
            password: "pw123",
          },
        }),
        200,
        undefined,
      );

      const attrs = mockSpan.setAttributes.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(attrs).toMatchObject({
        "http.request.body.orderNo": "A001",
        "http.request.body.items.0.sku": "sku-1",
        "http.request.body.items.1.sku": "sku-2",
        "http.request.body.authToken": "[REDACTED]",
        "request.body.raw": JSON.stringify({
          orderNo: "A001",
          items: [{ sku: "sku-1" }, { sku: "sku-2" }],
          authToken: "[REDACTED]",
        }),
      });
      expect(attrs["http.request.body.items.2.sku"]).toBeUndefined();
      expect(attrs["http.request.body.password"]).toBeUndefined();
    });

    it("capture.body.output='snapshot' 时仅输出快照，不展开属性", () => {
      const handlers = buildCoreHandlers({
        capture: {
          body: {
            mode: "all",
            output: "snapshot",
          },
        },
      });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestEnd(
        state,
        makeCtx({
          phase: "end",
          body: { orderNo: "A001", customer: { id: "U1001" } },
        }),
        200,
        undefined,
      );

      const attrs = mockSpan.setAttributes.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(attrs["request.body.raw"]).toBe(JSON.stringify({ orderNo: "A001", customer: { id: "U1001" } }));
      expect(attrs["http.request.body.orderNo"]).toBeUndefined();
    });

    it("用户 endAttributes 与 capture 同名时，用户 resolver 保留最终覆盖权", () => {
      const handlers = buildCoreHandlers({
        capture: { query: true },
        tracing: {
          endAttributes: () => ({ "http.request.query.page": "99" }),
        },
      });
      const state = handlers.onRequestStart(makeCtx(), undefined);
      vi.clearAllMocks();

      handlers.onRequestEnd(
        state,
        makeCtx({ phase: "end", query: { page: "1" } }),
        200,
        undefined,
      );

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.request.query.page": "99",
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
