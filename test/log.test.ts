import { describe, it, expect, vi, beforeEach } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";

import {
    createStructuredLogFormatter,
    createOtelLogBridge,
} from "../src/log.js";

// ── createStructuredLogFormatter ──────────────────────────────

describe("createStructuredLogFormatter", () => {
    // 固定 host，隔离 os.hostname()
    const BASE_OPTIONS = {
        serviceName: "test-svc",
        env: "test",
        host: "test-host",
    };

    it("输出固定字段（timestamp / level / message / service.name / env / host）", () => {
        const fmt = createStructuredLogFormatter(BASE_OPTIONS);
        const result = JSON.parse(fmt({ level: "info", message: "hello" }));

        expect(result.level).toBe("info");
        expect(result.message).toBe("hello");
        expect(result["service.name"]).toBe("test-svc");
        expect(result.env).toBe("test");
        expect(result.host).toBe("test-host");

        // timestamp 格式：YYYY-MM-DD HH:mm:ss
        expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("traceFields 默认为空字符串", () => {
        const fmt = createStructuredLogFormatter(BASE_OPTIONS);
        const result = JSON.parse(fmt({ level: "info", message: "hi" }));

        expect(result.trace_id).toBe("");
        expect(result.span).toBe("");
        expect(result.endpoint).toBe("");
        expect(result.latency_ms).toBe(0);
        expect(result.user_id).toBe("");
    });

    it("getTraceFields 回调返回的字段被填充", () => {
        const fmt = createStructuredLogFormatter({
            ...BASE_OPTIONS,
            getTraceFields: () => ({
                trace_id: "trace-abc",
                span: "span-def",
                endpoint: "/api/test",
                latency_ms: 42,
                user_id: "u-001",
            }),
        });
        const result = JSON.parse(fmt({ level: "info", message: "x" }));

        expect(result.trace_id).toBe("trace-abc");
        expect(result.span).toBe("span-def");
        expect(result.endpoint).toBe("/api/test");
        expect(result.latency_ms).toBe(42);
        expect(result.user_id).toBe("u-001");
    });

    it("getTraceFields 部分字段缺失时使用默认值", () => {
        const fmt = createStructuredLogFormatter({
            ...BASE_OPTIONS,
            getTraceFields: () => ({ trace_id: "t-id" }),
        });
        const result = JSON.parse(fmt({ level: "info", message: "y" }));

        expect(result.trace_id).toBe("t-id");
        expect(result.span).toBe("");
        expect(result.endpoint).toBe("");
        expect(result.latency_ms).toBe(0);
        expect(result.user_id).toBe("");
    });

    it("getTraceFields 抛错时 console.warn 并使用默认值", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const fmt = createStructuredLogFormatter({
            ...BASE_OPTIONS,
            getTraceFields: () => {
                throw new Error("boom");
            },
        });
        const result = JSON.parse(fmt({ level: "info", message: "z" }));

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[vextjs-opentelemetry]"),
            expect.stringContaining("boom"),
        );
        expect(result.trace_id).toBe("");
        warnSpy.mockRestore();
    });

    it("getCustomFields 回调返回的键值对被展开到输出", () => {
        const fmt = createStructuredLogFormatter({
            ...BASE_OPTIONS,
            getCustomFields: () => ({
                "feature.flag": "exp-42",
                "tenant.id": "T001",
            }),
        });
        const result = JSON.parse(fmt({ level: "info", message: "cust" }));

        expect(result["feature.flag"]).toBe("exp-42");
        expect(result["tenant.id"]).toBe("T001");
    });

    it("getCustomFields 抛错时 console.warn 并忽略", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const fmt = createStructuredLogFormatter({
            ...BASE_OPTIONS,
            getCustomFields: () => {
                throw new Error("custom-err");
            },
        });
        const result = JSON.parse(fmt({ level: "info", message: "q" }));

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[vextjs-opentelemetry]"),
            expect.stringContaining("custom-err"),
        );
        // 自定义字段为空，但固定字段正常
        expect(result["service.name"]).toBe("test-svc");
        warnSpy.mockRestore();
    });

    it("meta 中存在 err (Error) 时展开 exception.* 字段", () => {
        const fmt = createStructuredLogFormatter(BASE_OPTIONS);
        const err = new Error("something went wrong");
        const result = JSON.parse(fmt({ level: "error", message: "oops", err }));

        expect(result["exception.type"]).toBe("Error");
        expect(result["exception.message"]).toBe("something went wrong");
        expect(typeof result["exception.stacktrace"]).toBe("string");
    });

    it("meta 中存在 error (Error) 时展开 exception.* 字段", () => {
        const fmt = createStructuredLogFormatter(BASE_OPTIONS);
        const error = new TypeError("type error");
        const result = JSON.parse(fmt({ level: "error", message: "err", error }));

        expect(result["exception.type"]).toBe("TypeError");
        expect(result["exception.message"]).toBe("type error");
    });

    it("meta.err 非 Error 实例时不产生 exception.* 字段", () => {
        const fmt = createStructuredLogFormatter(BASE_OPTIONS);
        const result = JSON.parse(fmt({ level: "error", message: "raw", err: "string-err" }));

        expect(result["exception.type"]).toBeUndefined();
    });

    it("env 默认读取 process.env.NODE_ENV", () => {
        // vitest.config 设置 NODE_ENV=test
        const fmt = createStructuredLogFormatter({ serviceName: "s", host: "h" });
        const result = JSON.parse(fmt({ level: "info", message: "env-default" }));

        expect(result.env).toBe("test");
    });

    it("未传 env / NODE_ENV 也不存在时降级为 'production'", () => {
        const original = process.env["NODE_ENV"];
        delete process.env["NODE_ENV"];

        const fmt = createStructuredLogFormatter({ serviceName: "s", host: "h" });
        const result = JSON.parse(fmt({ level: "info", message: "prod" }));

        expect(result.env).toBe("production");
        // 恢复环境变量
        process.env["NODE_ENV"] = original;
    });

    it("level / message 缺失时使用默认值 'info' / ''", () => {
        const fmt = createStructuredLogFormatter(BASE_OPTIONS);
        const result = JSON.parse(fmt({}));

        expect(result.level).toBe("info");
        expect(result.message).toBe("");
    });
});

// ── createOtelLogBridge ───────────────────────────────────────

describe("createOtelLogBridge", () => {
    const mockEmit = vi.fn();
    const mockLogger = { emit: mockEmit };

    beforeEach(() => {
        mockEmit.mockClear();
    });

    it("调用 emit 时透传 body 和 severityText", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("info", "test message");

        expect(mockEmit).toHaveBeenCalledOnce();
        const call = mockEmit.mock.calls[0][0] as {
            body: string;
            severityText: string;
            severityNumber: number;
        };
        expect(call.body).toBe("test message");
        expect(call.severityText).toBe("INFO");
    });

    it("trace → SeverityNumber.TRACE", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("trace", "t");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.TRACE);
    });

    it("debug → SeverityNumber.DEBUG", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("debug", "d");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.DEBUG);
    });

    it("info → SeverityNumber.INFO", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("info", "i");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.INFO);
    });

    it("warn → SeverityNumber.WARN", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("warn", "w");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.WARN);
    });

    it("error → SeverityNumber.ERROR", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("error", "e");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.ERROR);
    });

    it("fatal → SeverityNumber.FATAL", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("fatal", "f");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.FATAL);
    });

    it("未知 level → SeverityNumber.UNSPECIFIED", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("verbose", "v");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.UNSPECIFIED);
    });

    it("level 大写也能正确映射", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("INFO", "upper");
        const call = mockEmit.mock.calls[0][0] as { severityNumber: number };
        expect(call.severityNumber).toBe(SeverityNumber.INFO);
    });

    it("attributes 被透传到 LogRecord", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("info", "with-attr", { endpoint: "/api/test", "user.id": "u1" });

        const call = mockEmit.mock.calls[0][0] as {
            attributes: Record<string, string>;
        };
        expect(call.attributes).toEqual({ endpoint: "/api/test", "user.id": "u1" });
    });

    it("无 attributes 时不传 attributes 字段（或传空对象）", () => {
        const bridge = createOtelLogBridge(() => mockLogger);
        bridge.emit("info", "no-attr");

        // 实现省略了空 attributes，确保 emit 被调用且不抛
        expect(mockEmit).toHaveBeenCalledOnce();
    });

    it("getLogger() 返回 null 时静默 noop（不抛错）", () => {
        const bridge = createOtelLogBridge(() => null);
        expect(() => bridge.emit("info", "silent")).not.toThrow();
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it("getLogger() 返回 undefined 时静默 noop（不抛错）", () => {
        const bridge = createOtelLogBridge(() => undefined);
        expect(() => bridge.emit("info", "silent")).not.toThrow();
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it("getLogger() 抛错时静默 noop（不传播异常）", () => {
        const bridge = createOtelLogBridge(() => {
            throw new Error("getLogger-err");
        });
        expect(() => bridge.emit("info", "safe")).not.toThrow();
        expect(mockEmit).not.toHaveBeenCalled();
    });
});
