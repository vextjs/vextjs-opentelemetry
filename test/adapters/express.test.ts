import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";

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

import { createExpressMiddleware } from "../../src/adapters/express.js";

// ── 工具：模拟 Express req/res/next ──────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    path: "/test",
    url: "/test",
    headers: { "x-request-id": "req-001" } as Record<string, string>,
    route: undefined,
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { statusCode: 200 }) as Response & EventEmitter;
}

describe("createExpressMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(mockSpan as never);
  });

  it("调用 next() 让请求继续", () => {
    const mw = createExpressMiddleware();
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(), res as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("res.finish 时记录指标（200）", () => {
    const mw = createExpressMiddleware();
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(), res as Response, next);
    vi.clearAllMocks();
    res.emit("finish");
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.method": "GET", "http.status_code": 200 }),
    );
  });

  it("res.finish 时读取 req.route.path（路由模板）", () => {
    const mw = createExpressMiddleware();
    const next = vi.fn();
    const res = makeRes();
    const req = makeReq({ route: { path: "/test/:id" } as never });
    mw(req, res as Response, next);
    vi.clearAllMocks();
    res.emit("finish");
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.route": "/test/:id" }),
    );
  });

  it("res.error 时调用 onRequestError", () => {
    const mw = createExpressMiddleware();
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq(), res as Response, next);
    vi.clearAllMocks();
    const err = new Error("network");
    res.emit("error", err);
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
  });

  it("ignorePaths 匹配时 span 不被标注", () => {
    const mw = createExpressMiddleware({ tracing: { ignorePaths: ["/health"] } });
    const next = vi.fn();
    const res = makeRes();
    mw(makeReq({ path: "/health" }), res as Response, next);
    vi.clearAllMocks();
    res.emit("finish");
    expect(mockSpan.setAttributes).not.toHaveBeenCalled();
  });

  it("返回值为函数（RequestHandler）", () => {
    expect(typeof createExpressMiddleware()).toBe("function");
  });

  it("options 为空时使用默认值（不崩溃）", () => {
    expect(() => {
      const mw = createExpressMiddleware();
      const res = makeRes();
      mw(makeReq(), res as Response, vi.fn());
    }).not.toThrow();
  });
});
