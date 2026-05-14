# vextjs-opentelemetry

> 多框架 OpenTelemetry 集成 — 零配置追踪、指标与日志，支持 VextJS / Egg.js / Koa / Express / Hono / Fastify

[![npm version](https://img.shields.io/npm/v/vextjs-opentelemetry.svg)](https://www.npmjs.com/package/vextjs-opentelemetry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

将原本需要手写的 ~200 行 OpenTelemetry 样板代码压缩为极简配置，开箱即得完整的可观测性三大支柱：Traces（链路追踪）、Metrics（指标监控）、Logs（日志关联）。

---

## 目录导航

- [特性](#特性)
- [安装](#安装)
- [端点格式说明](#端点格式说明)
- [VextJS 框架](#vextjs-框架)
- [Egg.js](#eggjs)
- [Koa](#koa)
- [Express](#express)
- [Hono](#hono)
- [Fastify](#fastify)
- [通用配置接口（HttpOtelOptions）](#通用配置接口httpoteloptions)
- [内置指标](#内置指标)
- [在代码中访问](#在代码中访问)
- [框架差异对比](#框架差异对比)
- [兼容性与升级建议](#兼容性与升级建议)
- [文档](#文档)
- [许可证](#许可证)

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

> **Node.js 要求**：`vextjs-opentelemetry` 当前声明 `engines.node >= 18`。
> 若你的服务 `package.json` 仍写 `>=16`，升级依赖前请先确认实际运行环境已是 Node 18+；否则安装阶段可能只给 warning，但运行时不属于受支持范围。

```bash
# 常规接入（VextJS / Koa / Express / Hono / Fastify）
npm install vextjs-opentelemetry

# 仅当你的应用代码“直接 import”这些包时，再显式声明为应用依赖
# 例如 Egg/Koa 的 otel-init.cjs 手动 new Instrumentation() 的场景
npm install @opentelemetry/instrumentation-http \
            @opentelemetry/instrumentation-mongodb \
            @opentelemetry/instrumentation-ioredis \
            @opentelemetry/instrumentation-mysql2
```

> `vextjs-opentelemetry` 已内置 `@opentelemetry/api`、`@opentelemetry/sdk-node` 和常用 OTLP exporter；
> 对于正常接入，**不需要**再重复安装这些包。只有当你的业务代码要直接 `import { NodeSDK } ...` / `import { SpanStatusCode } ...` 时，才建议把对应包声明为应用自己的直接依赖。

---

## 端点格式说明

所有框架的 `endpoint` 字段遵循相同规则：

| 格式                 | 传输协议                | 适用场景                                          |
| -------------------- | ----------------------- | ------------------------------------------------- |
| `"host:port"`        | gRPC h2c（明文 HTTP/2） | 内网/自建 Collector（Jaeger、K8s OTel Collector） |
| `"http://host:port"` | OTLP HTTP               | 公网或明确需要 HTTP                               |
| `"none"` / 不传      | 不上报                  | 本地开发、测试                                    |

> **为什么默认用 gRPC h2c？** `@grpc/grpc-js` 与部分自建采集器的 h2c 握手不兼容（永远 CONNECTING）。本实现直接用 `node:http2`，绕开此问题，兼容性更好。

> **导出日志策略**：默认只保留**真正已配置导出目标时的启动摘要**、**首次失败告警**与**失败后的首次恢复提示**。
> 不会为每一批成功导出持续打印 `Trace/Metrics/Logs export OK`；当处于 `deferred export`（等待插件 setup 接管）时，也不会默认打印启动摘要，避免在 VextJS 场景中误导用户把阶段性状态当成最终状态。

---

## VextJS 框架

> `opentelemetryPlugin({ serviceName })` 会影响运行期 tracer / meter / logger 的命名；
> **真正写入 SDK Resource 的 `service.name`** 发生在 `instrumentation` 预加载阶段。
> 因此 VextJS 场景推荐在应用侧 `package.json` 中显式声明 `vext.otel.serviceName`；
> 若未声明，插件会自动回退到当前应用的 `package.json.name`，最后才回退为 `vext-app`。
>
> `endpoint / protocol / headers` 也是同样的两阶段关系：
> - `package.json vext.otel.*`：影响预加载阶段的 SDK 初始配置；
> - `opentelemetryPlugin({...})`：在 setup 阶段可继续追加/覆盖导出配置。
>
> 若希望 `/_otel/status`、启动摘要和最终导出目标从一开始就保持一致，优先把导出配置写在 `package.json vext.otel.*`。

```json
{
  "name": "admin",
  "vext": {
    "otel": {
      "serviceName": "admin",
      "endpoint": "47.89.182.109:32767",
      "protocol": "grpc"
    }
  }
}
```

```typescript
// src/plugins/otel.ts
import { opentelemetryPlugin } from "vextjs-opentelemetry/vextjs";

export default opentelemetryPlugin({
  serviceName: "my-app",
  endpoint: "47.89.182.109:32767", // host:port → gRPC h2c
  protocol: "grpc",

  tracing: {
    ignorePaths: ["/health", "/_otel/status"],
    spanNameResolver: (req) => `${req.method} ${String(req.route ?? req.path)}`,
  },

  metrics: {
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    customLabels: () => ({
      "deployment.environment": process.env.NODE_ENV ?? "development",
    }),
  },

  logs: {
    bridgeAppLogger: true,
    globalAttributes: { "app.version": "1.0.0" },
  },

  onEnd: (info) => {
    if (info.statusCode >= 500) {
      console.warn(
        `[otel] ${info.method} ${info.route} → ${info.statusCode} trace=${info.traceId}`,
      );
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
"use strict";
const { initOtel } = require("vextjs-opentelemetry/koa");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const {
  UndiciInstrumentation,
} = require("@opentelemetry/instrumentation-undici");
const {
  MongoDBInstrumentation,
} = require("@opentelemetry/instrumentation-mongodb");
const {
  IORedisInstrumentation,
} = require("@opentelemetry/instrumentation-ioredis");
const {
  MySQL2Instrumentation,
} = require("@opentelemetry/instrumentation-mysql2");

initOtel({
  serviceName: "my-service",
  endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || "47.89.182.109:32767", // host:port → gRPC h2c
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
    "dev": "egg-bin dev --require ./app/otel-init.cjs",
    "start": "egg-scripts start --require ./app/otel-init.cjs"
  }
}
```

### Step 3：OTel 中间件（`app/middleware/otel.ts`）

```typescript
import { createEggMiddleware } from "vextjs-opentelemetry/egg";

export default createEggMiddleware({
  serviceName: "my-service",
  tracing: {
    ignorePaths: [/^\/favicon/, /^\/_/, "/health"],
    spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`,
  },
  metrics: {
    customLabels: (ctx) => ({ "http.path": ctx.route ?? ctx.path }),
  },
  // 业务字段注入（每个服务按需实现）
  onCtxInit: (ctx) => {
    ctx.user_id = ctx.state?.userId ?? ctx.state?.user?.id ?? "";
    ctx.feature_flag = ctx.get("x-feature-flag") || "";
  },
  // 自定义 access log
  onRequestDone: (ctx, info) => {
    ctx.logger.info(
      `${info.method} ${ctx.status} ${info.route} ${info.latencyMs}ms`,
    );
  },
});
```

> **`createEggMiddleware` 自动注入的 ctx 字段**（无需手动写）：
>
> - `trace_id` — 当前请求的 W3C trace ID
> - `span_name` — `${method} ${routerPath}`
> - `endpoint` — routerPath
> - `latency_ms` — 请求总耗时（ms）

在 `typings/index.d.ts` 声明这些字段以消除 TypeScript 报错：

```typescript
declare module "egg" {
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
config.middleware = ["otel" /* 其他中间件 */];
```

### Step 5：`ctx.withSpan` 扩展（可选）

```typescript
// app/extend/context.ts
import { createWithSpan } from "vextjs-opentelemetry";
export default { withSpan: createWithSpan("my-service") };
```

### Step 6：`/_otel/status` 路由

```typescript
// app/router.ts
import { getOtelStatus } from "vextjs-opentelemetry";

router.get("/_otel/status", async (ctx) => {
  ctx.body = getOtelStatus(); // 无参，自动读取环境变量
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

app.use(
  createKoaMiddleware({
    serviceName: "my-koa-app",
    tracing: { ignorePaths: ["/health", "/_otel/status"] },
  }),
);

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
"use strict";
const { initOtel } = require("vextjs-opentelemetry/koa");
initOtel({
  serviceName: "my-koa-app",
  endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || "47.89.182.109:32767",
  instrumentations: [
    /* ... */
  ],
});
```

---

## Express

```typescript
import express from "express";
import { createExpressMiddleware } from "vextjs-opentelemetry/express";
import { getOtelStatus } from "vextjs-opentelemetry";

const app = express();

app.use(
  createExpressMiddleware({
    serviceName: "my-express-app",
    tracing: { ignorePaths: ["/health"] },
  }),
);

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

所有 HTTP 适配器都支持同一套 tracing / metrics 概念。
其中：

- 非 VextJS 适配器直接复用 `HttpOtelOptions`
- VextJS 使用专属 `OpenTelemetryPluginOptions`，只是为了把回调参数收窄为 `VextRequest`

也就是说，`extraAttributes` / `lateAttributes` **是通用能力，不是某个框架专有**。

非 VextJS 适配器的通用接口如下：

```typescript
import type { HttpOtelOptions } from "vextjs-opentelemetry";

const options: HttpOtelOptions = {
  serviceName: "my-app",

  tracing: {
    enabled: true,
    ignorePaths: ["/health", /^\/internal\//],
    spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`,
    extraAttributes: (ctx) => ({
      "tenant.id": ctx.headers["x-tenant-id"] ?? "",
    }),
    lateAttributes: (_ctx, raw) => ({
      // 适合读取框架原始 request/context（例如 Koa ctx.state / Hono c.req.raw）
      "request.has_raw": Boolean(raw),
    }),
  },

  metrics: {
    enabled: true,
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    customLabels: (ctx) => ({
      "api.version": ctx.headers["x-api-version"] ?? "v1",
    }),
  },

  onEnd: (info) => {
    // info: { traceId, method, route, latencyMs, statusCode }
    console.log(
      `${info.method} ${info.route} ${info.statusCode} ${info.latencyMs}ms`,
    );
  },
};
```

**Egg.js 专属扩展**（`EggHttpOtelOptions`）：

```typescript
const eggOptions: Record<string, unknown> = {
// onCtxInit: span 创建前执行，注入业务字段到 ctx
onCtxInit: (ctx: any) => {
  ctx.user_id = ctx.state?.userId ?? '';
  ctx.feature_flag = ctx.get('x-feature-flag') || '';
},

// onRequestDone: 请求完成后执行（finally 块，span/指标操作已完成）
onRequestDone: (ctx: any, info: { method: string; route: string; latencyMs: number }) => {
  // info: { method, route, latencyMs }
  ctx.logger.info(`${info.method} ${ctx.status} ${info.route} ${info.latencyMs}ms`);
},
};
```

### `extraAttributes` vs `lateAttributes`

| Hook | 触发时机 | 适合场景 |
| --- | --- | --- |
| `extraAttributes` | 请求开始时 | 从标准化 `OtelHttpContext` 快速提取低基数字段 |
| `lateAttributes` | 请求结束/异常时 | 需要 `route`、`statusCode` 或框架原始对象（raw request/context）的字段 |

`lateAttributes` 的函数签名为 `(ctx, raw) => ({ ... })`：
- `ctx.route` 在此阶段已解析完成；
- `raw` 为各适配器透传的原始对象：Express `{ req, res }`、Koa/Egg `ctx`、Hono `c`、Fastify `{ request, reply }`。

VextJS 也支持这两个钩子；区别只在于它直接把回调参数收窄为 `req: VextRequest`，因为该适配器本身就以 `req` 作为原始上下文，无需再额外透传第二个 `raw` 参数。

---

## 内置指标

| 指标名称                      | 类型           | 标签                         |
| ----------------------------- | -------------- | ---------------------------- |
| `http.server.duration`        | Histogram (ms) | method / status_code / route |
| `http.server.request.total`   | Counter        | method / status_code / route |
| `http.server.active_requests` | UpDownCounter  | method                       |

---

## 在代码中访问

```typescript
import {
  createWithSpan,
  getActiveTraceId,
  getOtelStatus,
} from "vextjs-opentelemetry";

const withSpan = createWithSpan("my-service");

// 最简用法
const userResult = await withSpan("db.user.find", () => UserModel.findById(id));

// 动态标注 span 属性
const paymentResult = await withSpan("payment.process", async (span) => {
  const res = await processPayment(body);
  span.setAttribute("payment.result", res.status);
  return res;
});

// 带初始属性
const paymentResultWithAttrs = await withSpan("payment.process", () => processPayment(body), {
  attributes: { "payment.provider": "stripe" },
});

// 获取当前 trace ID
const traceId = getActiveTraceId(); // 无 active span 时返回 ''

// 获取 SDK 状态
console.log(getOtelStatus());
// {
//   sdk: "initialized",
//   serviceName: "my-service",
//   exportMode: "otlp-grpc",
//   exportTarget: "47.89.182.109:32767",
//   protocol: "grpc",
//   autoInstrumentation: true,
//   samplingRatio: 1
// }
```

---

## 框架差异对比

| 特性                          | VextJS                  | Egg.js / Koa              | Express / Hono / Fastify |
| ----------------------------- | ----------------------- | ------------------------- | ------------------------ |
| SDK 初始化                    | `--import`（自动/手动） | `--require otel-init.cjs` | `--import` 或应用自建 bootstrap/init 文件 |
| exporter 配置位置             | `package.json vext.otel` / plugin options | `initOtel()` | 应用侧自行初始化 SDK（无内置 `initOtel()` 子路径） |
| 中间件                        | `opentelemetryPlugin()` | `createEggMiddleware()`   | `createXxxMiddleware()`  |
| 业务字段注入                  | `extraAttributes` / `lateAttributes`（`req` 类型化） | Egg：`onCtxInit` + `extraAttributes` / `lateAttributes`；Koa：`extraAttributes` / `lateAttributes` | `extraAttributes` / `lateAttributes` |
| logger bridge                 | `logs.bridgeAppLogger`  | `createOtelLogBridge`     | 手动                     |
| `onCtxInit` / `onRequestDone` | ❌                      | Egg：✅ / Koa：❌         | ❌                       |

### VextJS 状态接口

`vextjs` 适配器当前会自动注册 `GET /_otel/status`，直接返回 `app.otel.getStatus()`。
`statusEndpoint` 选项仅保留作兼容占位，不支持自定义路径。

## 兼容性与升级建议

### 本次 `1.0.6` 调整是否属于兼容版本？

是。当前变更仍属于 **patch 级别兼容修复**：

- 保留既有公开子路径：`/koa`、`/egg`、`/express`、`/hono`、`/fastify`、`/vextjs`
- `initOtel()` 的使用方式未变（仍位于 `/koa` 子路径）
- Egg 场景的 `createEggMiddleware()` 签名未变
- 新增的 `lateAttributes` 仅扩展能力，不破坏已有 `extraAttributes` 语义

### `chat` / `user` / `payment` 从旧版本升级到 `1.0.6` 是否兼容？

按当前仓库内的实际接入方式来看，**代码层面兼容**。

这三个服务当前都通过：

- `require("vextjs-opentelemetry/koa")`
- 调用 `initOtel({...})`
- 使用 Egg 风格的 `--require ./app/otel-init.cjs`

而这些入口在 `1.0.6` 中都保持不变，因此**无需因为本次发布去修改业务代码**。

### 升级前需要额外确认什么？

1. **Node.js 运行时**：当前包声明仍为 `>=18`，而 `chat` / `user` / `payment` 的各自 `package.json` 仍写 `>=16`。
   - 如果生产 / 测试环境实际已经是 Node 18+：可直接升级依赖；
   - 如果仍运行在 Node 16：这不是 `1.0.6` 新引入的问题，但依然属于未满足包声明的环境，建议先统一运行时版本或同步提升这些服务的 engines 声明。
2. **重新安装依赖后复核启动脚本**：建议至少验证 `--require ./app/otel-init.cjs` 启动路径仍正常。
3. **如需利用新能力**：只有在想读取请求结束阶段的原始上下文时，才需要额外改造为 `lateAttributes`；否则保持现状即可。

### 发布前建议验证

```bash
npm run verify
```

---

## 文档

📖 **[完整文档 → vextjs.github.io/vext/examples/opentelemetry.html](https://vextjs.github.io/vext/examples/opentelemetry.html)**

---

## 许可证

MIT © VextJS Contributors
