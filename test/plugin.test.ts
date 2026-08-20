import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VextLogger, VextPluginContext } from "vextjs";

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
  mockAttachExporterToSdk,
  mockResolvePackageOtelConfig,
  mockStartOtelSdk,
  mockShutdownOtelSdk,
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
    mockAttachExporterToSdk: vi.fn(() => Promise.resolve()),
    mockResolvePackageOtelConfig: vi.fn(() => ({})),
    mockStartOtelSdk: vi.fn(() => Promise.resolve()),
    mockShutdownOtelSdk: vi.fn(() => Promise.resolve()),
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

vi.mock("../src/core/config.js", () => ({
  resolvePackageOtelConfig: mockResolvePackageOtelConfig,
}));

vi.mock("../src/core/sdk-config.js", () => ({
  attachExporterToSdk: mockAttachExporterToSdk,
}));

vi.mock("../src/core/sdk-start.js", () => ({
  startOtelSdk: mockStartOtelSdk,
  shutdownOtelSdk: mockShutdownOtelSdk,
}));

// ── 被测模块（在 mock 声明之后 import）────────────────────────────────────

import { opentelemetryPlugin } from "../src/adapters/vextjs.js";
import type { OtelAppExtension } from "../src/core/types.js";
// ── 测试工具 ──────────────────────────────────────────────────────────────

interface MockOtelConfig {
  serviceName?: string;
  enabled?: boolean;
  endpoint?: string;
  protocol?: "http" | "grpc";
  headers?: Record<string, string>;
  insecure?: boolean;
}

type MockLogger = VextLogger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
};

type MockPluginApp = VextPluginContext & {
  logger: MockLogger;
  extend: ReturnType<typeof vi.fn>;
  use: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onReady: ReturnType<typeof vi.fn>;
  setLogger: ReturnType<typeof vi.fn>;
  adapter: VextPluginContext["adapter"] & {
    registerRoute: ReturnType<typeof vi.fn>;
  };
};

function createMockApp(otelConfig?: MockOtelConfig): MockPluginApp {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
  } as unknown as VextLogger;

  return {
    logger,
    throw: vi.fn(),
    config: {
      otel: otelConfig,
    },
    services: {},
    extend: vi.fn(),
    setValidator: vi.fn(),
    getValidator: vi.fn(),
    setThrow: vi.fn(),
    setLogger: vi.fn(),
    setRateLimiter: vi.fn(),
    setRequestIdGenerator: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    use: vi.fn(),
    cache: {},
    fetch: vi.fn(),
    adapter: {
      registerRoute: vi.fn(),
    },
  } as unknown as MockPluginApp;
}

function getMountedOtel(app: MockPluginApp): OtelAppExtension {
  return app.extend.mock.calls[0][1] as OtelAppExtension;
}

// ── 测试套件 ──────────────────────────────────────────────────────────────

describe("opentelemetryPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePackageOtelConfig.mockReturnValue({});
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.VEXT_OTEL_DISABLED;
    delete process.env.VEXT_OTEL_PRELOAD;
    delete process.env.VEXT_OTEL_SDK_STARTED;
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

        await opentelemetryPlugin({ enabled: false }).setup(app);

      expect(app.extend).not.toHaveBeenCalled();
      expect(app.use).not.toHaveBeenCalled();
    });

    it("options.enabled: false → 输出 debug 日志", async () => {
      const app = createMockApp();

        await opentelemetryPlugin({ enabled: false }).setup(app);

      expect(app.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
      );
    });

    it("config.otel.enabled: false → 不调用 app.extend 和 app.use", async () => {
      const app = createMockApp({ enabled: false });

        await opentelemetryPlugin().setup(app);

      expect(app.extend).not.toHaveBeenCalled();
      expect(app.use).not.toHaveBeenCalled();
    });

    it("config.otel.enabled: false → 输出 debug 日志", async () => {
      const app = createMockApp({ enabled: false });

        await opentelemetryPlugin().setup(app);

      expect(app.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
      );
    });

    it("options.enabled: false 优先于 config.otel.enabled: true", async () => {
      const app = createMockApp({ enabled: true });

        await opentelemetryPlugin({ enabled: false }).setup(app);

      expect(app.extend).not.toHaveBeenCalled();
    });

    it("package vext.otel.enabled: false → 不启动 SDK 或挂载插件", async () => {
      mockResolvePackageOtelConfig.mockReturnValue({
        enabled: false,
        endpoint: "file",
      });
      const app = createMockApp();

      await opentelemetryPlugin().setup(app);

      expect(mockStartOtelSdk).not.toHaveBeenCalled();
      expect(mockAttachExporterToSdk).not.toHaveBeenCalled();
      expect(app.extend).not.toHaveBeenCalled();
    });

    it("package enabled=false 仍优先于 VEXT_OTEL_PRELOAD=0", async () => {
      process.env.VEXT_OTEL_PRELOAD = "0";
      mockResolvePackageOtelConfig.mockReturnValue({
        enabled: false,
        endpoint: "file",
      });
      const app = createMockApp();

      await opentelemetryPlugin().setup(app);

      expect(mockStartOtelSdk).not.toHaveBeenCalled();
      expect(mockAttachExporterToSdk).not.toHaveBeenCalled();
      expect(app.extend).not.toHaveBeenCalled();
    });

    it("OTEL_SDK_DISABLED=true → 不启动 SDK 或挂载插件", async () => {
      process.env.OTEL_SDK_DISABLED = "true";
      const app = createMockApp();

      await opentelemetryPlugin({ endpoint: "file" }).setup(app);

      expect(mockStartOtelSdk).not.toHaveBeenCalled();
      expect(mockAttachExporterToSdk).not.toHaveBeenCalled();
      expect(app.extend).not.toHaveBeenCalled();
    });

    it("VEXT_OTEL_PRELOAD=0 只关闭 package preload，不禁用 plugin setup", async () => {
      process.env.VEXT_OTEL_PRELOAD = "0";
      const app = createMockApp();

      await opentelemetryPlugin({ endpoint: "file" }).setup(app);

      expect(mockStartOtelSdk).toHaveBeenCalledOnce();
      expect(mockAttachExporterToSdk).toHaveBeenCalledWith({
        endpoint: "file",
        protocol: "http",
        headers: undefined,
        insecure: undefined,
        serviceName: "vext-app",
      });
      expect(app.extend).toHaveBeenCalledOnce();
    });

    it("disabled 模式不调用 trace.getTracer", async () => {
      const app = createMockApp();

        await opentelemetryPlugin({ enabled: false }).setup(app);

      expect(mockGetTracer).not.toHaveBeenCalled();
    });
  });

  // ── 场景2: 正常 setup ────────────────────────────────────────────────────

  describe("正常 setup", () => {
    it("通过 app.extend('otel', ...) 挂载 tracer / meter / metrics", async () => {
      const app = createMockApp();

        await opentelemetryPlugin().setup(app);

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

        await opentelemetryPlugin().setup(app);

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

        await opentelemetryPlugin({ serviceName: "my-svc" }).setup(app);

      expect(app.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("my-svc"),
      );
    });

    it("setup 返回 undefined（Promise resolves）", async () => {
      const app = createMockApp();

      await expect(
          opentelemetryPlugin().setup(app),
      ).resolves.toBeUndefined();
    });

    it("先挂载 app.otel 再注册路由和中间件（extend → registerRoute → use）", async () => {
      const app = createMockApp();
      const callOrder: string[] = [];
      app.extend.mockImplementation(() => callOrder.push("extend"));
      app.adapter.registerRoute.mockImplementation(() => callOrder.push("registerRoute"));
      app.use.mockImplementation(() => callOrder.push("use"));

      await opentelemetryPlugin().setup(app);

      // extend → registerRoute(status) → use(tracing)
      expect(callOrder).toEqual(["extend", "registerRoute", "use"]);
    });
  });

  describe("SDK exporter 启动", () => {
    it("package endpoint fallback 在 SDK 未启动时先启动 SDK 再 attach exporter", async () => {
      mockResolvePackageOtelConfig.mockReturnValue({
        serviceName: "package-service",
        endpoint: "file",
        protocol: "http",
        headers: { authorization: "Bearer package" },
        samplingRatio: 0.5,
        metricIntervalMs: 5000,
      });
      const app = createMockApp();

      await opentelemetryPlugin().setup(app);

      expect(mockStartOtelSdk).toHaveBeenCalledWith({
        enabled: true,
        serviceName: "package-service",
        endpoint: "none",
        protocol: "http",
        headers: undefined,
        sampling: { ratio: 0.5 },
        metricIntervalMs: 5000,
      });
      expect(mockAttachExporterToSdk).toHaveBeenCalledWith({
        endpoint: "file",
        protocol: "http",
        headers: { authorization: "Bearer package" },
        insecure: undefined,
        serviceName: "package-service",
      });
    });

    it("SDK 已启动时只追加 exporter", async () => {
      process.env.VEXT_OTEL_SDK_STARTED = "1";
      const app = createMockApp({ endpoint: "file", protocol: "http" });

      await opentelemetryPlugin().setup(app);

      expect(mockAttachExporterToSdk).toHaveBeenCalledWith({
        endpoint: "file",
        protocol: "http",
        headers: undefined,
        insecure: undefined,
        serviceName: "vext-app",
      });
      expect(mockStartOtelSdk).not.toHaveBeenCalled();
    });

    it("app.config.otel.enabled=false 时 package endpoint 不会启动 SDK", async () => {
      mockResolvePackageOtelConfig.mockReturnValue({
        serviceName: "package-service",
        endpoint: "file",
      });
      const app = createMockApp({ enabled: false });

      await opentelemetryPlugin().setup(app);

      expect(mockStartOtelSdk).not.toHaveBeenCalled();
      expect(mockAttachExporterToSdk).not.toHaveBeenCalled();
    });
  });

  // ── 场景3: HTTP 指标创建 ─────────────────────────────────────────────────

  describe("HTTP 指标创建", () => {
    it("创建 http.server.duration 直方图，单位 ms", async () => {
      const app = createMockApp();

        await opentelemetryPlugin().setup(app);

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

        await opentelemetryPlugin().setup(app);

      expect(mockMeter.createCounter).toHaveBeenCalledWith(
        "http.server.request.total",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });

    it("创建 http.server.active_requests UpDownCounter", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app);

      expect(mockMeter.createUpDownCounter).toHaveBeenCalledWith(
        "http.server.active_requests",
        expect.objectContaining({ description: expect.any(String) }),
      );
    });

    it("使用默认 durationBuckets", async () => {
      const app = createMockApp();

      await opentelemetryPlugin().setup(app);

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
      }).setup(app);

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

        await opentelemetryPlugin({ serviceName: "options-service" }).setup(app);

      expect(mockGetTracer).toHaveBeenCalledWith("options-service");
      expect(mockGetMeter).toHaveBeenCalledWith("options-service");
    });

    it("config.otel.serviceName 作为第二优先级", async () => {
      const app = createMockApp({ serviceName: "config-service" });

        await opentelemetryPlugin().setup(app);

      expect(mockGetTracer).toHaveBeenCalledWith("config-service");
    });

    it("无任何配置时默认使用 'vext-app'", async () => {
      const app = createMockApp();

        await opentelemetryPlugin().setup(app);

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

        await plugin.setup(app);
      vi.clearAllMocks();
        await plugin.onClose?.(app);

      expect(app.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("flushing"),
      );
      expect(mockShutdownOtelSdk).toHaveBeenCalledTimes(1);
    });

    it("onClose 在 disabled 模式下不抛错", async () => {
      const app = createMockApp();
      const plugin = opentelemetryPlugin({ enabled: false });

        await plugin.setup(app);
        await expect(plugin.onClose?.(app)).resolves.toBeUndefined();
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

        await opentelemetryPlugin({ serviceName: "svc-1" }).setup(app1);
        await opentelemetryPlugin({ serviceName: "svc-2" }).setup(app2);

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
      await opentelemetryPlugin().setup(app);
      const otel = getMountedOtel(app);

      const result = await otel.withSpan("test.op", async () => "ok");

      expect(result).toBe("ok");
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it("异常路径：recordException + setStatus(ERROR) + span.end() + 异常 re-throw", async () => {
      const app = createMockApp();
      await opentelemetryPlugin().setup(app);
      const otel = getMountedOtel(app);

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
      await opentelemetryPlugin().setup(app);
      const otel = getMountedOtel(app);

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
      await opentelemetryPlugin().setup(app);
      const otel = getMountedOtel(app);

      await otel.withSpan("test.op", async (span: import("@opentelemetry/api").Span) => {
        span.setAttribute("payment.id", "pay-123");
      });

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("payment.id", "pay-123");
    });
  });
});
