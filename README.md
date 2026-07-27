# @devcodex/opentelemetry

> 多框架 OpenTelemetry 集成 — 零配置追踪、指标与日志，支持 VextJS / Egg.js / Koa / Express / Hono / Fastify

[![npm version](https://img.shields.io/npm/v/@devcodex/opentelemetry.svg)](https://www.npmjs.com/package/@devcodex/opentelemetry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

将原本需要手写的 ~200 行 OpenTelemetry 样板代码压缩为极简配置，开箱即得 Traces（链路追踪）、Metrics（指标监控）与 Logs（日志关联）。

---

## 目录导航

- [特性](#特性)
- [安装](#安装)
- [先理解：4 个配置入口分别负责什么](#先理解4-个配置入口分别负责什么)
- [我应该从哪里开始配置](#我应该从哪里开始配置)
- [导出目标与 endpoint / protocol 规则](#导出目标与-endpoint--protocol-规则)
  - [关闭上报速查](#关闭上报速查)
- [`tracing` 与 `lifecycle` 到底有什么区别](#tracing-与-lifecycle-到底有什么区别)
- [配置项完整说明](#配置项完整说明)
  - [`package.json vext.otel`](#packagejson-vextotel)
  - [`opentelemetryPlugin()`](#opentelemetryplugin)
  - [`initOtel()`](#initotel)
  - [`HttpOtelOptions.tracing`](#httpoteloptionstracing)
  - [`HttpOtelOptions.metrics`](#httpoteloptionsmetrics)
  - [`HttpOtelOptions.lifecycle`](#httpoteloptionslifecycle)
  - [`HttpOtelOptions.logs`](#httpoteloptionslogs)
- [常见采集诉求速查](#常见采集诉求速查)
- [框架快速接入](#框架快速接入)
  - [VextJS](#vextjs)
  - [Egg.js](#eggjs)
  - [Koa](#koa)
  - [Express](#express)
  - [Hono](#hono)
  - [Fastify](#fastify)
- [框架差异速查](#框架差异速查)
- [内置指标](#内置指标)
  - [字段命名约定](#字段命名约定)
- [在代码中访问](#在代码中访问)
- [许可证](#许可证)

---

## 特性

- **追踪** — 自动标注 HTTP Span 属性（路由、状态码、请求 ID）
- **指标** — 内置 HTTP 请求时长直方图、请求总数、活跃请求数
- **日志关联** — 自动将 `trace_id` 注入每条请求日志
- **gRPC h2c** — 原生 `node:http2` 实现，兼容自建 Jaeger / K8s OTel Collector
- **优雅降级** — SDK 未初始化时以 Noop 模式运行，零 overhead
- **轻量预加载** — VextJS 自动 preload 默认延后 SDK/exporter 到 plugin setup，支持 `enabled:false` 和标准 `OTEL_SDK_DISABLED=true` 早退
- **多框架** — VextJS / Egg.js / Koa / Express / Hono / Fastify

---

## 安装

> **Node.js 要求**：`@devcodex/opentelemetry` 当前声明 `engines.node >= 18`。
> 若你的服务 `package.json` 仍写 `>=16`，升级依赖前请先确认实际运行环境已是 Node 18+；否则安装阶段可能只给 warning，但运行时不属于受支持范围。

```bash
# 常规接入（VextJS / Koa / Express / Hono / Fastify）
npm install @devcodex/opentelemetry

# 仅当你的应用代码会直接 import 这些 instrumentation 时，再额外声明
# 典型场景：Egg/Koa 的 otel-init.cjs 自己 new Instrumentation()
npm install @opentelemetry/instrumentation-http \
            @opentelemetry/instrumentation-mongodb \
            @opentelemetry/instrumentation-ioredis \
            @opentelemetry/instrumentation-mysql2
```

> `@devcodex/opentelemetry` 已内置 `@opentelemetry/api`、`@opentelemetry/sdk-node` 和常用 OTLP exporter。
> 对于正常接入，**不需要**再重复安装这些包。只有当你的业务代码要直接 `import { NodeSDK } ...` / `import { SpanStatusCode } ...` 时，才建议把对应包声明为应用自己的直接依赖。

---

## 先理解：4 个配置入口分别负责什么

这 4 个入口**不是一回事**。大多数“配了但不生效 / 不知道该写哪”的问题，都来自把它们混着理解。

| 配置入口                 | 负责什么                                | 生效阶段                        | 适用场景                                                                  | 不适合放什么                                    |
| ------------------------ | --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| `package.json vext.otel` | VextJS 预加载阶段的 SDK 初始配置        | **进程启动 / preload**          | VextJS 需要从一开始就确定 `service.name`、导出目标、采样、metric 上报周期 | 请求级逻辑、Span 属性、access log               |
| `opentelemetryPlugin()`  | VextJS 插件期的运行时配置与请求观测配置 | **plugin setup + request**      | VextJS 中补充导出配置、桥接日志、配置 `tracing/metrics/lifecycle`         | 不适合承担 preload 阶段才会生效的 Resource 语义 |
| `initOtel()`             | Egg / Koa 的 SDK 初始化 helper          | **进程启动 / `--require`**      | Egg / Koa 需要在任何模块加载前初始化 SDK                                  | 请求级属性提取、access log、副作用逻辑          |
| `HttpOtelOptions`        | 各 HTTP 适配器的统一请求观测配置        | **request start / request end** | 配置 `tracing`、`metrics`、`lifecycle`、`logs`                            | SDK 启动参数（如采样率、metric reader 周期）    |

### 一句话记忆

- **SDK 怎么启动 / 怎么导出** → 看 `package.json vext.otel`、`opentelemetryPlugin()`、`initOtel()`
- **每个请求怎么观测 / 打什么属性 / 做什么副作用** → 看 `HttpOtelOptions`

---

## 我应该从哪里开始配置

| 你的目标                                   | 推荐入口                                                                                               | 原因                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 想改 `service.name`、导出地址、采样率      | `package.json vext.otel`（VextJS）/ `initOtel()`（Egg/Koa）/ preload bootstrap（Express/Hono/Fastify） | 这些都属于 SDK 初始化层            |
| 想给请求 Span 增加属性                     | `tracing.startAttributes` / `tracing.endAttributes`                                                    | 这是观测数据本身                   |
| 想改 Span 名称                             | `tracing.spanNameResolver`                                                                             | 这是追踪主语义                     |
| 想打 access log、trace 关联日志            | `lifecycle.onEnd`                                                                                      | 这是请求结束副作用，不是 Span 属性 |
| 想回写 `ctx` / `req` 字段                  | `lifecycle.onStart` / `lifecycle.onEnd`                                                                | 这是运行时副作用                   |
| 想加指标标签                               | `metrics.labels`                                                                                       | 这是指标维度配置，但必须低基数     |
| 想桥接 VextJS 的 `app.logger` 到 OTel Logs | `logs.bridgeAppLogger`                                                                                 | 这是日志桥接，不属于 tracing       |

---

## 导出目标与 `endpoint` / `protocol` 规则

`endpoint` 在不同初始化入口里的语义**不完全一样**，尤其要分清 VextJS 与 Egg/Koa。

| 场景                   | 配置入口                                                                         | `host:port` 含义                                                                        | 其他说明                                                                               |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| VextJS 预加载 / plugin | `package.json vext.otel.endpoint`、`opentelemetryPlugin({ endpoint, protocol })` | 由 `protocol` 决定：`protocol: "grpc"` 时走 gRPC h2c；`protocol: "http"` 时走 OTLP HTTP | 当前默认 `protocol` 为 `"http"`，因此只写 `host:port` 且不显式改协议时，会按 HTTP 处理 |
| Egg / Koa 手动初始化   | `initOtel({ endpoint })`                                                         | 默认走 gRPC h2c                                                                         | `initOtel()` 不暴露单独 `protocol` 字段；只有写成 `http://...` 才会切到 OTLP HTTP      |
| 统一关闭导出           | `endpoint: "none"` 或不传                                                        | 不上报                                                                                  | 适合本地开发、测试或只想保留 Noop SDK                                                  |

### 关闭上报速查

如果目标是**不再向 Collector 上报 traces / metrics / logs**，请关闭 exporter：

```json
{
  "vext": {
    "otel": {
      "endpoint": "none"
    }
  }
}
```

同时确认插件阶段没有再补一个导出目标：

```typescript
export default opentelemetryPlugin({
  endpoint: "none",
});
```

VextJS 自动 preload 场景下，默认不会抢先根据 `package.json vext.otel.endpoint` 启动完整 SDK/exporter；真正的 SDK 启动与 exporter 配置会延后到 `opentelemetryPlugin()` setup 阶段。因此：

- `app.config.otel.enabled=false` 或 `opentelemetryPlugin({ enabled: false })` 会阻止插件阶段启动 SDK、挂载请求观测、注册 `/_otel/status` 和 logger bridge。
- `package.json vext.otel.enabled=false`、`VEXT_OTEL_DISABLED=1`、`VEXT_OTEL_PRELOAD=0` 或 `OTEL_SDK_DISABLED=true` 会在 preload 阶段直接早退，不加载完整 OTel SDK。
- 如果你确实需要进程最早期 SDK / auto-instrumentation，请显式设置 `package.json vext.otel.preloadSdk=true` 或 `VEXT_OTEL_FORCE_SDK=1`。启用后，这段初始化早于 `src/config/default.ts`，因此后者无法再回滚已经启动的 SDK/exporter。
- 非 Vext 手动 `node --import @devcodex/opentelemetry/instrumentation ...` 场景保持独立心智模型：有有效 endpoint 时会在 preload 阶段启动 SDK；`endpoint:"none"` 且无强制 SDK/auto-instrumentation 信号时保持 noop。

### 为什么 Egg / Koa 默认偏向 gRPC h2c

`initOtel()` 在 gRPC 模式下直接使用 `node:http2`，可以绕开 `@grpc/grpc-js` 在部分自建 Collector 场景下的 h2c 握手兼容问题。

### 启动日志策略

默认只保留：

- **真正已配置导出目标时的启动摘要**
- **首次失败告警**
- **失败后的首次恢复提示**

不会持续打印每一批成功导出日志；当处于 `deferred export`（等待插件 setup 接管）时，也不会默认打印启动摘要，避免在 VextJS 场景里把阶段性状态误读为最终状态。

---

## `tracing` 与 `lifecycle` 到底有什么区别

这是最容易被误解的地方。

### 一句话区别

- **`tracing`** = “这次请求在观测系统里长什么样”
- **`lifecycle`** = “这次请求前后我要额外做什么动作”

### 对比表

| 维度         | `tracing`                                                             | `lifecycle`                             |
| ------------ | --------------------------------------------------------------------- | --------------------------------------- |
| 本质         | Span / 观测数据配置                                                   | 请求生命周期副作用                      |
| 典型能力     | `ignorePaths`、`spanNameResolver`、`startAttributes`、`endAttributes` | `onStart`、`onEnd`                      |
| 适合做什么   | 改 Span 名、补 Span 属性、控制哪些请求被追踪                          | 打 access log、回写 `ctx/req`、收尾动作 |
| 不适合做什么 | 打日志、改业务上下文、写副作用                                        | 充当主要 Span 属性配置入口              |

### 正确的心智模型

#### `tracing`

适合：

- 让 Span 名称从 `GET /users/123` 收敛成 `GET /users/:id`
- 给 Span 增加 `tenant.id`、`request.has_body` 这类观测属性
- 忽略健康检查路径

不适合：

- 在回调里直接打 access log
- 在回调里修改 `ctx.state` / `req.user`
- 把业务副作用塞到 attribute resolver 里

#### `lifecycle`

适合：

- 在请求开始时回写上下文字段
- 在请求结束时打 access log
- 在请求结束时用 `traceId` 做日志关联

不适合：

- 作为主要 Span 属性入口
- 替代 `spanNameResolver`
- 承担“告诉 OTel 这次请求长什么样”的职责

### 错误示例 vs 正确示例

#### 错误示例 1：把 access log 写进 `endAttributes`

- `endAttributes` 里一边 `return { "tenant.id": "t-1" }`，一边又直接 `raw.logger.info(...)` 打日志。

问题：`endAttributes` 的职责是**返回 Span 属性**，不是做副作用。把日志塞进这里，读者会误以为 tracing hook 就是“请求结束万能回调”。

#### 正确示例 1：属性放 `endAttributes`，日志放 `lifecycle.onEnd`

- `tracing.endAttributes` 只返回诸如 `request.body.present` 这类 Span 属性。
- `lifecycle.onEnd` 单独负责 `raw.logger.info(...)` 这类 access log / 收尾动作。

#### 错误示例 2：把上下文回写放进 `startAttributes`

- `startAttributes` 里先执行 `raw.user_id = ...` 回写上下文，再返回 `tenant.id` 等属性。

问题：`startAttributes` 的职责是**返回属性**，不是修改运行时上下文。

#### 正确示例 2：回写放 `lifecycle.onStart`

- `tracing.startAttributes` 只返回 `tenant.id` 这类请求开始阶段就能确定的稳定属性。
- `lifecycle.onStart` 再单独负责 `raw.user_id = ...` 这类上下文回写。

---

## 配置项完整说明

### `package.json vext.otel`

适用：**VextJS preload / instrumentation 阶段**。

```json
{
  "name": "admin",
  "vext": {
    "otel": {
      "serviceName": "admin",
      "enabled": true,
      "preloadSdk": false,
      "endpoint": "47.89.182.109:32767",
      "protocol": "grpc",
      "headers": {
        "x-tenant": "prod"
      },
      "sampling": { "ratio": 1 },
      "metricIntervalMs": 15000
    }
  }
}
```

| 字段               | 作用                                | 生效阶段 | 推荐场景                               | 不推荐场景           | 常见误用                                                       |
| ------------------ | ----------------------------------- | -------- | -------------------------------------- | -------------------- | -------------------------------------------------------------- |
| `serviceName`      | 写入 SDK Resource 的 `service.name` | preload / setup fallback | 希望从进程启动时就确定服务名 | 请求级逻辑 | 误以为只配 plugin 里的 `serviceName` 就能回写已启动的 Resource |
| `enabled`          | package/preload 层总开关            | preload / setup fallback | 希望禁用当前 Vext 应用的 OTel SDK 与 plugin fallback | 请求级开关 | 误以为只关 plugin 但仍想使用 package endpoint |
| `preloadSdk`       | Vext 自动 preload 是否抢先启动完整 SDK | preload | 需要进程最早期 SDK / auto-instrumentation | 普通请求观测 | 忽略它早于 `src/config/default.ts` 加载 |
| `endpoint`         | 导出目标；Vext 自动 preload 默认延后到 plugin setup | preload / setup fallback | 配置统一导出目标 | 请求级 hook | 误把它当成 `tracing` 里的请求属性配置 |
| `protocol`         | VextJS 导出协议                     | preload / setup fallback | VextJS 明确需要 gRPC h2c 或 HTTP | Egg/Koa `initOtel()` | 误以为所有入口都支持单独 `protocol` 字段 |
| `headers`          | OTLP 导出请求头                     | preload  | 需要为 Collector 注入固定头            | 请求内动态 headers   | 误以为这是要采集业务请求头                                     |
| `sampling.ratio`   | Trace 采样率                        | preload  | 需要在启动阶段控制采样                 | 请求级 attribute     | 误把它当“某个请求要不要采”的业务判断                           |
| `metricIntervalMs` | metric reader 导出周期              | preload  | 需要统一 metric 推送节奏               | 请求级逻辑           | 误以为越小越好，忽略上报频率成本                               |

### `opentelemetryPlugin()`

适用：**VextJS plugin setup + request 阶段**。

```typescript
import { opentelemetryPlugin } from "@devcodex/opentelemetry/vextjs";

export default opentelemetryPlugin({
  serviceName: "my-app",
  endpoint: "47.89.182.109:32767",
  protocol: "grpc",
  insecure: true,
  tracing: {
    ignorePaths: ["/health", "/_otel/status"],
  },
  logs: {
    bridgeAppLogger: true,
    globalAttributes: { "app.version": "1.0.0" },
  },
});
```

| 字段                                         | 作用                                                    | 生效阶段 | 推荐场景                                | 不推荐场景                          | 常见误用                                            |
| -------------------------------------------- | ------------------------------------------------------- | -------- | --------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `enabled`                                    | 关闭 VextJS plugin setup                                | setup    | 临时禁用当前应用 OTel plugin            | 代替 SDK 级开关语义                 | 误以为它能回滚 preload 已启动的 SDK                 |
| `serviceName`                                | 影响运行期 tracer / meter / logger 命名                 | setup    | VextJS plugin 级命名                    | 期望它回写 preload Resource         | 误解为“它和 package.json 的 `serviceName` 完全等价” |
| `endpoint`                                   | setup 阶段追加/覆盖 exporter 目标                       | setup    | 运行期补充导出目标                      | 请求级属性                          | 误把它当成请求数据采集配置                          |
| `protocol`                                   | setup 阶段 exporter 协议（VextJS 专属）                 | setup    | 需要显式切 gRPC/HTTP                    | Egg/Koa                             | 误以为所有框架都支持此字段                          |
| `headers`                                    | setup 阶段 OTLP 请求头                                  | setup    | VextJS 运行时补 header                  | 请求级业务 header 采集              | 混淆“导出请求头”和“业务请求头”                      |
| `insecure`                                   | gRPC 连接方式（h2c/TLS）                                | setup    | 区分内网 collector 与公网 TLS collector | HTTP 模式                           | 忽略它只对 `protocol: "grpc"` 有意义                |
| `resourceAttributes`                         | 兼容占位字段；当前 plugin 阶段不会重新写入 SDK Resource | setup    | 仅用于说明兼容语义                      | 依赖它在 plugin 阶段动态改 Resource | 误以为写了就会改变已启动 SDK 的 Resource            |
| `statusEndpoint`                             | 兼容占位；当前不支持自定义路径                          | setup    | 历史配置过渡说明                        | 新项目自定义路径                    | 误以为可以改默认 `/_otel/status` 路径               |
| `tracing` / `metrics` / `lifecycle` / `logs` | 请求观测配置                                            | request  | VextJS 请求期观测与日志桥接             | SDK 启动参数                        | 把它们和 preload 配置混在一起理解                   |

> `app.config.otel.enabled / serviceName / endpoint / protocol / headers` 会作为 VextJS plugin setup 的运行期 fallback 读取。
> 在默认 Vext 自动 preload 模式下，`app.config.otel.enabled=false` 能阻止实际 SDK/exporter 启动；只有显式 `preloadSdk=true` / `VEXT_OTEL_FORCE_SDK=1` 的进程最早期 SDK 场景早于 `default.ts`。
> 如果要关闭 Collector 上报，请使用 [`endpoint: "none"`](#关闭上报速查) 或 `enabled:false`；如果要在 preload 阶段完全早退，可使用 `package.json vext.otel.enabled=false`、`VEXT_OTEL_DISABLED=1` 或 `OTEL_SDK_DISABLED=true`。

### `initOtel()`

适用：**Egg / Koa 的 `--require` 预加载场景**。

```javascript
"use strict";
const { initOtel } = require("@devcodex/opentelemetry/koa");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");

initOtel({
  serviceName: "my-service",
  endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || "47.89.182.109:32767",
  headers: { "x-tenant": "prod" },
  instrumentations: [new HttpInstrumentation()],
  metricIntervalMs: 15000,
});
```

| 字段               | 作用              | 生效阶段 | 推荐场景                                 | 不推荐场景         | 常见误用                                      |
| ------------------ | ----------------- | -------- | ---------------------------------------- | ------------------ | --------------------------------------------- |
| `serviceName`      | Resource 的服务名 | preload  | Egg/Koa 启动时统一服务名                 | 请求级 hook        | 误把它当中间件配置的一部分                    |
| `endpoint`         | 导出目标          | preload  | Egg/Koa collector 导出                   | 请求采集逻辑       | 误以为 `host:port` 默认是 HTTP                |
| `headers`          | OTLP 导出请求头   | preload  | 需要为 exporter 注入固定 headers         | 业务 header 采集   | 把 exporter header 和 request header 混为一谈 |
| `instrumentations` | 额外自动埋点列表  | preload  | 需要补 HTTP / DB / Redis instrumentation | 请求生命周期副作用 | 误以为这是 `HttpOtelOptions` 的一部分         |
| `metricIntervalMs` | metrics 导出周期  | preload  | 统一 metric 推送节奏                     | 请求逻辑           | 忽略采集频率成本                              |

### `HttpOtelOptions.tracing`

适用：**所有 HTTP 适配器共享的请求追踪配置**。

| 字段               | 作用                       | 生效阶段      | 推荐场景                                                          | 不推荐场景              | 常见误用                       |
| ------------------ | -------------------------- | ------------- | ----------------------------------------------------------------- | ----------------------- | ------------------------------ |
| `enabled`          | 开关 tracing               | request       | 局部禁用某组中间件追踪                                            | 代替 SDK 是否启动       | 误解为能停掉整个 SDK           |
| `ignorePaths`      | 忽略指定路径               | request start | 健康检查、状态页、噪音路径                                        | 动态业务判断            | 把它当权限控制                 |
| `spanNameResolver` | 自定义 Span 名称           | request end   | 需要使用 route 模板收敛 Span 名                                   | access log              | 把日志格式化职责塞进这里       |
| `startAttributes`  | 请求开始阶段额外 Span 属性 | request start | 稳定请求头、租户、requestId、客户端来源                           | 需要完整 raw ctx 的字段 | 在回调里做副作用、回写上下文   |
| `endAttributes`    | 请求结束阶段额外 Span 属性 | request end   | `route/statusCode/latency/query/params/body` 等结束后更完整的信息 | access log / 业务副作用 | 在回调里打日志或修改 `ctx/req` |

### `HttpOtelOptions.metrics`

| 字段              | 作用           | 生效阶段    | 推荐场景                              | 不推荐场景                      | 常见误用                               |
| ----------------- | -------------- | ----------- | ------------------------------------- | ------------------------------- | -------------------------------------- |
| `enabled`         | 开关 HTTP 指标 | request     | 某些场景只保留 tracing 不保留 metrics | 代替 SDK metrics reader 配置    | 误解为它能改 metric 导出周期           |
| `durationBuckets` | 时长直方图分桶 | request end | 希望根据接口 SLA 调整桶边界           | 不清楚实际延迟分布时盲调        | 分桶设得过细导致观测噪音               |
| `labels`          | 附加指标标签   | request end | 少量、低基数业务维度                  | user.id、query、full path、body | 把高基数字段塞进 metrics，导致成本膨胀 |

### `HttpOtelOptions.lifecycle`

| 字段      | 作用               | 生效阶段      | 推荐场景                             | 不推荐场景             | 常见误用                      |
| --------- | ------------------ | ------------- | ------------------------------------ | ---------------------- | ----------------------------- |
| `onStart` | 请求开始阶段副作用 | request start | 回写 `ctx/req`、准备上下文状态       | Span 属性返回          | 用它做主要 tracing 配置       |
| `onEnd`   | 请求结束阶段副作用 | request end   | access log、trace 关联日志、收尾动作 | Span 名称 / 主属性配置 | 把它当 `endAttributes` 替代品 |

### `HttpOtelOptions.logs`

| 字段               | 作用                                           | 生效阶段        | 推荐场景                                                   | 不推荐场景       | 常见误用                                    |
| ------------------ | ---------------------------------------------- | --------------- | ---------------------------------------------------------- | ---------------- | ------------------------------------------- |
| `globalAttributes` | 附加到通过适配器 log bridge 发出的全局日志属性 | request / emit  | 应用级稳定字段，如 `app.version`、`deployment.environment` | 高变字段         | 把每次请求都变化的字段塞进 globalAttributes |
| `bridgeAppLogger`  | VextJS 中把 `app.logger` 桥接到 OTel Logs      | setup / request | 希望框架日志自动进入 OTel Logs                             | 非 VextJS 适配器 | 误以为所有框架都有同名自动桥接              |

---

## 常见采集诉求速查

| 我想做什么               | 推荐入口                                                                                 | 原因                                            | 注意事项                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| 采请求头                 | 优先 `capture.headers`；复杂场景再用 `tracing.startAttributes` / `tracing.endAttributes` | 高频场景可以声明式配置，特殊场景再回到 resolver | `headers` 仍只建议白名单；不要采 `authorization` / `cookie` |
| 采 query / params / body | 优先 `capture.query / capture.params / capture.body`                                     | 常见场景可声明式配置；请求结束阶段上下文更完整  | `query/params` 支持显式全量模式；`body` 仍只建议白名单      |
| 打 access log            | `lifecycle.onEnd`                                                                        | 这是副作用，不是 Span 属性                      | 不要塞进 `endAttributes`                                    |
| 回写 `ctx` / `req` 字段  | `lifecycle.onStart` / `lifecycle.onEnd`                                                  | 这是运行时副作用                                | 不要用 attribute resolver 代替                              |
| 改 Span 名               | `tracing.spanNameResolver`                                                               | 直接作用于追踪主语义                            | 不要用 `lifecycle` 模拟                                     |
| 给指标补业务标签         | `metrics.labels`                                                                         | 这是指标维度入口                                | 只能放低基数字段                                            |

### 不建议默认全量采集的原因

1. **高基数**：`query/body/user.id/full path` 很容易导致存储和查询成本暴涨。
2. **敏感信息风险**：token、cookie、手机号、邮箱、密码等字段极易误采。
3. **跨框架一致性问题**：不同框架对 raw request/context 的可读字段并不完全等价。

### 推荐策略

- headers → **默认白名单**；需要复现请求时，也可显式开启全量模式，但应同时配置排除 / 脱敏规则
- query → **默认白名单**；当你明确知道业务需要时，可显式开启全量模式
- params → **默认白名单**；路由参数天然更结构化，也可显式开启全量模式
- body → **默认白名单**；需要复现请求时，也可显式开启全量模式，但应同时配置深度 / 数量 / 脱敏规则
- metrics labels → **只保留低基数字段**

### 声明式 `capture`

`capture` 用来覆盖“必要字段不想每次都手写 resolver”的高频场景：

```ts
const options = {
  capture: {
    headers: ["x-tenant-id", "x-request-id"],
    query: ["page", "limit"],
    params: ["id"],
    body: ["orderNo", "customer.id"],
  },
};
```

生成的属性前缀固定为：

- `http.request.header.*`
- `http.request.query.*`
- `http.request.param.*`
- `http.request.body.*`

当配置 `snapshot: true` 或 `output: "snapshot" | "both"` 时，还会额外生成：

- `request.headers.raw`
- `request.query.raw`
- `request.params.raw`
- `request.body.raw`

### 四类输入的显式全量模式

如果你的业务场景里，**确实需要把当前请求的完整输入打到观测数据里**，可以显式开启：

```ts
const options = {
  capture: {
    headers: true,
    query: true,
    params: true,
    body: true,
  },
};
```

等价于：

```ts
const options = {
  capture: {
    headers: "*",
    query: "*",
    params: "*",
    body: "*",
  },
};
```

注意：

1. 这不是默认行为，而是**显式 opt-in**；
2. 全量模式对 `headers / query / params / body` 都开放；
3. 进入全量模式后，仍然会经过：
   - 敏感字段脱敏
   - 字符串长度截断
   - body 的深度/数组数量限制
   - 非标量值的安全处理
4. `capture` 不会自动进入 `metrics.labels`。

### 规则对象：筛选 / 排除 / 脱敏 / 输出控制

如果你不仅要“开全量”，还需要控制输出范围，可以用规则对象：

```ts
const options = {
  capture: {
    headers: {
      mode: "all",
      exclude: ["cookie"],
      sensitiveKeys: ["authorization"],
      output: "both",
    },
    body: {
      mode: "all",
      exclude: ["password"],
      sensitiveKeys: [/token/i],
      maxDepth: 6,
      maxItems: 50,
      maxValueLength: 4096,
      output: "both",
    },
  },
};
```

支持的关键字段：

- `mode: "allowlist" | "all"`
- `fields`：显式白名单字段
- `exclude`：排除字段 / 路径
- `sensitiveKeys`：当前 source 的敏感键规则
- `maxValueLength`：字符串截断长度
- `maxDepth`：对象递归展开深度（主要用于 body）
- `maxItems`：数组展开数量上限（主要用于 body）
- `snapshot: true`：兼容快捷开关，等价于开启快照输出
- `output: "attributes" | "snapshot" | "both"`

### 为什么默认仍不建议 `headers / body` 全量？

- `headers` 很容易包含 `authorization`、`cookie` 这类高风险字段；
- `body` 更容易包含密码、手机号、邮箱、Token、复杂对象、超长文本；
- 因此虽然库**支持显式全量**，默认策略仍应优先白名单或规则控制，避免“一开就脏”。

### 普通观测模式 vs 复现模式

#### 普通观测模式（默认推荐）

```ts
const options = {
  capture: {
    headers: ["x-tenant-id", "x-request-id"],
    query: true,
    params: true,
    body: ["orderNo", "customer.id"],
  },
};
```

- 适合排障、聚合分析
- 不保留完整原始请求快照

#### 复现模式（显式开启）

```ts
const options = {
  capture: {
    headers: {
      mode: "all",
      exclude: ["cookie"],
      sensitiveKeys: ["authorization"],
      output: "both",
    },
    query: { mode: "all", output: "attributes" },
    params: { mode: "all", output: "attributes" },
    body: {
      mode: "all",
      exclude: ["password"],
      sensitiveKeys: [/token/i],
      maxDepth: 6,
      maxItems: 50,
      output: "both",
    },
  },
};
```

- 适合请求复现 / replay 增强
- 建议和排除 / 脱敏 / 截断规则一起使用

### Hono 的 `body` 特别说明

Hono 适配器不会在遥测中间件里主动调用 `req.json()` / `req.parseBody()` / `req.formData()` 去消费请求流。

`capture.body` 在 Hono 下只会读取 **`bodyCache` 中已经存在的解析结果**：

- 如果前面的 handler / middleware 已经解析过 body，则可采集
- 如果还没有解析，则跳过 `capture.body`

这保证了遥测能力不会为了采集 `body` 而破坏请求处理链路。

---

## 框架快速接入

### VextJS

VextJS 是唯一同时具备 **preload 初始化** 与 **plugin setup** 两阶段配置入口的场景。

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
import { opentelemetryPlugin } from "@devcodex/opentelemetry/vextjs";

export default opentelemetryPlugin({
  serviceName: "admin",
  endpoint: "47.89.182.109:32767",
  protocol: "grpc",
  tracing: {
    ignorePaths: ["/health", "/_otel/status"],
    spanNameResolver: (ctx) => `${ctx.method} ${String(ctx.route ?? ctx.path)}`,
    startAttributes: (_ctx, req) => ({
      "tenant.id": (req.headers?.["x-tenant-id"] as string) ?? "",
    }),
    endAttributes: (_ctx, req) => ({
      "request.has_query": Boolean((req as Record<string, unknown>).query),
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
          `[otel] ${ctx.method} ${ctx.route ?? ctx.path} -> ${info.statusCode} trace=${info.traceId}`,
        );
      }
    },
  },
});
```

> `opentelemetryPlugin({ serviceName })` 会影响运行期 tracer / meter / logger 命名。默认 Vext 自动 preload 会延后 SDK/exporter 到 plugin setup，因此 `package.json vext.otel` 可作为 plugin fallback；如果显式 `preloadSdk=true`，SDK Resource 会在 preload 阶段固定，建议同时在 package 配置中写 `serviceName`。
> 本地开发或临时停报时，可设置 `app.config.otel.enabled=false`、`opentelemetryPlugin({ enabled:false })`、`package.json vext.otel.enabled=false` 或 `OTEL_SDK_DISABLED=true`；需要完全跳过 Vext package preload 时可加 `VEXT_OTEL_PRELOAD=0`。

VextJS 使用 `vext start` / `vext dev` 时，instrumentation 会通过 `vext.preload` 自动注入；自定义启动脚本时需手动加 `--import`：

```json
{
  "scripts": {
    "start": "node --import @devcodex/opentelemetry/instrumentation dist/server.js"
  }
}
```

### Egg.js

Egg.js 采用 CJS `--require` 预加载模式，**SDK 必须在任何模块加载前完成初始化**。

```javascript
// app/otel-init.cjs
"use strict";
const { initOtel } = require("@devcodex/opentelemetry/koa");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");

initOtel({
  serviceName: "my-service",
  endpoint: process.env.OTEL_COLLECTOR_ENDPOINT || "47.89.182.109:32767",
  instrumentations: [new HttpInstrumentation()],
});
```

```json
{
  "scripts": {
    "dev": "egg-bin dev --require ./app/otel-init.cjs",
    "start": "egg-scripts start --require ./app/otel-init.cjs"
  }
}
```

```typescript
// app/middleware/otel.ts
import {
  createEggMiddleware,
  type EggContextLike,
} from "@devcodex/opentelemetry/egg";

type AppEggContext = EggContextLike & {
  user_id?: string;
  feature_flag?: string;
  state?: Record<string, unknown> & { userId?: string; user?: { id?: string } };
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
      "request.body.present": Boolean(rawCtx.request?.body),
    }),
  },
  lifecycle: {
    onStart: (_ctx, rawCtx) => {
      rawCtx.user_id = rawCtx.state?.userId ?? rawCtx.state?.user?.id ?? "";
      rawCtx.feature_flag = rawCtx.get("x-feature-flag") || "";
    },
    onEnd: (ctx, rawCtx, info) => {
      rawCtx.logger?.info?.(
        `${ctx.method} ${rawCtx.status} ${ctx.route ?? ctx.path} ${info.latencyMs}ms`,
      );
    },
  },
});
```

更完整的 Egg 示例可参考：[`examples/egg-middleware.ts`](./examples/egg-middleware.ts)

### Koa

```typescript
import Koa from "koa";
import { createKoaMiddleware } from "@devcodex/opentelemetry/koa";
import { getOtelStatus } from "@devcodex/opentelemetry";

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

### Express

> Express / Hono / Fastify 只提供 HTTP 中间件 / 插件适配层，**不提供** `initOtel()` 子路径。
> 这三类框架请先通过 `node --import @devcodex/opentelemetry/instrumentation ...` 或自建 bootstrap 完成 SDK 初始化，再注册中间件 / 插件。

```typescript
import express from "express";
import { createExpressMiddleware } from "@devcodex/opentelemetry/express";
import { getOtelStatus } from "@devcodex/opentelemetry";

const app = express();
app.use(createExpressMiddleware({ serviceName: "my-express-app" }));
app.get("/_otel/status", (_req, res) => res.json(getOtelStatus()));
```

### Hono

```typescript
import { Hono } from "hono";
import { createHonoMiddleware } from "@devcodex/opentelemetry/hono";
import { getOtelStatus } from "@devcodex/opentelemetry";

const app = new Hono();
app.use(createHonoMiddleware({ serviceName: "my-hono-app" }));
app.get("/_otel/status", (c) => c.json(getOtelStatus()));
```

### Fastify

```typescript
import Fastify from "fastify";
import { createFastifyPlugin } from "@devcodex/opentelemetry/fastify";
import { getOtelStatus } from "@devcodex/opentelemetry";

const fastify = Fastify();
await fastify.register(createFastifyPlugin({ serviceName: "my-fastify-app" }));
fastify.get("/_otel/status", () => getOtelStatus());
```

---

## 框架差异速查

| 特性              | VextJS                                                    | Egg.js / Koa                                      | Express / Hono / Fastify                                         |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| SDK 初始化        | `--import`（自动/手动）                                   | `--require otel-init.cjs`                         | `--import` 或应用自建 bootstrap/init 文件                        |
| exporter 配置位置 | `package.json vext.otel` / plugin options                 | `initOtel()`                                      | 应用侧自行初始化 SDK                                             |
| 请求观测配置      | `opentelemetryPlugin({ tracing/metrics/lifecycle/logs })` | `createEggMiddleware()` / `createKoaMiddleware()` | `createXxxMiddleware()`                                          |
| `raw` 参数形态    | `req`                                                     | `ctx`                                             | Express `{ req, res }` / Hono `c` / Fastify `{ request, reply }` |
| logger bridge     | `logs.bridgeAppLogger`                                    | 应用层手动                                        | 应用层手动                                                       |

### `/_otel/status` 说明

- VextJS 适配器当前会自动注册 `GET /_otel/status`，直接返回 `app.otel.getStatus()`。
- `statusEndpoint` 选项仅保留作兼容占位，**不支持自定义路径**。
- 其他框架如需状态接口，请在应用里手动路由到 `getOtelStatus()`。

---

## 内置指标

> ⚠️ **命名说明**：OTLP 中所有字段名遵循 OTel 语义约定，使用点分隔（`.`）。表中同时给出 OTLP 原始名称和 Prometheus 端转换后的查询名称，详见下方[字段命名约定](#字段命名约定)。

| OTLP 指标名                   | Prometheus 查询名             | 类型              | OTLP 属性键                                       | Prometheus 标签键                                 |
| ----------------------------- | ----------------------------- | ----------------- | ------------------------------------------------- | ------------------------------------------------- |
| `http.server.duration`        | `http_server_duration`        | Histogram (ms)    | `http.method` / `http.status_code` / `http.route` | `http_method` / `http_status_code` / `http_route` |
| `http.server.request.total`   | `http_server_request_total`   | Counter           | `http.method` / `http.status_code` / `http.route` | `http_method` / `http_status_code` / `http_route` |
| `http.server.active_requests` | `http_server_active_requests` | UpDownCounter     | `http.method`                                     | `http_method`                                     |
| `http.server.request.size`    | `http_server_request_size`    | Histogram (bytes) | `http.method`                                     | `http_method`                                     |
| `http.server.response.size`   | `http_server_response_size`   | Histogram (bytes) | `http.method` / `http.status_code`                | `http_method` / `http_status_code`                |

> 额外自定义标签请通过 `metrics.labels` 提供，并保持**低基数**。

---

### 字段命名约定

OTLP 协议本身保留点分隔命名（`http.status_code`），但导出到不同后端时会发生**自动转换**：

| 后端                 | 转换规则                       | 示例                                                                                     |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| Prometheus / Grafana | `.` → `_`                      | `http.status_code` → `http_status_code`；`http.server.duration` → `http_server_duration` |
| Jaeger / Zipkin      | 保持原样（`.` 分隔）           | `http.status_code` 不变                                                                  |
| ClickHouse / Tempo   | 通常保持原样，视采集器配置而定 | —                                                                                        |

此转换由 **OTLP Exporter / Collector / 后端** 在写入时自动完成，SDK 侧不做转换。

#### 对 `metrics.labels` 自定义标签的影响

通过 `metrics.labels` 返回的自定义标签键，若包含 `.`，在 Prometheus 中会被自动替换为 `_`：

```typescript
// 配置侧：使用 OTel 语义约定的点分隔命名
const options = {
  metrics: {
    labels: (_ctx, raw) => ({
      "tenant.id": raw.get?.("x-tenant-id") ?? "", // 点分隔
      "app.version": "1.2.0", // 点分隔
    }),
  },
};

// Prometheus 查询侧：自动转换为下划线
// tenant_id="t-001", app_version="1.2.0"
```

> 💡 **建议**：在同一项目中统一选择点分隔（OTel 语义约定）或下划线（Prometheus 惯用），避免混用造成查询混乱。如果你的主要后端是 Prometheus / Grafana，可以直接在 `metrics.labels` 键名里用 `_`，OTLP 侧也能正常传递，这样不需要在脑中做转换。

---

## 在代码中访问

```typescript
import {
  createWithSpan,
  getActiveTraceId,
  getOtelStatus,
} from "@devcodex/opentelemetry";

const withSpan = createWithSpan("my-service");

const userResult = await withSpan("db.user.find", () => UserModel.findById(id));

const paymentResult = await withSpan("payment.process", async (span) => {
  const res = await processPayment(body);
  span.setAttribute("payment.result", res.status);
  return res;
});

const paymentResultWithAttrs = await withSpan(
  "payment.process",
  () => processPayment(body),
  {
    attributes: { "payment.provider": "stripe" },
  },
);

const traceId = getActiveTraceId(); // 无 active span 时返回 ''

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

---

## 许可证

MIT © VextJS Contributors
