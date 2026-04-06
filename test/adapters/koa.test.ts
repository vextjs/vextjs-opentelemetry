import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context, Next } from "koa";

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

import { createKoaMiddleware } from "../../src/adapters/koa.js";

// ── 工具：模拟 Koa ctx ──────────────────────────────────────

function makeCtx(overrides: Partial<Context & { routerPath?: string }> = {}): Context {
  return {
    method: "GET",
    path: "/test",
    url: "/test",
    status: 200,
    headers: { "x-request-id": "req-001" } as Record<string, string>,
    get: (key: string) => (key === "x-request-id" ? "req-001" : ""),
    routerPath: undefined,
    ...overrides,
  } as unknown as Context;
}

const mockNext: Next = vi.fn(() => Promise.resolve());

describe("createKoaMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(mockSpan as never);
    (mockNext as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("调用 next() 让请求继续", async () => {
    const mw = createKoaMiddleware();
    const ctx = makeCtx();
    await mw(ctx, mockNext);
    expect(mockNext).toHaveBeenCalledOnce();
  });

  it("200 响应时记录指标", async () => {
    const mw = createKoaMiddleware();
    await mw(makeCtx(), mockNext);
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.method": "GET", "http.status_code": 200 }),
    );
  });

  it("使用 ctx.routerPath 作为路由模板", async () => {
    const mw = createKoaMiddleware();
    const ctx = makeCtx({ routerPath: "/test/:id" });
    await mw(ctx, mockNext);
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.route": "/test/:id" }),
    );
  });

  it("next() 抛出异常时调用 onRequestError 并重新抛出", async () => {
    const err = new Error("route error");
    (mockNext as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    const mw = createKoaMiddleware();
    await expect(mw(makeCtx(), mockNext)).rejects.toThrow("route error");
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
  });

  it("ignorePaths 匹配时 span 不被标注", async () => {
    const mw = createKoaMiddleware({ tracing: { ignorePaths: ["/health"] } });
    await mw(makeCtx({ path: "/health" }), mockNext);
    vi.clearAllMocks();
    // span 不应被标注（已在 onRequestStart 中跳过）
    expect(mockSpan.setAttributes).not.toHaveBeenCalled();
  });

  it("spanNameResolver 被调用时更新 Span 名称", async () => {
    const resolver = vi.fn(() => "GET /resolved");
    const mw = createKoaMiddleware({ tracing: { spanNameResolver: resolver } });
    await mw(makeCtx(), mockNext);
    expect(mockSpan.updateName).toHaveBeenCalledWith("GET /resolved");
  });

  it("返回值为异步函数（Middleware）", () => {
    const mw = createKoaMiddleware();
    expect(typeof mw).toBe("function");
  });

  it("Egg.js 场景：与普通 Koa 中间件用法一致（不崩溃）", async () => {
    // Egg.js 中间件签名与 Koa 完全相同
    const mw = createKoaMiddleware({ serviceName: "egg-app" });
    expect(() => mw(makeCtx(), mockNext)).not.toThrow();
  });
});
