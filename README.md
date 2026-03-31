# vextjs-opentelemetry

> VextJS 官方 OpenTelemetry 集成插件 — 零配置追踪、指标与日志关联

[![npm version](https://img.shields.io/npm/v/vextjs-opentelemetry.svg)](https://www.npmjs.com/package/vextjs-opentelemetry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

将原本需要手写的 ~200 行 OpenTelemetry 样板代码压缩为 **1 文件 2 行**，开箱即得完整的可观测性三大支柱：Traces（链路追踪）、Metrics（指标监控）、Logs（日志关联）。

📖 **[完整文档 → vextjs.github.io/vext/examples/opentelemetry.html](https://vextjs.github.io/vext/examples/opentelemetry.html)**

---

## 特性

- **零样板代码** — 1 文件 2 行即可接入完整 OpenTelemetry 能力
- **追踪** — 自动标注 HTTP Span 属性（路由、状态码、请求 ID）
- **指标** — 内置 HTTP 请求时长直方图、请求总数、活跃请求数
- **日志关联** — 自动将 `trace_id` / `span_id` 注入每条请求日志
- **优雅降级** — SDK 未初始化时以 Noop 模式运行，零 overhead，不抛错
- **类型安全** — 内置 `declare module 'vextjs'` 扩展，IDE 自动补全

---

## 安装

```bash
# 必须安装
npm install vextjs-opentelemetry @opentelemetry/api

# 可选：需要实际发送遥测数据时安装
npm install @opentelemetry/sdk-node \
            @opentelemetry/exporter-trace-otlp-http \
            @opentelemetry/exporter-metrics-otlp-http

# 可选：自动检测 HTTP、fetch、数据库等
npm install @opentelemetry/auto-instrumentations-node
```

---

## 快速开始

**Step 1** — 创建插件文件：

```typescript
// src/plugins/otel.ts
import { opentelemetryPlugin } from "vextjs-opentelemetry";

export default opentelemetryPlugin({
  serviceName: "my-app",
});
```

**Step 2**（可选）— 在 `package.json` 中添加 SDK 初始化，将数据发送到可观测性后端：

```json
{
  "scripts": {
    "start": "node --import vextjs-opentelemetry/instrumentation dist/server.js"
  }
}
```

**完成！** 现在每个 HTTP 请求都会自动：

- 标注 OpenTelemetry Span（路由、状态码、请求 ID 等属性）
- 统计 HTTP 指标（时长、总数、活跃请求数）
- 将 `trace_id` / `span_id` 注入请求日志

---

## 配置概览

```typescript
opentelemetryPlugin({
  serviceName: "my-app",   // 服务名（也可通过 OTEL_SERVICE_NAME 环境变量设置）
  enabled: true,           // false 时完全跳过，适合测试环境

  tracing: {
    enabled: true,
    extraAttributes: (req) => ({   // 动态注入业务维度到 Span
      "user.id": req.headers["x-user-id"] ?? "",
    }),
  },

  metrics: {
    enabled: true,
    durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  },
});
```

> 完整配置说明、环境变量参考、接入效果演示及后端配置示例，请查阅 **[官方文档](https://vextjs.github.io/vext/examples/opentelemetry.html)**。

---

## 内置指标

| 指标名称                       | 类型           | 说明               |
| ------------------------------ | -------------- | ------------------ |
| `http.server.duration`         | Histogram (ms) | HTTP 请求时长      |
| `http.server.request.total`    | Counter        | HTTP 请求总数      |
| `http.server.active_requests`  | UpDownCounter  | 当前活跃请求数     |

所有指标均带 `http.method` / `http.status_code` / `http.route` 标签。

---

## 在代码中访问

```typescript
// 在路由 handler 或 service 中访问 tracer / meter / metrics
const { tracer, meter, metrics } = req.app.otel!;

// 手动创建 Span
const span = tracer.startSpan("db.query");
// ...
span.end();

// 自定义指标
const counter = meter.createCounter("business.order.created");
counter.add(1, { "order.type": "standard" });
```

---

## 文档

| 主题                   | 链接                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| 快速开始 & 接入效果    | [文档 → 快速开始](https://vextjs.github.io/vext/examples/opentelemetry.html#快速开始3-步接入)    |
| 完整配置项             | [文档 → 配置详解](https://vextjs.github.io/vext/examples/opentelemetry.html#配置详解)            |
| 接入 Jaeger / Grafana  | [文档 → 可观测性后端](https://vextjs.github.io/vext/examples/opentelemetry.html#接入可观测性后端) |
| 高级用法（自定义 Span）| [文档 → 高级用法](https://vextjs.github.io/vext/examples/opentelemetry.html#高级用法)             |
| Cluster 模式           | [文档 → Cluster](https://vextjs.github.io/vext/examples/opentelemetry.html#cluster-多进程模式)   |
| 常见问题               | [文档 → FAQ](https://vextjs.github.io/vext/examples/opentelemetry.html#常见问题)                 |

---

## 许可证

MIT © VextJS Contributors