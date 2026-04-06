import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

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

import { createHonoMiddleware } from "../../src/adapters/hono.js";

// ── 辅助：构建带中间件的 Hono app 并发请求 ─────────────────

async function sendRequest(
  app: Hono,
  path: string,
  method = "GET",
): Promise<Response> {
  return app.request(`http://localhost${path}`, { method });
}

describe("createHonoMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(mockSpan as never);
  });

  it("200 响应时记录指标", async () => {
    const app = new Hono();
    app.use(createHonoMiddleware());
    app.get("/test", (c) => c.text("ok"));
    await sendRequest(app, "/test");
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.method": "GET", "http.status_code": 200 }),
    );
  });

  it("使用路由模板（/users/:id）而非实际路径", async () => {
    const app = new Hono();
    app.use(createHonoMiddleware());
    app.get("/users/:id", (c) => c.text(c.req.param("id")));
    await sendRequest(app, "/users/42");
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.route": "/users/:id" }),
    );
  });

  it("404 响应时设置 Span ERROR 状态", async () => {
    const app = new Hono();
    app.use(createHonoMiddleware());
    // 不添加任何路由 → 默认 404
    const res = await sendRequest(app, "/not-found");
    expect(res.status).toBe(404);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("ignorePaths 匹配时 span 不被标注（指标仍记录）", async () => {
    const app = new Hono();
    app.use(createHonoMiddleware({ tracing: { ignorePaths: ["/health"] } }));
    app.get("/health", (c) => c.text("ok"));
    await sendRequest(app, "/health");
    // span 标注被跳过（shouldTrace=false — setAttributes 不调用）
    expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    // 但指标仍记录
    expect(mockCounter.add).toHaveBeenCalled();
  });

  it("spanNameResolver 被调用时更新 Span 名称", async () => {
    const resolver = vi.fn((ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`);
    const app = new Hono();
    app.use(createHonoMiddleware({ tracing: { spanNameResolver: resolver } }));
    app.get("/users/:id", (c) => c.text("ok"));
    await sendRequest(app, "/users/1");
    expect(mockSpan.updateName).toHaveBeenCalledWith("GET /users/:id");
  });

  it("返回值为函数（MiddlewareHandler）", () => {
    expect(typeof createHonoMiddleware()).toBe("function");
  });
});
