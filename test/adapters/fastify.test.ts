import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

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

import { createFastifyPlugin } from "../../src/adapters/fastify.js";

// ── 辅助：构建 Fastify 实例，注册插件后注入路由 ──────────────

async function buildApp(options = {}) {
  const fastify = Fastify({ logger: false });
  await fastify.register(createFastifyPlugin(options));
  return fastify;
}

describe("createFastifyPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSpan.mockReturnValue(mockSpan as never);
  });

  it("200 响应时记录指标", async () => {
    const fastify = await buildApp();
    fastify.get("/test", async () => "ok");
    await fastify.inject({ method: "GET", url: "/test" });
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.method": "GET", "http.status_code": 200 }),
    );
  });

  it("使用路由模板（/users/:id）而非实际路径", async () => {
    const fastify = await buildApp();
    fastify.get("/users/:id", async (_req, reply) => reply.send("ok"));
    await fastify.inject({ method: "GET", url: "/users/42" });
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.route": "/users/:id" }),
    );
  });

  it("404 响应时设置 Span ERROR 状态", async () => {
    const fastify = await buildApp();
    // 不注册任何路由，触发 Fastify 默认 404
    await fastify.inject({ method: "GET", url: "/not-found" });
    expect(mockSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: 2 }),
    );
  });

  it("路由抛出异常时通过 onError hook 记录", async () => {
    const fastify = await buildApp();
    fastify.get("/boom", async () => {
      throw new Error("test error");
    });
    const res = await fastify.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    // onError hook 触发 recordException
    expect(mockSpan.recordException).toHaveBeenCalled();
  });

  it("ignorePaths 匹配时 span 不被标注（指标仍记录）", async () => {
    const fastify = await buildApp({ tracing: { ignorePaths: ["/health"] } });
    fastify.get("/health", async () => "ok");
    await fastify.inject({ method: "GET", url: "/health" });
    expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    expect(mockCounter.add).toHaveBeenCalled();
  });

  it("spanNameResolver 被调用时更新 Span 名称", async () => {
    const resolver = vi.fn((ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`);
    const fastify = await buildApp({ tracing: { spanNameResolver: resolver } });
    fastify.get("/users/:id", async () => "ok");
    await fastify.inject({ method: "GET", url: "/users/1" });
    expect(mockSpan.updateName).toHaveBeenCalledWith("GET /users/:id");
  });

  it("创建工厂函数返回值为函数（FastifyPluginAsync）", () => {
    expect(typeof createFastifyPlugin()).toBe("function");
  });

  it("POST 请求也正常工作", async () => {
    const fastify = await buildApp();
    fastify.post("/users", async () => ({ id: 1 }));
    await fastify.inject({ method: "POST", url: "/users" });
    expect(mockCounter.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "http.method": "POST", "http.status_code": 200 }),
    );
  });
});
