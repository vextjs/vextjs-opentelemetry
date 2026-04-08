import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock instances（必须在 vi.mock 工厂中引用前创建）────────────────

const {
  mockTracer,
  mockHistogram,
  mockCounter,
  mockUpDownCounter,
  mockMeter,
  mockGetTracer,
  mockGetMeter,
  mockSpan,
} = vi.hoisted(() => {
  const tracer = {
    startSpan: vi.fn(),
    startActiveSpan: vi.fn(),
  };
  const histogram = { record: vi.fn() };
  const counter = { add: vi.fn() };
  const upDownCounter = { add: vi.fn() };
  const meter = {
    createHistogram: vi.fn(() => histogram),
    createCounter: vi.fn(() => counter),
    createUpDownCounter: vi.fn(() => upDownCounter),
  };
  const span = {
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
  return {
    mockTracer: tracer,
    mockHistogram: histogram,
    mockCounter: counter,
    mockUpDownCounter: upDownCounter,
    mockMeter: meter,
    mockGetTracer: vi.fn(() => tracer),
    mockGetMeter: vi.fn(() => meter),
    mockSpan: span,
  };
});

// ── 模块 Mock ──────────────────────────────────────────────────────────────

vi.mock("@opentelemetry/api", () => ({
  trace: { getTracer: mockGetTracer },
  metrics: { getMeter: mockGetMeter },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

vi.mock("vextjs", () => ({
  definePlugin: vi.fn((plugin: unknown) => plugin),
  defineMiddleware: vi.fn((handler: unknown) => handler),
  requestContext: { getStore: vi.fn(() => null) },
}));

// ── 被测模块（在 mock 声明之后 import）────────────────────────────────────

import { opentelemetryPlugin } from "../src/adapters/vextjs.js"; import type { OtelAppExtension } from "../src/core/types.js";
// ── 测试工具 ──────────────────────────────────────────────────────────────

interface MockOtelConfig {
  serviceName?: string;
  enabled?: boolean;
}

function createMockApp(otelConfig?: MockOtelConfig) {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {
      otel: otelConfig,
    },
    extend: vi.fn(),
    use: vi.fn(),
    adapter: {
      registerRoute: vi.fn(),
    },
  };
}

// ── 测试套件 ──────────────────────────────────────────────────────────────

describe("opentelemetryPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // cleanup
  });

  // ── 基本属性 ─────────────────────────────────────────────────────────────

  describe("插件元数据", () => {
    it("插件名称为 'opentelemetry'", () => {
      const plugin = opentelemetryPlugin();
      expect(plugin.name).toBe("opentelemetry");
    });

    it("无参数调用不抛错", () => {
      expect(() => opentelemetryPlugin()).not.toThrow();
    });
  });

  // ── 场景1: disabled 模式 ─────────────────────────────────────────────────

  describe("disabled 模式", () => {
    it("options.enabled: false → 不调用 app.extend 和 app.use", async () => {
      const app = createMockApp();

      await opentelemetryPlugin({ enabled: false }).setup(app as never);

      expect(app.extend).not.toHaveBeenCalled();
      expect(app.use).not.toHaveBeenCalled();
    });

    it("options.enabled: false → 输出 debug 日志", async () => {
      const app = createMockApp();

      await opentelemetryPlugin({ enabled: false }).setup(app as never);

      expect(app.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
      );
    });

    it("config.otel.enabled: false → 不调用 app.extend 和 app.use", async () => {
      const app = createMockApp({ enabled: false });

      await opentelemetryPlugin().setup(app as never);

      expect(app.extend).not.toHaveBeenCalled();
      expect(app.use).not.toHaveBeenCalled();
    });

    it("config.otel.enabled: false → 输出 debug 日志", async () => {
      const app = createMockApp({ enabled: false });

      await opentelemetryPlugin().setup(app as never);

      expect(app.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
      );
    });

    it("options.enabled: false 优先于 config.otel.enabled: true", async () => {
      const app = createMockApp({ enabled: true });

      await opentelemetryPlugin({ enabled: false }).setup(app as never);

      expect(app.extend).not.toHaveBeenCalled();
    });

    it("disabled 模式不调用 trace.getTracer", async () => {
      const app = createMockApp();

      await opentelemetryPlugin({ enabled: false }).setup(app as never);

      expect(mockGetTracer).not.toHaveBeenCalled();
    });
  });

  // ── 场景2: 正常 setup ────────────────────────────────────────────────────

  describe("正常 setup", () => {
    it("通过 app.extend('otel', ...) 挂载 tracer / meter / metrics", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      expect(app.extend).toHaveBeenCalledOnce();
      expect(app.extend).toHaveBeenCalledWith("otel", expect.objectContaining({
        tracer: mockTracer,
        meter: mockMeter,
        metrics: {
          httpRequestDuration: mockHistogram,
          httpRequestTotal: mockCounter,
          httpActiveRequests: mockUpDownCounter,
          httpRequestSize: mockHistogram,
          httpResponseSize: mockHistogram,
        },
      }));
    });

    it("通过 app.adapter.registerRoute() 注册状态接口 + app.use() 注册追踪中间件", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      // 状态接口通过 adapter.registerRoute 注册
      expect(app.adapter.registerRoute).toHaveBeenCalledOnce();
      expect(app.adapter.registerRoute).toHaveBeenCalledWith(
        "GET",
        "/_otel/status",
        expect.any(Array),
      );
      // 全局追踪中间件通过 app.use 注册
      expect(app.use).toHaveBeenCalledOnce();
    });

    it("输出包含 serviceName 的 info 日志", async () => {
      const app = createMockApp();

      await opentelemetryPlugin({ serviceName: "my-svc" }).setup(app as never);

      expect(app.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("my-svc"),
      );
    });

    it("setup 返回 undefined（Promise resolves）", async () => {
      const app = createMockApp();

      await expect(
        opentelemetryPlugin().setup(app as never),
      ).resolves.toBeUndefined();
    });

    it("先挂载 app.otel 再注册路由和中间件（extend → registerRoute → use）", async () => {
      const app = createMockApp();
      const callOrder: string[] = [];
      app.extend.mockImplementation(() => callOrder.push("extend"));
      app.adapter.registerRoute.mockImplementation(() => callOrder.push("registerRoute"));
      app.use.mockImplementation(() => callOrder.push("use"));

      await opentelemetryPlugin().setup(app as never);

      // extend → registerRoute(status) → use(tracing)
      expect(callOrder).toEqual(["extend", "registerRoute", "use"]);
    });
  });

  // ── 场景3: HTTP 指标创建 ─────────────────────────────────────────────────

  describe("HTTP 指标创建", () => {
    it("创建 http.server.duration 直方图，单位 ms", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      expect(mockMeter.createHistogram).toHaveBeenCalledWith(
        "http.server.duration",
        expect.objectContaining({
          unit: "ms",
          description: expect.any(String),
        }),
      );
    });

    it("创建 http.server.request.total 计数器", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      expect(mockMeter.createCounter).toHaveBeenCalledWith(
        "http.server.request.total",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });

    it("创建 http.server.active_requests UpDownCounter", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      expect(mockMeter.createUpDownCounter).toHaveBeenCalledWith(
        "http.server.active_requests",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });

    it("使用默认 durationBuckets", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      expect(mockMeter.createHistogram).toHaveBeenCalledWith(
        "http.server.duration",
        expect.objectContaining({
          advice: {
            explicitBucketBoundaries: [
              5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
            ],
          },
        }),
      );
    });

    it("使用自定义 durationBuckets", async () => {
      const app = createMockApp();
      const customBuckets = [1, 5, 10, 50, 100];

      await opentelemetryPlugin({
        metrics: { durationBuckets: customBuckets },
      }).setup(app as never);

      expect(mockMeter.createHistogram).toHaveBeenCalledWith(
        "http.server.duration",
        expect.objectContaining({
          advice: { explicitBucketBoundaries: customBuckets },
        }),
      );
    });
  });

  // ── 场景4: serviceName 解析优先级 ───────────────────────────────────────

  describe("serviceName 解析优先级", () => {
    it("options.serviceName 优先级最高", async () => {
      const app = createMockApp({ serviceName: "config-service" });

      await opentelemetryPlugin({ serviceName: "options-service" }).setup(
        app as never,
      );

      expect(mockGetTracer).toHaveBeenCalledWith("options-service");
      expect(mockGetMeter).toHaveBeenCalledWith("options-service");
    });

    it("config.otel.serviceName 作为第二优先级", async () => {
      const app = createMockApp({ serviceName: "config-service" });

      await opentelemetryPlugin().setup(app as never);

      expect(mockGetTracer).toHaveBeenCalledWith("config-service");
    });

    it("无任何配置时默认使用 'vext-app'", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

      expect(mockGetTracer).toHaveBeenCalledWith("vext-app");
    });
  });

  // ── 场景5: onClose ────────────────────────────────────────────────────────

  describe("onClose", () => {
    it("定义了 onClose 钩子", () => {
      const plugin = opentelemetryPlugin();
      expect(plugin.onClose).toBeDefined();
    });

    it("onClose 输出 flushing 日志", async () => {
      const app = createMockApp();
      const plugin = opentelemetryPlugin();

      await plugin.setup(app as never);
      vi.clearAllMocks();
      await plugin.onClose?.(app as never);

      expect(app.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("flushing"),
      );
    });

    it("onClose 在 disabled 模式下不抛错", async () => {
      const app = createMockApp();
      const plugin = opentelemetryPlugin({ enabled: false });

      await plugin.setup(app as never);
      await expect(plugin.onClose?.(app as never)).resolves.toBeUndefined();
    });
  });

  // ── 场景6: 多次调用隔离 ──────────────────────────────────────────────────

  describe("多实例隔离", () => {
    it("每次调用返回独立的插件实例", () => {
      const plugin1 = opentelemetryPlugin({ serviceName: "svc-1" });
      const plugin2 = opentelemetryPlugin({ serviceName: "svc-2" });

      expect(plugin1).not.toBe(plugin2);
    });

    it("两个实例分别 setup，各自调用 app.extend 一次", async () => {
      const app1 = createMockApp();
      const app2 = createMockApp();

      await opentelemetryPlugin({ serviceName: "svc-1" }).setup(app1 as never);
      await opentelemetryPlugin({ serviceName: "svc-2" }).setup(app2 as never);

      expect(app1.extend).toHaveBeenCalledOnce();
      expect(app2.extend).toHaveBeenCalledOnce();
    });
  });

  // ── 场景7: withSpan ──────────────────────────────────────────────

  describe("withSpan", () => {
    beforeEach(() => {
      // 让 startActiveSpan 真实调用回调，传入 mockSpan
      mockTracer.startActiveSpan.mockImplementation(
        (...args: unknown[]) => {
          const fn = args[args.length - 1] as (span: typeof mockSpan) => unknown;
          return fn(mockSpan);
        },
      );
    });

    it("成功路径：span.end() 自动调用，返回值正确透传", async () => {
      const app = createMockApp();
      await opentelemetryPlugin().setup(app as never);
      const otel = app.extend.mock.calls[0][1] as OtelAppExtension;

      const result = await otel.withSpan("test.op", async () => "ok");

      expect(result).toBe("ok");
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("异常路径：recordException + setStatus(ERROR) + span.end() + 异常 re-throw", async () => {
      const app = createMockApp();
      await opentelemetryPlugin().setup(app as never);
      const otel = app.extend.mock.calls[0][1] as OtelAppExtension;

      const err = new Error("boom");
      await expect(
        otel.withSpan("test.op", async () => {
          throw err;
        }),
      ).rejects.toThrow("boom");

      expect(mockSpan.recordException).toHaveBeenCalledWith(err);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2, // SpanStatusCode.ERROR
        message: "boom",
      });
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("带 options.attributes：startActiveSpan 以三参数形式被调用", async () => {
      const app = createMockApp();
      await opentelemetryPlugin().setup(app as never);
      const otel = app.extend.mock.calls[0][1] as OtelAppExtension;

      await otel.withSpan(
        "test.op",
        async () => { },
        { attributes: { "payment.provider": "stripe" } },
      );

      expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
        "test.op",
        { attributes: { "payment.provider": "stripe" } },
        expect.any(Function),
      );
    });

    it("动态属性路径：span 实例正确传入回调，手动 setAttribute 可调用", async () => {
      const app = createMockApp();
      await opentelemetryPlugin().setup(app as never);
      const otel = app.extend.mock.calls[0][1] as OtelAppExtension;

      await otel.withSpan("test.op", async (span: import("@opentelemetry/api").Span) => {
        span.setAttribute("payment.id", "pay-123");
      });

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("payment.id", "pay-123");
    });
  });
});
