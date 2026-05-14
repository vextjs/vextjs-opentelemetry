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

import { buildCoreHandlers } from "../src/core/http-core.js";
import type { HttpObservationContext } from "../src/core/types.js";

// ── 测试工具 ──────────────────────────────────────────────────

function makeCtx(overrides: Partial<HttpObservationContext> = {}): HttpObservationContext {
    return {
        phase: "start",
        method: "GET",
        path: "/api/items",
        route: undefined,
        requestId: "req-onend",
        headers: {},
        ...overrides,
    };
}

// ── lifecycle.onEnd 钩子（F-03）────────────────────────────────

describe("buildCoreHandlers lifecycle.onEnd 钩子", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetActiveSpan.mockReturnValue(mockSpan as never);
    });

    // ── onRequestEnd 正常路径 ─────────────────────────────────

    it("onRequestEnd：lifecycle.onEnd 回调以正确字段被调用", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ lifecycle: { onEnd } });
        const state = handlers.onRequestStart(makeCtx(), undefined);
        const raw = { framework: "koa" };
        const endCtx = makeCtx({ phase: "end", route: "/api/:id" });
        handlers.onRequestEnd(state, endCtx, 200, raw);

        expect(onEnd).toHaveBeenCalledOnce();
        expect(onEnd).toHaveBeenCalledWith(
            expect.objectContaining({ phase: "end", route: "/api/:id", statusCode: 200 }),
            raw,
            expect.objectContaining({
                traceId: "deadbeef0000000000000000cafebabe",
                statusCode: 200,
                latencyMs: expect.any(Number),
            }),
        );
        const info = onEnd.mock.calls[0][2] as {
            traceId: string;
            latencyMs: number;
            statusCode: number;
        };
        expect(info.traceId).toBe("deadbeef0000000000000000cafebabe");
        expect(typeof info.latencyMs).toBe("number");
        expect(info.latencyMs).toBeGreaterThanOrEqual(0);
        expect(info.statusCode).toBe(200);
    });

    it("onRequestEnd：route 未定义时回退到 path", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ lifecycle: { onEnd } });
        const state = handlers.onRequestStart(makeCtx(), undefined);
        handlers.onRequestEnd(state, makeCtx({ phase: "end", route: undefined, path: "/api/items" }), 200, undefined);

        const endCtx = onEnd.mock.calls[0][0] as { route: string };
        expect(endCtx.route).toBe("/api/items");
    });

    it("onRequestEnd：4xx 状态码被正确透传", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ lifecycle: { onEnd } });
        const state = handlers.onRequestStart(makeCtx(), undefined);
        handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 404, undefined);

        const info = onEnd.mock.calls[0][2] as { statusCode: number };
        expect(info.statusCode).toBe(404);
    });

    it("onRequestEnd：span 不存在时 lifecycle.onEnd 中 traceId 为空字符串", () => {
        mockGetActiveSpan.mockReturnValueOnce(undefined);
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ lifecycle: { onEnd } });
        const state = handlers.onRequestStart(makeCtx(), undefined);
        handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 200, undefined);

        const info = onEnd.mock.calls[0][2] as { traceId: string };
        expect(info.traceId).toBe("");
    });

    it("onRequestEnd：lifecycle.onEnd 未传时不抛错", () => {
        const handlers = buildCoreHandlers({});
        const state = handlers.onRequestStart(makeCtx(), undefined);
        expect(() => handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 200, undefined)).not.toThrow();
    });

    it("onRequestEnd：lifecycle.onEnd 抛错时 console.warn 但不传播异常", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const handlers = buildCoreHandlers({
            lifecycle: { onEnd: () => { throw new Error("callback-err"); } },
        });
        const state = handlers.onRequestStart(makeCtx(), undefined);

        expect(() => handlers.onRequestEnd(state, makeCtx({ phase: "end" }), 200, undefined)).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[vextjs-opentelemetry]"),
            expect.stringContaining("callback-err"),
        );
        warnSpy.mockRestore();
    });

    // ── onRequestError 异常路径 ───────────────────────────────

    it("onRequestError：lifecycle.onEnd 以 statusCode=500 被调用", () => {
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ lifecycle: { onEnd } });
        const state = handlers.onRequestStart(makeCtx(), undefined);
        const raw = { framework: "express" };
        handlers.onRequestError(state, makeCtx({ phase: "end", route: "/api/:id" }), new Error("bad"), raw);

        expect(onEnd).toHaveBeenCalledOnce();
        expect(onEnd).toHaveBeenCalledWith(
            expect.objectContaining({ phase: "end", route: "/api/:id", statusCode: 500 }),
            raw,
            expect.objectContaining({
                traceId: "deadbeef0000000000000000cafebabe",
                statusCode: 500,
                latencyMs: expect.any(Number),
                error: expect.any(Error),
            }),
        );
        const info = onEnd.mock.calls[0][2] as {
            traceId: string;
            latencyMs: number;
            statusCode: number;
        };
        expect(info.statusCode).toBe(500);
        expect(info.traceId).toBe("deadbeef0000000000000000cafebabe");
        expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("onRequestError：lifecycle.onEnd 未传时不抛错", () => {
        const handlers = buildCoreHandlers({});
        const state = handlers.onRequestStart(makeCtx(), undefined);
        expect(() =>
            handlers.onRequestError(state, makeCtx({ phase: "end" }), new Error("x"), undefined),
        ).not.toThrow();
    });

    it("onRequestError：lifecycle.onEnd 抛错时 console.warn 但不传播异常", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const handlers = buildCoreHandlers({
            lifecycle: { onEnd: () => { throw new Error("err-in-callback"); } },
        });
        const state = handlers.onRequestStart(makeCtx(), undefined);

        expect(() =>
            handlers.onRequestError(state, makeCtx({ phase: "end" }), new Error("req-error"), undefined),
        ).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[vextjs-opentelemetry]"),
            expect.stringContaining("err-in-callback"),
        );
        warnSpy.mockRestore();
    });

    it("onRequestError：span 不存在时 lifecycle.onEnd 中 traceId 为空字符串", () => {
        mockGetActiveSpan.mockReturnValueOnce(undefined);
        const onEnd = vi.fn();
        const handlers = buildCoreHandlers({ lifecycle: { onEnd } });
        const state = handlers.onRequestStart(makeCtx(), undefined);
        handlers.onRequestError(state, makeCtx({ phase: "end" }), new Error("no-span"), undefined);

        const info = onEnd.mock.calls[0][2] as { traceId: string };
        expect(info.traceId).toBe("");
    });
});
