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
  return {
    mockTracer: tracer,
    mockHistogram: histogram,
    mockCounter: counter,
    mockUpDownCounter: upDownCounter,
    mockMeter: meter,
    mockGetTracer: vi.fn(() => tracer),
    mockGetMeter: vi.fn(() => meter),
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

import { opentelemetryPlugin } from "../src/plugin.js";

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
  };
}

// ── 测试套件 ──────────────────────────────────────────────────────────────

describe("opentelemetryPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OTEL_SERVICE_NAME;
  });

  afterEach(() => {
    delete process.env.OTEL_SERVICE_NAME;
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
      expect(app.extend).toHaveBeenCalledWith("otel", {
        tracer: mockTracer,
        meter: mockMeter,
        metrics: {
          httpRequestDuration: mockHistogram,
          httpRequestTotal: mockCounter,
          httpActiveRequests: mockUpDownCounter,
        },
      });
    });

    it("通过 app.use() 注册全局追踪中间件", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app as never);

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

    it("先挂载 app.otel 再注册中间件（extend 在 use 前调用）", async () => {
      const app = createMockApp();
      const callOrder: string[] = [];
      app.extend.mockImplementation(() => callOrder.push("extend"));
      app.use.mockImplementation(() => callOrder.push("use"));

      await opentelemetryPlugin().setup(app as never);

      expect(callOrder).toEqual(["extend", "use"]);
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
    it("OTEL_SERVICE_NAME 环境变量优先级最高", async () => {
      process.env.OTEL_SERVICE_NAME = "env-service";
      const app = createMockApp({ serviceName: "config-service" });

      await opentelemetryPlugin({ serviceName: "options-service" }).setup(
        app as never,
      );

      expect(mockGetTracer).toHaveBeenCalledWith("env-service");
      expect(mockGetMeter).toHaveBeenCalledWith("env-service");
    });

    it("options.serviceName 次于环境变量", async () => {
      const app = createMockApp({ serviceName: "config-service" });

      await opentelemetryPlugin({ serviceName: "options-service" }).setup(
        app as never,
      );

      expect(mockGetTracer).toHaveBeenCalledWith("options-service");
    });

    it("config.otel.serviceName 作为第三优先级", async () => {
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
});
