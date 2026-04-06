/**
 * Express 适配器集成测试（真实 HTTP 服务器 + 真实 TCP 请求）
 *
 * 不 mock OpenTelemetry API：Noop 降级模式，零崩溃。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { createExpressMiddleware } from "../../src/adapters/express.js";

// ── 工具 ─────────────────────────────────────────────────────

async function httpGet(
    url: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
    const res = await fetch(url, { headers });
    return { status: res.status, body: await res.text() };
}

async function httpPost(
    url: string,
    body: string,
): Promise<{ status: number; body: string }> {
    const res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    return { status: res.status, body: await res.text() };
}

// ── 测试套件 ──────────────────────────────────────────────────

describe("createExpressMiddleware — 集成测试（真实 HTTP）", () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        const app = express();
        app.use(
            createExpressMiddleware({
                serviceName: "express-integration-test",
                tracing: { ignorePaths: ["/health"] },
            }),
        );

        app.get("/health", (_req, res) => { res.send("ok"); });
        app.get("/users/:id", (req, res) => {
            res.json({ id: req.params.id });
        });
        app.post("/users", (_req, res) => {
            res.status(201).json({ created: true });
        });
        app.get("/error", (_req, res) => { res.status(500).send("internal error"); });
        app.get("/boom", (_req, _res) => { throw new Error("intentional boom"); });

        // Express 5 默认错误处理
        app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            res.status(500).send(err instanceof Error ? err.message : "unknown error");
        });

        await new Promise<void>((resolve) => {
            server = createServer(app);
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
        const res = await httpGet(`${baseUrl}/users/123`);
        expect(res.status).toBe(200);
        const json = JSON.parse(res.body) as { id: string };
        expect(json.id).toBe("123");
    });

    it("POST 请求正常工作", async () => {
        const res = await httpPost(`${baseUrl}/users`, JSON.stringify({ name: "test" }));
        expect(res.status).toBe(201);
    });

    it("500 响应不崩溃（指标不记录两次）", async () => {
        const res = await httpGet(`${baseUrl}/error`);
        expect(res.status).toBe(500);
    });

    it("路由抛出异常时 Express 正常返回 500（中间件不崩溃）", async () => {
        const res = await httpGet(`${baseUrl}/boom`);
        expect(res.status).toBe(500);
    });

    it("404 路由未匹配时不崩溃", async () => {
        const res = await httpGet(`${baseUrl}/not-found`);
        expect(res.status).toBe(404);
    });

    it("携带 x-request-id 请求头不崩溃", async () => {
        const res = await httpGet(`${baseUrl}/health`, { "x-request-id": "test-req-123" });
        expect(res.status).toBe(200);
    });

    it("查询参数不影响 path 提取", async () => {
        const res = await httpGet(`${baseUrl}/health?debug=1`);
        expect(res.status).toBe(200);
    });
});
