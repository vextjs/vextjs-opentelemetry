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
});


