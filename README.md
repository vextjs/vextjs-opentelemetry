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

`endpoint` 存在两类初始化入口，**不要把它们混为一套规则**：

| 场景 | 配置入口 | `host:port` 含义 | 其他说明 |
| --- | --- | --- | --- |
| VextJS 预加载 / plugin | `package.json vext.otel.endpoint`、`opentelemetryPlugin({ endpoint, protocol })` | 由 `protocol` 决定：`protocol: "grpc"` 时走 gRPC h2c；`protocol: "http"` 时走 OTLP HTTP | 当前默认 `protocol` 为 `"http"`，因此只写 `host:port` 但不显式改协议时，会按 HTTP 处理 |
| Egg / Koa 手动初始化 | `initOtel({ endpoint })` | 默认走 gRPC h2c | `initOtel()` 不暴露单独 `protocol` 字段；`http://...` 才会切到 OTLP HTTP |
| 统一关闭导出 | `endpoint: "none"` 或不传 | 不上报 | 适合本地开发、测试或仅保留 Noop SDK |

> **为什么推荐 gRPC h2c？** `@grpc/grpc-js` 与部分自建采集器的 h2c 握手不兼容（永远 CONNECTING）。Egg/Koa 的 `initOtel()` 直接用 `node:http2`，可以绕开这类兼容性问题。VextJS 场景若也想走 h2c，请显式写 `protocol: "grpc"`。

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
  endpoint: "47.89.182.109:32767", // host:port + protocol=grpc → gRPC h2c
  protocol: "grpc",

  tracing: {
    ignorePaths: ["/health", "/_otel/status"],
    spanNameResolver: (ctx) => `${ctx.method} ${String(ctx.route ?? ctx.path)}`,
    startAttributes: (_ctx, req) => ({
      "tenant.id": (req.headers?.["x-tenant-id"] as string) ?? "",
    }),
    endAttributes: (_ctx, req) => ({
      "http.query": JSON.stringify((req as any).query ?? {}),
    }),
  },

  metrics: {
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    labels: () => ({
      "deployment.environment": process.env.NODE_ENV ?? "development",
    }),
  },

  logs: {
    bridgeAppLogger: true,
    globalAttributes: { "app.version": "1.0.0" },
  },

  lifecycle: {
    onEnd: (ctx, _req, info) => {
      if (info.statusCode >= 500) {
        console.warn(
          `[otel] ${ctx.method} ${ctx.route ?? ctx.path} → ${info.statusCode} trace=${info.traceId}`,
        );
      }
    },
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
import {
  createEggMiddleware,
  type EggContextLike,
} from "vextjs-opentelemetry/egg";

type AppEggContext = EggContextLike & {
  user_id?: string;
  feature_flag?: string;
  state?: Record<string, unknown> & {
    userId?: string;
    user?: { id?: string };
  };
};

export default createEggMiddleware<AppEggContext>({
  serviceName: "my-service",
  tracing: {
    ignorePaths: [/^\/favicon/, /^\/_/, "/health"],
    spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`,
    startAttributes: (_ctx, rawCtx) => ({
      "tenant.id": rawCtx.get("x-tenant-id") || "",
    }),
    endAttributes: (_ctx, rawCtx) => ({
      "http.request.body": JSON.stringify(rawCtx.request?.body ?? {}),
    }),
  },
  metrics: {
    labels: (ctx) => ({ "http.path": ctx.route ?? ctx.path }),
  },
  lifecycle: {
    onStart: (_ctx, rawCtx) => {
      rawCtx.user_id = rawCtx.state?.userId ?? rawCtx.state?.user?.id ?? "";
      rawCtx.feature_flag = rawCtx.get("x-feature-flag") || "";
    },
    onEnd: (ctx, rawCtx, info) => {
      rawCtx.logger.info(
        `${ctx.method} ${rawCtx.status} ${ctx.route ?? ctx.path} ${info.latencyMs}ms`,
      );
    },
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

> Express / Hono / Fastify 只提供 HTTP 中间件 / 插件适配层，**不提供** `initOtel()` 子路径。
> 这三类框架请先通过 `node --import vextjs-opentelemetry/instrumentation ...` 或自建 bootstrap 完成 SDK 初始化，再注册中间件 / 插件。

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

所有 HTTP 适配器现在都收敛到**同一套配置模型**：

- `tracing.startAttributes`
- `tracing.endAttributes`
- `metrics.labels`
- `lifecycle.onStart`
- `lifecycle.onEnd`

不同框架只在**加载方式**和 `raw` 参数类型上不同；配置字段本身保持一致。

### SDK 初始化配置入口

下面这组字段决定 SDK 如何导出；它们**不属于** `HttpOtelOptions`，而属于各框架的初始化入口：

| 字段 | VextJS `package.json vext.otel` | VextJS `opentelemetryPlugin()` | Egg / Koa `initOtel()` | 默认值 / 说明 |
| --- | --- | --- | --- | --- |
| `serviceName` | ✅ | ✅ | ✅ | 未显式提供时依次回退到 `OTEL_SERVICE_NAME`、应用 `package.json.name`、`vext-app` |
| `endpoint` | ✅ | ✅ | ✅ | 默认 `none` |
| `protocol` | ✅ | ✅ | — | 默认 `http`；仅 VextJS 初始化链路支持单独配置 |
| `headers` | ✅ | ✅ | ✅ | OTLP 请求头 |
| `sampling.ratio` | ✅ | — | — | 默认 `1`；也可走 `OTEL_TRACES_SAMPLER_ARG` |
| `metricIntervalMs` | ✅ | — | ✅ | 默认 `15000`；VextJS 也支持 `OTEL_METRIC_EXPORT_INTERVAL` |

> `Express / Hono / Fastify` 没有内置初始化 helper：如果你在这些框架里需要配置 `endpoint / headers / sampling.ratio / metricIntervalMs`，请在应用启动阶段使用 `instrumentation` 预加载或自己的 SDK bootstrap 来完成。

通用接口如下：

```typescript
import type { HttpOtelOptions } from "vextjs-opentelemetry";

const options: HttpOtelOptions = {
  serviceName: "my-app",

  tracing: {
    enabled: true,
    ignorePaths: ["/health", /^\/internal\//],
    spanNameResolver: (ctx) => `${ctx.method} ${ctx.route ?? ctx.path}`,
    startAttributes: (ctx) => ({
      "tenant.id": ctx.headers["x-tenant-id"] ?? "",
    }),
    endAttributes: (_ctx, raw) => ({
      // 适合读取框架原始 request/context（例如 Koa ctx.state / Hono c.req.raw）
      "request.has_raw": Boolean(raw),
    }),
  },

  metrics: {
    enabled: true,
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    labels: (ctx) => ({
      "api.version": ctx.headers["x-api-version"] ?? "v1",
    }),
  },

  lifecycle: {
    onEnd: (ctx, _raw, info) => {
      console.log(
        `${ctx.method} ${ctx.route ?? ctx.path} ${info.statusCode} ${info.latencyMs}ms`,
      );
    },
  },
};
```

### 开始 / 结束阶段职责

| Hook | 触发时机 | 适合场景 |
| --- | --- | --- |
| `startAttributes` | 请求开始时 | 请求头、requestId、租户、客户端来源等早期稳定字段 |
| `endAttributes` | 请求结束 / 异常时 | `route`、`statusCode`、`latencyMs`、`params/query/body`、需要 raw request/context 的字段 |
| `lifecycle.onStart` | 请求开始时 | ctx/request 上下文字段回写、非 attribute 类副作用 |
| `lifecycle.onEnd` | 请求结束 / 异常时 | access log、trace 日志关联、最终收尾逻辑 |

各适配器透传的 `raw` 参数：
- Express → `{ req, res }`
- Koa / Egg → `ctx`
- Hono → `c`
- Fastify → `{ request, reply }`
- VextJS → `req`

### Egg.js 类型提示

```typescript
import {
  createEggMiddleware,
  type EggContextLike,
} from "vextjs-opentelemetry/egg";

type AppEggContext = EggContextLike & {
  user_id?: string;
  feature_flag?: string;
  state?: Record<string, unknown> & { userId?: string };
};

createEggMiddleware<AppEggContext>({
  lifecycle: {
    onStart: (_ctx, rawCtx) => {
      // rawCtx 会自动推导为 AppEggContext，不需要再手动补 any 标注
      rawCtx.user_id = rawCtx.state?.userId ?? "";
      rawCtx.feature_flag = rawCtx.get("x-feature-flag") || "";
    },
    onEnd: (ctx, rawCtx, info) => {
      rawCtx.logger?.info?.(
        `${ctx.method} ${rawCtx.status} ${ctx.route ?? ctx.path} ${info.latencyMs}ms`,
      );
    },
  },
});

function bindEggCtx(rawCtx: EggContextLike) {
  rawCtx.trace_id = rawCtx.trace_id ?? "";
}
```

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
| 中间件 / 插件入口             | `opentelemetryPlugin()` | `createEggMiddleware()` / `createKoaMiddleware()` | `createXxxMiddleware()`  |
| 统一配置字段                  | `startAttributes / endAttributes / metrics.labels / lifecycle` | 同一套配置字段 | 同一套配置字段 |
| logger bridge                 | `logs.bridgeAppLogger`  | `createOtelLogBridge`     | 手动                     |

### VextJS 状态接口

`vextjs` 适配器当前会自动注册 `GET /_otel/status`，直接返回 `app.otel.getStatus()`。
`statusEndpoint` 选项仅保留作兼容占位，不支持自定义路径。


---

## 文档

📖 **[完整文档 → vextjs.github.io/vext/examples/opentelemetry.html](https://vextjs.github.io/vext/examples/opentelemetry.html)**

---

## 许可证

MIT © VextJS Contributors
