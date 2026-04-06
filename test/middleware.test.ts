import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock instances ─────────────────────────────────────────────────

const {
  mockSpan,
  mockGetActiveSpan,
  mockStore,
  mockGetStore,
  mockHistogram,
  mockCounter,
  mockUpDownCounter,
} = vi.hoisted(() => {
  const span = {
    isRecording: vi.fn(() => true),
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    updateName: vi.fn(),
    spanContext: vi.fn(() => ({
      traceId: "abc123traceId00000000000000000000",
      spanId: "def456spanId0000",
    })),
  };
  const store: { traceId: string | undefined; spanId: string | undefined } = {
    traceId: undefined,
    spanId: undefined,
  };
  return {
    mockSpan: span,
    mockGetActiveSpan: vi.fn(() => span as typeof span | undefined),
    mockStore: store,
    mockGetStore: vi.fn(
      () =>
        store as {
          traceId: string | undefined;
          spanId: string | undefined;
        } | null,
    ),
    mockHistogram: { record: vi.fn() },
    mockCounter: { add: vi.fn() },
    mockUpDownCounter: { add: vi.fn() },
  };
});

// ── 模块 Mock ──────────────────────────────────────────────────────────────

vi.mock("@opentelemetry/api", () => ({
  trace: { getActiveSpan: mockGetActiveSpan },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

vi.mock("vextjs", () => ({
  defineMiddleware: vi.fn((handler: unknown) => handler),
  requestContext: { getStore: mockGetStore },
}));

// ── 被测模块 ───────────────────────────────────────────────────────────────

import { createTracingMiddleware } from "../src/middleware.js";
import type { OtelMetrics, OpenTelemetryPluginOptions } from "../src/types.js";

// ── 测试工具 ──────────────────────────────────────────────────────────────

function createMockMetrics(): OtelMetrics {
  return {
    httpRequestDuration: mockHistogram as never,
    httpRequestTotal: mockCounter as never,
    httpActiveRequests: mockUpDownCounter as never,
  };
}

function createMockReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    path: "/test",
    route: "/test/:id",
    requestId: "req-001",
    headers: {} as Record<string, string>,
    ...overrides,
  };
}

function createMockRes(statusCode = 200) {
  return { statusCode };
}

async function runMiddleware(
  middleware: Function,
  req: unknown,
  res: unknown,
  nextImpl?: () => Promise<void>,
) {
  const next = nextImpl ?? vi.fn(async () => {});
  await (middleware as Function)(req, res, next);
  return next;
}

// ── 测试套件 ──────────────────────────────────────────────────────────────

describe("createTracingMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 store 字段
    mockStore.traceId = undefined;
    mockStore.spanId = undefined;
    // 默认：span 正在录制
    mockSpan.isRecording.mockReturnValue(true);
    // 默认：getActiveSpan 返回 mockSpan
    mockGetActiveSpan.mockReturnValue(mockSpan);
    // 默认：getStore 返回 mockStore
    mockGetStore.mockReturnValue(mockStore);
  });

  // ── 基本行为 ─────────────────────────────────────────────────────────────

  describe("基本行为", () => {
    it("返回一个函数（中间件）", () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      expect(typeof middleware).toBe("function");
    });

    it("调用 next()", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn(async () => {});

      await (middleware as Function)(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("不干扰 next() 的返回值", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();
      let nextCalled = false;

      await (middleware as Function)(req, res, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });

  // ── 场景1: 指标 — 活跃请求计数 ───────────────────────────────────────────

  describe("HTTP 指标 — 活跃请求", () => {
    it("请求开始时 httpActiveRequests +1", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq({ method: "POST" });
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockUpDownCounter.add).toHaveBeenCalledWith(1, {
        "http.method": "POST",
      });
    });

    it("请求结束时 httpActiveRequests -1", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq({ method: "GET" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockUpDownCounter.add).toHaveBeenCalledWith(-1, {
        "http.method": "GET",
      });
    });

    it("异常时也保证 httpActiveRequests -1", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const calls = mockUpDownCounter.add.mock.calls;
      const decrementCall = calls.find((c) => c[0] === -1);
      expect(decrementCall).toBeDefined();
    });
  });

  // ── 场景2: 指标 — 请求完成统计 ───────────────────────────────────────────

  describe("HTTP 指标 — 请求完成", () => {
    it("成功请求记录 httpRequestTotal（含 http.method/status_code/route）", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq({ method: "GET", route: "/users/:id" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          "http.method": "GET",
          "http.status_code": 200,
          "http.route": "/users/:id",
        }),
      );
    });

    it("成功请求记录 httpRequestDuration（毫秒数值 ≥ 0）", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockHistogram.record).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ "http.method": "GET" }),
      );
      const duration = mockHistogram.record.mock.calls[0][0];
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it("无 route 时回退到 req.path", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq({ route: undefined, path: "/fallback-path" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.route": "/fallback-path" }),
      );
    });

    it("异常时以 status_code 500 记录 httpRequestTotal", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {
          throw new Error("db error");
        }),
      ).rejects.toThrow("db error");

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 500 }),
      );
    });

    it("异常时也记录 httpRequestDuration", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {
          throw new Error("err");
        }),
      ).rejects.toThrow();

      expect(mockHistogram.record).toHaveBeenCalledOnce();
    });
  });

  // ── 场景3: 追踪 — Span 属性 ──────────────────────────────────────────────

  describe("Span 属性注入", () => {
    it("设置 http.route / http.request_id / vext.service 属性", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        serviceName: "test-svc",
      });
      const req = createMockReq({
        route: "/items/:id",
        requestId: "rid-999",
      });
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "http.route": "/items/:id",
          "http.request_id": "rid-999",
          "vext.service": "test-svc",
        }),
      );
    });

    it("options.serviceName 直接作为 vext.service 属性", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        serviceName: "options-svc",
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ "vext.service": "options-svc" }),
      );
    });

    it("成功请求设置 http.status_code 属性", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes(201);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "http.status_code",
        201,
      );
    });

    it("4xx 响应设置 Span status 为 ERROR", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes(404);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2, // SpanStatusCode.ERROR
        message: "HTTP 404",
      });
    });

    it("2xx/3xx 响应不设置 ERROR 状态", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setStatus).not.toHaveBeenCalled();
    });

    it("异常时调用 span.recordException()", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();
      const err = new Error("unexpected");

      await expect(
        (middleware as Function)(req, res, async () => {
          throw err;
        }),
      ).rejects.toThrow("unexpected");

      expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    });

    it("异常时设置 Span status 为 ERROR（包含错误消息）", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {
          throw new Error("fatal error");
        }),
      ).rejects.toThrow();

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2, // SpanStatusCode.ERROR
        message: "fatal error",
      });
    });
  });

  // ── 场景4: F-03 日志关联 — ALS 写入 ───────────────────────────────────────

  describe("F-03 ALS 日志关联", () => {
    it("span 录制时写入 store.traceId", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockStore.traceId).toBe("abc123traceId00000000000000000000");
    });

    it("span 录制时写入 store.spanId", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockStore.spanId).toBe("def456spanId0000");
    });

    it("span 未录制（isRecording: false）时不写入 ALS", async () => {
      mockSpan.isRecording.mockReturnValue(false);
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockStore.traceId).toBeUndefined();
      expect(mockStore.spanId).toBeUndefined();
    });

    it("getStore() 返回 null 时不抛错", async () => {
      mockGetStore.mockReturnValue(null as unknown as typeof mockStore);
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {}),
      ).resolves.toBeUndefined();
    });

    it("无 active span 时不写入 ALS", async () => {
      mockGetActiveSpan.mockReturnValue(undefined);
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockStore.traceId).toBeUndefined();
    });
  });

  // ── 场景5: tracing.enabled: false ────────────────────────────────────────

  describe("tracing.enabled: false", () => {
    it("不调用 span.setAttributes", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("不写入 ALS store", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockStore.traceId).toBeUndefined();
    });

    it("仍然统计 HTTP 指标", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {
        tracing: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 200 }),
      );
    });
  });

  // ── 场景6: metrics.enabled: false ────────────────────────────────────────

  describe("metrics.enabled: false", () => {
    it("不调用 httpActiveRequests.add", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        metrics: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockUpDownCounter.add).not.toHaveBeenCalled();
    });

    it("不调用 httpRequestTotal.add", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        metrics: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockCounter.add).not.toHaveBeenCalled();
    });

    it("不调用 httpRequestDuration.record", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        metrics: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockHistogram.record).not.toHaveBeenCalled();
    });

    it("仍然标注 Span 属性", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        metrics: { enabled: false },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).toHaveBeenCalled();
    });
  });

  // ── 场景7: extraAttributes ────────────────────────────────────────────────

  describe("tracing.extraAttributes", () => {
    it("对象形式的额外属性被合并到 Span", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: {
          extraAttributes: {
            "custom.key": "custom-value",
            "custom.number": 42,
          },
        },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "custom.key": "custom-value",
          "custom.number": 42,
        }),
      );
    });

    it("函数形式的额外属性接收 req 并将返回值合并到 Span", async () => {
      const attrFn = vi.fn(() => ({ "user.id": "u-123" }));
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { extraAttributes: attrFn },
      });
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(attrFn).toHaveBeenCalledWith(req);
      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ "user.id": "u-123" }),
      );
    });

    it("函数形式返回空对象时正常运行", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { extraAttributes: () => ({}) },
      });
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {}),
      ).resolves.toBeUndefined();
    });
  });

  // ── 场景8: 无 active span（Noop Provider）────────────────────────────────

  describe("Noop Provider（SDK 未初始化）", () => {
    it("getActiveSpan() 返回 undefined 时不抛错", async () => {
      mockGetActiveSpan.mockReturnValue(undefined);
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {}),
      ).resolves.toBeUndefined();
    });

    it("span 未录制时不调用 setAttributes", async () => {
      mockSpan.isRecording.mockReturnValue(false);
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("异常时无 span 仍然重新抛出错误", async () => {
      mockGetActiveSpan.mockReturnValue(undefined);
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes();

      await expect(
        (middleware as Function)(req, res, async () => {
          throw new Error("propagated");
        }),
      ).rejects.toThrow("propagated");
    });
  });

  // ── 场景9: metrics.customLabels ──────────────────────────────────────────

  describe("metrics.customLabels", () => {
    it("静态对象形式：label 合并到 httpRequestTotal 和 httpRequestDuration", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {
        metrics: {
          customLabels: {
            "tenant.id": "us-east",
            env: "prod",
          },
        },
      });
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          "http.method": "GET",
          "http.status_code": 200,
          "tenant.id": "us-east",
          env: "prod",
        }),
      );
      expect(mockHistogram.record).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          "tenant.id": "us-east",
          env: "prod",
        }),
      );
    });

    it("函数形式：从 req.headers 读取，返回值正确合并", async () => {
      const metrics = createMockMetrics();
      const labelsFn = vi.fn((req: { headers: Record<string, string> }) => ({
        "api.version": req.headers["x-api-version"] ?? "v1",
      }));
      const middleware = createTracingMiddleware(metrics, {
        metrics: { customLabels: labelsFn as never },
      });
      const req = createMockReq({
        headers: { "x-api-version": "v2" },
      });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(labelsFn).toHaveBeenCalledWith(req);
      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "api.version": "v2" }),
      );
    });

    it("函数抛错：降级为空对象，基础指标正常记录，输出 warn", async () => {
      const metrics = createMockMetrics();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const middleware = createTracingMiddleware(metrics, {
        metrics: {
          customLabels: () => {
            throw new Error("labels error");
          },
        },
      });
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      // 基础指标仍然记录
      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          "http.method": "GET",
          "http.status_code": 200,
          "http.route": "/test/:id",
        }),
      );
      // warn 被调用
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("customLabels"),
      );
      warnSpy.mockRestore();
    });

    it("metrics.enabled: false 时 customLabels 函数不被调用", async () => {
      const metrics = createMockMetrics();
      const labelsFn = vi.fn(() => ({ "test.key": "value" }));
      const middleware = createTracingMiddleware(metrics, {
        metrics: {
          enabled: false,
          customLabels: labelsFn as never,
        },
      });
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(labelsFn).not.toHaveBeenCalled();
      expect(mockCounter.add).not.toHaveBeenCalled();
    });

    it("httpActiveRequests 不含 customLabels（仅 http.method，符合 OTEL 语义约定）", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {
        metrics: {
          customLabels: { "tenant.id": "test" },
        },
      });
      const req = createMockReq({ method: "PUT" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      // +1 调用：只含 http.method
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(1, {
        "http.method": "PUT",
      });
      // -1 调用：只含 http.method
      expect(mockUpDownCounter.add).toHaveBeenCalledWith(-1, {
        "http.method": "PUT",
      });
    });
  });

  // ── 场景10: tracing.ignorePaths ─────────────────────────────────

  describe("tracing.ignorePaths", () => {
    it("精确匹配 ignored 路径时不调用 setAttributes", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { ignorePaths: ["/health"] },
      });
      const req = createMockReq({ path: "/health" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("精确匹配 ignored 路径时不写入 ALS store", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { ignorePaths: ["/health"] },
      });
      const req = createMockReq({ path: "/health" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockStore.traceId).toBeUndefined();
    });

    it("正则表达式匹配 ignored 路径时不调用 setAttributes", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { ignorePaths: [/^\/internal\//] },
      });
      const req = createMockReq({ path: "/internal/metrics" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    });

    it("非 ignored 路径仍正常追踪", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { ignorePaths: ["/health"] },
      });
      const req = createMockReq({ path: "/api/users" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).toHaveBeenCalled();
    });

    it("ignored 路径仍统计 HTTP 指标", async () => {
      const metrics = createMockMetrics();
      const middleware = createTracingMiddleware(metrics, {
        tracing: { ignorePaths: ["/health"] },
      });
      const req = createMockReq({ path: "/health" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockCounter.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ "http.status_code": 200 }),
      );
    });

    it("ignorePaths 为空数组时不影响正常追踪", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { ignorePaths: [] },
      });
      const req = createMockReq({ path: "/api/test" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.setAttributes).toHaveBeenCalled();
    });
  });

  // ── 场景11: tracing.spanNameResolver ───────────────────────────

  describe("tracing.spanNameResolver", () => {
    it("提供 resolver 时调用 activeSpan.updateName()", async () => {
      const resolver = vi.fn((req: { method: string; path: string }) =>
        `${req.method} ${req.path}`,
      );
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { spanNameResolver: resolver as never },
      });
      const req = createMockReq({ method: "GET", path: "/users/123" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(resolver).toHaveBeenCalledWith(req);
      expect(mockSpan.updateName).toHaveBeenCalledWith("GET /users/123");
    });

    it("未提供 resolver 时不调用 updateName()", async () => {
      const middleware = createTracingMiddleware(createMockMetrics(), {});
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.updateName).not.toHaveBeenCalled();
    });

    it("ignored 路径不调用 spanNameResolver", async () => {
      const resolver = vi.fn(() => "ignored");
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: {
          ignorePaths: ["/health"],
          spanNameResolver: resolver as never,
        },
      });
      const req = createMockReq({ path: "/health" });
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(resolver).not.toHaveBeenCalled();
      expect(mockSpan.updateName).not.toHaveBeenCalled();
    });

    it("span 未录制时不调用 updateName()", async () => {
      mockSpan.isRecording.mockReturnValue(false);
      const resolver = vi.fn(() => "should-not-call");
      const middleware = createTracingMiddleware(createMockMetrics(), {
        tracing: { spanNameResolver: resolver as never },
      });
      const req = createMockReq();
      const res = createMockRes(200);

      await (middleware as Function)(req, res, async () => {});

      expect(mockSpan.updateName).not.toHaveBeenCalled();
    });
  });
});
