/**
 * Koa 适配器集成测试（真实 HTTP 服务器 + 真实 TCP 请求）
 *
 * 不 mock OpenTelemetry API：适配器在 SDK 未初始化时降级为 Noop，零崩溃。
 * 这也同步验证 Egg.js 接入可行性（Egg.js 中间件签名与 Koa 完全相同）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Koa from "koa";
import { createServer, type Server } from "node:http";
import { createKoaMiddleware } from "../../src/adapters/koa.js";

// ── 工具：发起 HTTP 请求并返回响应 ────────────────────────────

async function httpGet(
    url: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const res = await fetch(url, { headers });
    const body = await res.text();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    return { status: res.status, body, headers: resHeaders };
}

// ── 测试套件 ──────────────────────────────────────────────────

describe("createKoaMiddleware — 集成测试（真实 HTTP）", () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        const app = new Koa();
        app.use(
            createKoaMiddleware({
                serviceName: "koa-integration-test",
                tracing: { ignorePaths: ["/health"] },
            }),
        );

        // 模拟 koa-router 填充 routerPath
        app.use(async (ctx, next) => {
            if (ctx.path === "/users/42") {
                (ctx as Koa.Context & { routerPath: string }).routerPath = "/users/:id";
            }
            await next();
        });

        // 路由处理
        app.use(async (ctx) => {
            if (ctx.path === "/health") {
                ctx.body = "ok";
            } else if (ctx.path === "/users/42") {
                ctx.body = JSON.stringify({ id: 42 });
                ctx.set("Content-Type", "application/json");
            } else if (ctx.path === "/error") {
                ctx.status = 500;
                ctx.body = "internal error";
            } else if (ctx.path === "/boom") {
                throw new Error("intentional boom");
            } else {
                ctx.status = 404;
                ctx.body = "not found";
            }
        });

        // 错误处理（防止未捕获异常导致测试进程崩溃）
        app.on("error", () => { /* suppress test errors */ });

        await new Promise<void>((resolve) => {
            server = createServer(app.callback());
            server.listen(0, "127.0.0.1", resolve);
        });

        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(() => {
        server.close();
    });

    it("200 请求正常响应", async () => {
        const res = await httpGet(`${baseUrl}/health`);
        expect(res.status).toBe(200);
        expect(res.body).toBe("ok");
    });

    it("参数化路由 /users/:id 响应正确", async () => {
        const res = await httpGet(`${baseUrl}/users/42`);
        expect(res.status).toBe(200);
        const json = JSON.parse(res.body) as { id: number };
        expect(json.id).toBe(42);
    });

    it("500 响应不崩溃", async () => {
        const res = await httpGet(`${baseUrl}/error`);
        expect(res.status).toBe(500);
    });

    it("404 响应不崩溃", async () => {
        const res = await httpGet(`${baseUrl}/not-found`);
        expect(res.status).toBe(404);
    });

    it("携带 x-request-id 请求头不崩溃", async () => {
        const res = await httpGet(`${baseUrl}/health`, { "x-request-id": "test-req-id" });
        expect(res.status).toBe(200);
    });

    it("路由抛出异常时 Koa 正常返回 500（中间件不崩溃）", async () => {
        // Koa 的默认错误处理：未捕获的错误 → 500
        const res = await httpGet(`${baseUrl}/boom`);
        expect(res.status).toBe(500);
    });

    it("ignorePaths 不影响正常响应（/health 仍返回 200）", async () => {
        const res = await httpGet(`${baseUrl}/health`);
        expect(res.status).toBe(200);
    });

    // ── Egg.js 场景验证 ────────────────────────────────────────
    // Egg.js 的中间件注册等价于：
    //   export default (_options, _app) => createKoaMiddleware({ ... });
    //   // config.default.ts → middleware: ["otel"]
    // 以下测试证明中间件在 Koa 上正常运行，即 Egg.js 同样兼容。
    it("Egg.js 场景：serviceName 配置不崩溃", async () => {
        const app2 = new Koa();
        // 模拟 Egg.js 中间件工厂调用方式
        const eggMiddlewareFactory = (
            _options: unknown,
            _app: unknown,
        ) => createKoaMiddleware({ serviceName: "my-egg-app" });

        app2.use(eggMiddlewareFactory(undefined, undefined));
        app2.use(async (ctx) => { ctx.body = "egg ok"; });
        app2.on("error", () => { });

        const server2 = await new Promise<Server>((resolve) => {
            const s = createServer(app2.callback());
            s.listen(0, "127.0.0.1", () => resolve(s));
        });

        try {
            const addr = server2.address() as { port: number };
            const res = await httpGet(`http://127.0.0.1:${addr.port}/ping`);
            expect(res.status).toBe(200);
            expect(res.body).toBe("egg ok");
        } finally {
            server2.close();
        }
    });
});
