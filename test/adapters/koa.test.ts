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

function makeCtx(
  overrides: Partial<Context & {
    routerPath?: string;
    query?: unknown;
    params?: unknown;
    request?: Context["request"] & { body?: unknown; length?: number };
  }> = {},
): Context {
  return {
    method: "GET",
    path: "/test",
    url: "/test",
    status: 200,
    headers: { "x-request-id": "req-001" } as Record<string, string>,
    query: { page: "1" },
    params: { id: "42" },
    request: { body: { orderNo: "A001" }, length: 16 },
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

  it("next() 抛出异常时使用 ctx.routerPath 作为路由模板", async () => {
    const err = new Error("route error");
    (mockNext as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    const mw = createKoaMiddleware();

    await expect(mw(makeCtx({ routerPath: "/users/:id" }), mockNext)).rejects.toThrow("route error");

    expect(mockSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "http.route": "/users/:id",
        "http.status_code": 500,
      }),
    );
  });

  it("next() 抛出异常时 spanNameResolver 也使用 ctx.routerPath 重命名", async () => {
    const err = new Error("route error");
    (mockNext as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    const mw = createKoaMiddleware({
      tracing: { spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}` },
    });

    await expect(mw(makeCtx({ routerPath: "/users/:id" }), mockNext)).rejects.toThrow("route error");

    expect(mockSpan.updateName).toHaveBeenCalledWith("GET /users/:id");
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

  it("capture 可从 Koa ctx 映射 query / params / body", async () => {
    const mw = createKoaMiddleware({
      capture: {
        query: true,
        params: true,
        body: ["orderNo"],
      },
    });

    await mw(makeCtx({ routerPath: "/orders/:id" }), mockNext);

    expect(mockSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "http.request.query.page": "1",
        "http.request.param.id": "42",
        "http.request.body.orderNo": "A001",
      }),
    );
  });

  it("capture 在 Koa 中可读取 next() 之后才出现的 params / body", async () => {
    const mw = createKoaMiddleware({
      capture: {
        params: true,
        body: ["orderNo"],
      },
    });
    const ctx = makeCtx({
      params: undefined,
      request: { body: undefined, length: 16 } as Context["request"] & { body?: unknown; length?: number },
      routerPath: undefined,
    });
    const next = vi.fn(async () => {
      (ctx as unknown as { params?: Record<string, string> }).params = { id: "99" };
      (ctx as unknown as { request: { body?: unknown; length?: number } }).request.body = { orderNo: "LATE-001" };
      (ctx as unknown as { routerPath?: string }).routerPath = "/orders/:id";
    });

    await mw(ctx, next);

    expect(mockSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "http.request.param.id": "99",
        "http.request.body.orderNo": "LATE-001",
      }),
    );
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
