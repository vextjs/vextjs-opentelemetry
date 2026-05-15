import { describe, it, expect, expectTypeOf, vi, beforeEach } from "vitest";

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

import {
  createEggMiddleware,
  type EggContextLike,
  type EggMiddlewareFactory,
} from "../../src/adapters/egg.js";

interface EggTestTracer {
  traceId?: string;
}

interface EggTestContext {
  method: string;
  path: string;
  routerPath?: string;
   query?: Record<string, unknown>;
   params?: Record<string, unknown>;
   request?: { body?: unknown };
  tracer: EggTestTracer;
  get(name: string): string;
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

  it("在 finally 中补齐 trace/span/endpoint/latency 字段并委托给 Koa 中间件", async () => {
    const middlewareFactory = createEggMiddleware({});
    const middleware = middlewareFactory({}, {});
    const ctx: EggTestContext = {
      method: "GET",
      path: "/users/1",
      routerPath: "/users/:id",
      query: { page: "1" },
      params: { id: "1" },
      request: { body: { orderNo: "A001" } },
      tracer: {},
      get: () => "",
    };

    await middleware(ctx, vi.fn(async () => undefined));

    expect(ctx.trace_id).toBe("trace-123");
    expect(ctx.tracer.traceId).toBe("trace-123");
    expect(ctx.span_name).toBe("GET /users/:id");
    expect(ctx.endpoint).toBe("/users/:id");
    expect(typeof ctx.latency_ms).toBe("number");
    expect(mockKoaMiddleware).toHaveBeenCalledWith(ctx, expect.any(Function));
  });

  it("无 routerPath 时回退到 path", async () => {
    const middleware = createEggMiddleware({})({}, {});
    const ctx: EggTestContext = {
      method: "POST",
      path: "/orders",
      query: { page: "1" },
      params: { id: "42" },
      request: { body: { orderNo: "A001" } },
      tracer: {},
      get: () => "",
    };

    await middleware(ctx, vi.fn(async () => undefined));

    expect(ctx.span_name).toBe("POST /orders");
    expect(ctx.endpoint).toBe("/orders");
    expect(typeof ctx.latency_ms).toBe("number");
  });

  it("默认向生命周期与 attributes 回调暴露 EggContextLike 类型", () => {
    expectTypeOf(createEggMiddleware()).toMatchTypeOf<EggMiddlewareFactory>();

    createEggMiddleware({
      tracing: {
        endAttributes: (_ctx, rawCtx) => {
          expectTypeOf(rawCtx).toMatchTypeOf<EggContextLike>();
          expectTypeOf(rawCtx.get).toBeFunction();
          expectTypeOf(rawCtx.query).toMatchTypeOf<Record<string, unknown> | undefined>();
          expectTypeOf(rawCtx.params).toMatchTypeOf<Record<string, unknown> | undefined>();
          return {
            "request.body.present": Boolean(rawCtx.request?.body),
          };
        },
      },
      lifecycle: {
        onStart: (_ctx, rawCtx) => {
          expectTypeOf(rawCtx.state).toMatchTypeOf<Record<string, unknown> | undefined>();
        },
      },
    });
  });

  it("委托给 Koa middleware 时保留 query / params / body 等晚到字段", async () => {
    const middleware = createEggMiddleware({})({}, {});
    const ctx: EggTestContext = {
      method: "POST",
      path: "/orders/99",
      tracer: {},
      get: () => "",
    };

    mockKoaMiddleware.mockImplementationOnce(async (rawCtx, next) => {
      (rawCtx as EggTestContext).query = { page: "1" };
      (rawCtx as EggTestContext).params = { id: "99" };
      (rawCtx as EggTestContext).request = { body: { orderNo: "LATE-001" } };
      (rawCtx as EggTestContext).routerPath = "/orders/:id";
      await next();
    });

    await middleware(ctx, vi.fn(async () => undefined));

    expect(mockKoaMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { page: "1" },
        params: { id: "99" },
        request: { body: { orderNo: "LATE-001" } },
        routerPath: "/orders/:id",
      }),
      expect.any(Function),
    );
  });
});


