import { describe, it, expect, vi, beforeEach } from "vitest";

const mockKoaMiddleware = vi.fn();

vi.mock("../../src/adapters/koa.js", () => ({
  createKoaMiddleware: vi.fn(() => mockKoaMiddleware),
}));

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getActiveSpan: vi.fn(() => ({
      spanContext: () => ({
        traceId: "trace-123",
      }),
    })),
  },
}));

import { createEggMiddleware } from "../../src/adapters/egg.js";

interface EggTestTracer {
  traceId?: string;
}

interface EggTestContext {
  method: string;
  path: string;
  routerPath?: string;
  tracer: EggTestTracer;
  user_id?: string;
  trace_id?: string;
  span_name?: string;
  endpoint?: string;
  latency_ms?: number;
}

describe("createEggMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKoaMiddleware.mockImplementation(async (_ctx, next) => {
      await next();
    });
  });

  it("执行 onCtxInit 并在 finally 中触发 onRequestDone", async () => {
    const onCtxInit = vi.fn((ctx) => {
      ctx.user_id = "u-1";
    });
    const onRequestDone = vi.fn();
    const middlewareFactory = createEggMiddleware({ onCtxInit, onRequestDone });
    const middleware = middlewareFactory({}, {});
    const ctx: EggTestContext = {
      method: "GET",
      path: "/users/1",
      routerPath: "/users/:id",
      tracer: {},
    };

    await middleware(ctx, vi.fn(async () => undefined));

    expect(onCtxInit).toHaveBeenCalledWith(ctx);
    expect(ctx.user_id).toBe("u-1");
    expect(ctx.trace_id).toBe("trace-123");
    expect(ctx.tracer.traceId).toBe("trace-123");
    expect(ctx.span_name).toBe("GET /users/:id");
    expect(ctx.endpoint).toBe("/users/:id");
    expect(typeof ctx.latency_ms).toBe("number");
    expect(onRequestDone).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        method: "GET",
        route: "/users/:id",
        latencyMs: expect.any(Number),
      }),
    );
  });

  it("无 routerPath 时回退到 path", async () => {
    const onRequestDone = vi.fn();
    const middleware = createEggMiddleware({ onRequestDone })({}, {});
    const ctx: EggTestContext = {
      method: "POST",
      path: "/orders",
      tracer: {},
    };

    await middleware(ctx, vi.fn(async () => undefined));

    expect(ctx.span_name).toBe("POST /orders");
    expect(ctx.endpoint).toBe("/orders");
    expect(onRequestDone).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ route: "/orders" }),
    );
  });
});


