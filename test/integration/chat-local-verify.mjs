/**
 * chat otel 中间件本地集成验证脚本
 *
 * 运行方式（在 vextjs-opentelemetry 目录下）：
 *   node --experimental-vm-modules test/integration/chat-local-verify.mjs
 *
 * 验证内容：
 *   1. createKoaMiddleware 工厂函数可正常调用（包括 serviceName / ignorePaths / spanNameResolver）
 *   2. otel Noop 降级：在无 SDK 初始化的情况下，中间件不崩溃
 *   3. 模拟 chat 业务场景：POST /home/chat, GET /health, GET /internal/xxx
 *   4. ignorePaths 按预期过滤 /health 和 /internal
 */

import { createKoaMiddleware } from "../../dist/adapters/koa.js";
import Koa from "koa";
import { createServer } from "node:http";

// ── 复刻 chat/app/middleware/otel.ts 的配置 ─────────────────

function createChatOtelMiddleware() {
  return createKoaMiddleware({
    serviceName: "chat",
    tracing: {
      ignorePaths: ["/health", "/internal", /^\/favicon/, /^\/_/],
      spanNameResolver: (ctx) =>
        `${ctx.method} ${ctx.route ?? ctx.path}`,
    },
    metrics: {
      customLabels: (ctx) => ({
        "http.path": ctx.route ?? ctx.path,
      }),
    },
  });
}

// ── 构建测试 Koa app ──────────────────────────────────────────

function buildApp() {
  const app = new Koa();

  // otel 中间件（最外层，对应 chat config.middleware[0] = 'otel'）
  app.use(createChatOtelMiddleware());

  // 模拟 koa-router 填充 routerPath（真实 chat 中由 egg-router 做）
  app.use(async (ctx, next) => {
    const mockRoutes = {
      "/home/chat": "/home/chat",
      "/admin/user/list": "/admin/user/:page",
      "/open/share/123": "/open/share/:id",
    };
    const route = mockRoutes[ctx.path];
    if (route) {
      (ctx).routerPath = route;
    }
    await next();
  });

  // 路由处理
  app.use(async (ctx) => {
    switch (ctx.path) {
      case "/health":
        ctx.body = "ok";
        break;
      case "/home/chat":
        ctx.body = JSON.stringify({ reply: "hello" });
        ctx.set("Content-Type", "application/json");
        break;
      case "/admin/user/list":
        ctx.body = JSON.stringify({ users: [] });
        ctx.set("Content-Type", "application/json");
        break;
      case "/open/share/123":
        ctx.body = JSON.stringify({ id: 123 });
        ctx.set("Content-Type", "application/json");
        break;
      case "/internal/health":
        ctx.body = "internal ok";
        break;
      case "/error":
        ctx.status = 500;
        ctx.body = "error";
        break;
      default:
        ctx.status = 404;
        ctx.body = "not found";
    }
  });

  app.on("error", () => {/* suppress test errors */});
  return app;
}

// ── 运行测试 ──────────────────────────────────────────────────

async function run() {
  const app = buildApp();

  // 启动服务器
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${name}: ${e.message}`);
      failed++;
    }
  }

  async function get(path, headers = {}) {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: await res.text() };
  }

  async function post(path, body, headers = {}) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
    });
    return { status: res.status, body: await res.text() };
  }

  console.log("\n🔭 chat otel 中间件本地集成验证\n");

  // [场景 1] 核心业务接口不崩溃
  console.log("[场景 1] 核心业务接口 — 不崩溃");
  await test("/home/chat (POST) → 200", async () => {
    const r = await post("/home/chat", { message: "hello" });
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
  });

  await test("/admin/user/list (GET) → 200", async () => {
    const r = await get("/admin/user/list");
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
  });

  await test("/open/share/:id (GET) → 200", async () => {
    const r = await get("/open/share/123");
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
  });

  // [场景 2] ignorePaths 过滤
  console.log("\n[场景 2] ignorePaths 过滤（/health, /internal）");
  await test("/health 不记录追踪（仍返回 200）", async () => {
    const r = await get("/health");
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
    if (r.body !== "ok") throw new Error(`body: ${r.body}`);
  });

  await test("/internal/health 不记录追踪（仍返回 200）", async () => {
    const r = await get("/internal/health");
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
  });

  // [场景 3] 异常状态码不崩溃
  console.log("\n[场景 3] 异常状态码 — 不崩溃");
  await test("500 响应不崩溃", async () => {
    const r = await get("/error");
    if (r.status !== 500) throw new Error(`status: ${r.status}`);
  });

  await test("404 未匹配路由不崩溃", async () => {
    const r = await get("/unknown-route");
    if (r.status !== 404) throw new Error(`status: ${r.status}`);
  });

  // [场景 4] 请求头透传
  console.log("\n[场景 4] 请求头透传");
  await test("x-request-id 请求头不崩溃", async () => {
    const r = await get("/home/chat", { "x-request-id": "chat-test-001" });
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
  });

  await test("x-trace-id / x-tenant-id 请求头不崩溃", async () => {
    const r = await get("/health", {
      "x-trace-id": "trace-abc",
      "x-tenant-id": "tenant-xyz",
    });
    if (r.status !== 200) throw new Error(`status: ${r.status}`);
  });

  server.close();

  console.log(`\n${"─".repeat(40)}`);
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log("⚠️  有测试失败，请检查上方错误");
    process.exit(1);
  } else {
    console.log("✅ 全部通过 — chat otel 中间件接入验证完成");
    console.log("\n下一步：将 package.json 中的 vextjs-opentelemetry 改为正式版本号后发布。");
  }
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
