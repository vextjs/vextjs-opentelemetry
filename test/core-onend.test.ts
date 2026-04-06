import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock instances（复用 core.test.ts 同款 mock 结构）─────────

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
        spanContext: vi.fn(() => ({
            traceId: "deadbeef0000000000000000cafebabe",
            spanId: "1234567890abcdef",
        })),
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

import { buildCoreHandlers } from "../src/core.js";
import type { OtelHttpContext } from "../src/types.js";

// ── 测试工具 ──────────────────────────────────────────────────

function makeCtx(overrides: Partial<OtelHttpContext> = {}): OtelHttpContext {
    return {
        method: "GET",
        path: "/api/items",
        route: undefined,
        requestId: "req-onend",
        headers: {},
        ...overrides,
    };
}

// ── onEnd 钩子（F-03）─────────────────────────────────────────

describe("buildCoreHandlers onEnd 钩子", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetActiveSpan.mockReturnValue(mockSpan as never);
    });

    // ── onRequestEnd 正常路径 ─────────────────────────────────

    it("onRequestEnd：onEnd 回调以正确字段被调用", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ onEnd });
        const state = handlers.onRequestStart(makeCtx());
        handlers.onRequestEnd(state, makeCtx({ route: "/api/:id" }), 200);

        expect(onEnd).toHaveBeenCalledOnce();
        const info = onEnd.mock.calls[0][0] as {
            traceId: string;
            method: string;
            route: string;
            latencyMs: number;
            statusCode: number;
        };
        expect(info.traceId).toBe("deadbeef0000000000000000cafebabe");
        expect(info.method).toBe("GET");
        expect(info.route).toBe("/api/:id");
        expect(typeof info.latencyMs).toBe("number");
        expect(info.latencyMs).toBeGreaterThanOrEqual(0);
        expect(info.statusCode).toBe(200);
    });

    it("onRequestEnd：route 未定义时回退到 path", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ onEnd });
        const state = handlers.onRequestStart(makeCtx());
        handlers.onRequestEnd(state, makeCtx({ route: undefined, path: "/api/items" }), 200);

        const info = onEnd.mock.calls[0][0] as { route: string };
        expect(info.route).toBe("/api/items");
    });

    it("onRequestEnd：4xx 状态码被正确透传", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ onEnd });
        const state = handlers.onRequestStart(makeCtx());
        handlers.onRequestEnd(state, makeCtx(), 404);

        const info = onEnd.mock.calls[0][0] as { statusCode: number };
        expect(info.statusCode).toBe(404);
    });

    it("onRequestEnd：span 不存在时 traceId 为空字符串", () => {
        mockGetActiveSpan.mockReturnValueOnce(undefined);
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ onEnd });
        const state = handlers.onRequestStart(makeCtx());
        handlers.onRequestEnd(state, makeCtx(), 200);

        const info = onEnd.mock.calls[0][0] as { traceId: string };
        expect(info.traceId).toBe("");
    });

    it("onRequestEnd：onEnd 未传时不抛错", () => {
        const handlers = buildCoreHandlers({});
        const state = handlers.onRequestStart(makeCtx());
        expect(() => handlers.onRequestEnd(state, makeCtx(), 200)).not.toThrow();
    });

    it("onRequestEnd：onEnd 抛错时 console.warn 但不传播异常", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const handlers = buildCoreHandlers({
            onEnd: () => {
                throw new Error("callback-err");
            },
        });
        const state = handlers.onRequestStart(makeCtx());

        expect(() => handlers.onRequestEnd(state, makeCtx(), 200)).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[vextjs-opentelemetry]"),
            expect.stringContaining("callback-err"),
        );
        warnSpy.mockRestore();
    });

    // ── onRequestError 异常路径 ───────────────────────────────

    it("onRequestError：onEnd 以 statusCode=500 被调用", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ onEnd });
        const state = handlers.onRequestStart(makeCtx());
        handlers.onRequestError(state, makeCtx({ route: "/api/:id" }), new Error("bad"));

        expect(onEnd).toHaveBeenCalledOnce();
        const info = onEnd.mock.calls[0][0] as {
            traceId: string;
            method: string;
            route: string;
            latencyMs: number;
            statusCode: number;
        };
        expect(info.statusCode).toBe(500);
        expect(info.traceId).toBe("deadbeef0000000000000000cafebabe");
        expect(info.method).toBe("GET");
        expect(info.route).toBe("/api/:id");
        expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("onRequestError：onEnd 未传时不抛错", () => {
        const handlers = buildCoreHandlers({});
        const state = handlers.onRequestStart(makeCtx());
        expect(() =>
            handlers.onRequestError(state, makeCtx(), new Error("x")),
        ).not.toThrow();
    });

    it("onRequestError：onEnd 抛错时 console.warn 但不传播异常", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const handlers = buildCoreHandlers({
            onEnd: () => {
                throw new Error("err-in-callback");
            },
        });
        const state = handlers.onRequestStart(makeCtx());

        expect(() =>
            handlers.onRequestError(state, makeCtx(), new Error("req-error")),
        ).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[vextjs-opentelemetry]"),
            expect.stringContaining("err-in-callback"),
        );
        warnSpy.mockRestore();
    });

    it("onRequestError：span 不存在时 traceId 为空字符串", () => {
        mockGetActiveSpan.mockReturnValueOnce(undefined);
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ onEnd });
        const state = handlers.onRequestStart(makeCtx());
        handlers.onRequestError(state, makeCtx(), new Error("no-span"));

        const info = onEnd.mock.calls[0][0] as { traceId: string };
        expect(info.traceId).toBe("");
    });
});
