# vextjs-opentelemetry

> 多框架 OpenTelemetry 集成 — 零配置追踪、指标与日志，支持 VextJS / Egg.js / Koa / Express / Hono / Fastify

[![npm version](https://img.shields.io/npm/v/vextjs-opentelemetry.svg)](https://www.npmjs.com/package/vextjs-opentelemetry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

将原本需要手写的 ~200 行 OpenTelemetry 样板代码压缩为极简配置，开箱即得完整的可观测性三大支柱：Traces（链路追踪）、Metrics（指标监控）、Logs（日志关联）。

---

## 特性

- **追踪** — 自动标注 HTTP Span 属性（路由、状态码、请求 ID）
- **指标** — 内置 HTTP 请求时长直方图、请求总数、活跃请求数
- **日志关联** — 自动将 `trace_id` 注入每条请求日志
- **gRPC h2c** — 原生 `node:http2` 实现，兼容自建 Jaeger / K8s OTel Collector
- **优雅降级** — SDK 未初始化时以 Noop 模式运行，零 overhead
- **多框架** — VextJS / Egg.js / Koa / Express / Hono / Fastify

---

## 安装

```bash
# 必须安装
npm install vextjs-opentelemetry @opentelemetry/api

# SDK 运行时（实际发送遥测数据时必须）
npm install @opentelemetry/sdk-node

# 自动检测 HTTP、fetch、数据库等（按需选择）
npm install @opentelemetry/instrumentation-http \
            @opentelemetry/instrumentation-mongodb \
            @opentelemetry/instrumentation-ioredis \
            @opentelemetry/instrumentation-mysql2
```

---

## 端点格式说明

所有框架的 `endpoint` 字段遵循相同规则：

| 格式 | 传输协议 | 适用场景 |
|------|---------|---------|
| `"host:port"` | gRPC h2c（明文 HTTP/2）| 内网/自建 Collector（Jaeger、K8s OTel Collector） |
| `"http://host:port"` | OTLP HTTP | 公网或明确需要 HTTP |
| `"none"` / 不传 | 不上报 | 本地开发、测试 |

> **为什么默认用 gRPC h2c？** `@grpc/grpc-js` 与部分自建采集器的 h2c 握手不兼容（永远 CONNECTING）。本实现直接用 `node:http2`，绕开此问题，兼容性更好。

---

## VextJS 框架

```typescript
// src/plugins/otel.ts
import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs";

export default opentelemetryPlugin({
  serviceName: "my-app",
  endpoint: "47.89.182.109:32767",  // host:port → gRPC h2c
  protocol: "grpc",

  tracing: {
    ignorePaths: ["/health", "/_otel/status"],
    spanNameResolver: (req) => `${req.method} ${String(req.route ?? req.path)}`,
  },

  metrics: {
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    customLabels: () => ({ "deployment.environment": process.env.NODE_ENV ?? "development" }),
  },

  logs: {
    bridgeAppLogger: true,
    globalAttributes: { "app.version": "1.0.0" },
  },

  onEnd: (info) => {
    if (info.statusCode >= 500) {
      console.warn(`[otel] ${info.method} ${info.route} → ${info.statusCode} trace=${info.traceId}`);
    }
  },
});
```

VextJS 使用 `vext start` / `vext dev` 时 SDK 自动注入（通过 `vext.preload` 机制）；自定义启动脚本需手动加 `--import`：

```json
{
  "scripts": {
    "start": "node --import vextjs-opentelemetry/instrumentation dist/server.js"
  }
}
```

---

## Egg.js

Egg.js 采用 CJS `--require` 预加载模式，**SDK 必须在任何模块加载前完成初始化**。

### Step 1：SDK 初始化（`app/otel-init.cjs`）

```javascript
'use strict';
const { initOtel } = require('vextjs-opentelemetry/koa');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
const { MySQL2Instrumentation } = require('@opentelemetry/instrumentation-mysql2');

initOtel({
  serviceName: 'my-service',
  endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || '47.89.182.109:32767', // host:port → gRPC h2c
  instrumentations: [
    new HttpInstrumentation(),
    new UndiciInstrumentation(),
    new MongoDBInstrumentation(),
    new IORedisInstrumentation(),
    new MySQL2Instrumentation(),
  ],
});
```

### Step 2：`package.json` scripts 添加 `--require`

```json
{
  "scripts": {
    "dev":   "egg-bin dev --require ./app/otel-init.cjs",
    "start": "egg-scripts start --require ./app/otel-init.cjs"
  }
}
```

### Step 3：OTel 中间件（`app/middleware/otel.ts`）

```typescript
import { createEggMiddleware } from 'vextjs-opentelemetry/egg';

export default createEggMiddleware({
  serviceName: 'my-service',
  tracing: {
    ignorePaths: [/^\/favicon/, /^\/_/, '/health'],
    spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`,
  },
  metrics: {
    customLabels: (ctx) => ({ 'http.path': ctx.route ?? ctx.path }),
  },
  // 业务字段注入（每个服务按需实现）
  onCtxInit: (ctx) => {
    ctx.user_id = ctx.state?.userId ?? ctx.state?.user?.id ?? '';
    ctx.feature_flag = ctx.get('x-feature-flag') || '';
  },
  // 自定义 access log
  onRequestDone: (ctx, info) => {
    ctx.logger.info(`${info.method} ${ctx.status} ${info.route} ${info.latencyMs}ms`);
  },
});
```

> **`createEggMiddleware` 自动注入的 ctx 字段**（无需手动写）：
> - `trace_id` — 当前请求的 W3C trace ID
> - `span_name` — `${method} ${routerPath}`
> - `endpoint` — routerPath
> - `latency_ms` — 请求总耗时（ms）

在 `typings/index.d.ts` 声明这些字段以消除 TypeScript 报错：

```typescript
declare module 'egg' {
  interface Context {
    trace_id: string;
    span_name: string;
    endpoint: string;
    latency_ms: number;
    user_id: string;
    feature_flag: string;
  }
}
```

### Step 4：注册到中间件列表

```typescript
// config/config.default.ts
config.middleware = ['otel', /* 其他中间件 */];
```

### Step 5：`ctx.withSpan` 扩展（可选）

```typescript
// app/extend/context.ts
import { createWithSpan } from 'vextjs-opentelemetry';
export default { withSpan: createWithSpan('my-service') };
```

### Step 6：`/_otel/status` 路由

```typescript
// app/router.ts
import { getOtelStatus } from 'vextjs-opentelemetry';

router.get('/_otel/status', async (ctx) => {
  ctx.body = getOtelStatus();  // 无参，自动读取环境变量
});
```

---

## Koa

```typescript
// app.ts — SDK 初始化需在此之前通过 --import 或 --require 完成
import Koa from "koa";
import { createKoaMiddleware } from "vextjs-opentelemetry/koa";
import { getOtelStatus } from "vextjs-opentelemetry";

const app = new Koa();

app.use(createKoaMiddleware({
  serviceName: "my-koa-app",
  tracing: { ignorePaths: ["/health", "/_otel/status"] },
}));

app.use(async (ctx, next) => {
  if (ctx.path === "/_otel/status") {
    ctx.body = getOtelStatus();
    return;
  }
  await next();
});
```

Koa 的 `otel-init.cjs`（与 Egg.js 完全相同）：

```javascript
'use strict';
const { initOtel } = require('vextjs-opentelemetry/koa');
initOtel({
  serviceName: 'my-koa-app',
  endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || '47.89.182.109:32767',
  instrumentations: [ /* ... */ ],
});
```

---

## Express

```typescript
import express from "express";
import { createExpressMiddleware } from "vextjs-opentelemetry/express";
import { getOtelStatus } from "vextjs-opentelemetry";

const app = express();

app.use(createExpressMiddleware({
  serviceName: "my-express-app",
  tracing: { ignorePaths: ["/health"] },
}));

app.get("/_otel/status", (_req, res) => res.json(getOtelStatus()));
```

---

## Hono

```typescript
import { Hono } from "hono";
import { createHonoMiddleware } from "vextjs-opentelemetry/hono";
import { getOtelStatus } from "vextjs-opentelemetry";

const app = new Hono();
app.use(createHonoMiddleware({ serviceName: "my-hono-app" }));
app.get("/_otel/status", (c) => c.json(getOtelStatus()));
```

---

## Fastify

```typescript
import Fastify from "fastify";
import { createFastifyPlugin } from "vextjs-opentelemetry/fastify";
import { getOtelStatus } from "vextjs-opentelemetry";

const fastify = Fastify();
await fastify.register(createFastifyPlugin({ serviceName: "my-fastify-app" }));
fastify.get("/_otel/status", () => getOtelStatus());
```

---

## 通用配置接口（HttpOtelOptions）

所有框架适配器（VextJS 除外）共用此配置接口：

```typescript
import type { HttpOtelOptions } from "vextjs-opentelemetry";

const options: HttpOtelOptions = {
  serviceName: "my-app",

  tracing: {
    enabled: true,
    ignorePaths: ["/health", /^\/internal\//],
    spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`,
    extraAttributes: (ctx) => ({ "tenant.id": ctx.headers["x-tenant-id"] ?? "" }),
  },

  metrics: {
    enabled: true,
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    customLabels: (ctx) => ({ "api.version": ctx.headers["x-api-version"] ?? "v1" }),
  },

  onEnd: (info) => {
    // info: { traceId, method, route, latencyMs, statusCode }
    console.log(`${info.method} ${info.route} ${info.statusCode} ${info.latencyMs}ms`);
  },
};
```

**Egg.js 专属扩展**（`EggHttpOtelOptions`）：

```typescript
// onCtxInit: span 创建前执行，注入业务字段到 ctx
onCtxInit: (ctx) => {
  ctx.user_id = ctx.state?.userId ?? '';
  ctx.feature_flag = ctx.get('x-feature-flag') || '';
},

// onRequestDone: 请求完成后执行（finally 块，span/指标操作已完成）
onRequestDone: (ctx, info) => {
  // info: { method, route, latencyMs }
  ctx.logger.info(`${info.method} ${ctx.status} ${info.route} ${info.latencyMs}ms`);
},
```

---

## 内置指标

| 指标名称 | 类型 | 标签 |
|---------|------|------|
| `http.server.duration` | Histogram (ms) | method / status_code / route |
| `http.server.request.total` | Counter | method / status_code / route |
| `http.server.active_requests` | UpDownCounter | method |

---

## 在代码中访问

```typescript
import { createWithSpan, getActiveTraceId, getOtelStatus } from "vextjs-opentelemetry";

const withSpan = createWithSpan("my-service");

// 最简用法
const result = await withSpan("db.user.find", () => UserModel.findById(id));

// 动态标注 span 属性
const result = await withSpan("payment.process", async (span) => {
  const res = await processPayment(body);
  span.setAttribute("payment.result", res.status);
  return res;
});

// 带初始属性
const result = await withSpan(
  "payment.process",
  () => processPayment(body),
  { attributes: { "payment.provider": "stripe" } },
);

// 获取当前 trace ID
const traceId = getActiveTraceId(); // 无 active span 时返回 ''

// 获取 SDK 状态
console.log(getOtelStatus()); // { sdk: "initialized", exportMode: "otlp-grpc", ... }
```

---

## 框架差异对比

| 特性 | VextJS | Egg.js / Koa | Express / Hono / Fastify |
|------|--------|-------------|------------------------|
| SDK 初始化 | `--import`（自动/手动）| `--require otel-init.cjs` | `--import` 或文件顶部 |
| exporter 配置位置 | plugin options | `initOtel()` | `initOtel()` |
| 中间件 | `opentelemetryPlugin()` | `createEggMiddleware()` | `createXxxMiddleware()` |
| 业务字段注入 | 不适用 | `onCtxInit` 回调 | 手动 |
| logger bridge | `logs.bridgeAppLogger` | `createOtelLogBridge` | 手动 |
| `onCtxInit` / `onRequestDone` | ❌ | ✅ Egg/Koa 专属 | ❌ |

---

## 文档

📖 **[完整文档 → vextjs.github.io/vext/examples/opentelemetry.html](https://vextjs.github.io/vext/examples/opentelemetry.html)**

---

## 许可证

MIT © VextJS Contributors

