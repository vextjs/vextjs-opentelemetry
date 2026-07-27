# Changelog

All notable changes to `@devcodex/opentelemetry` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 📂 **Detailed changelogs**: 已发布版本的独立说明可从 [`changelogs/v2.1.0.md`](./changelogs/v2.1.0.md) 进入查看（`v2.0.x` 历史 patch 说明保留在 [`changelogs/v2.0.0.md`](./changelogs/v2.0.0.md)）。
> 本文件仅作为版本总览索引，方便快速浏览发布历史。

---

## Version History

| Version      | Date       | Type  | Key Theme                                                                                                                                                          |
| ------------ | ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Unreleased] | —          | —     | Pending changes                                                                                                                                                    |
| [2.1.12]     | 2026-07-27 | Patch | 包名迁移到 `@devcodex/opentelemetry`，仓库入口迁移到 `devcodex-labs/opentelemetry`，保留运行时兼容标识与日志前缀                                      |
| [2.1.11]     | 2026-06-11 | Patch | VextJS 自动 preload 延后完整 SDK/exporter，修复禁用后仍可能启动/上报，并升级 OTel auto-instrumentations 安全依赖 [查看](./changelogs/v2.1.11.md)                   |
| [2.1.10]     | 2026-06-09 | Patch | 固定 runtime 与 dev direct dependencies 为 lockfile 已解析精确版本，降低消费者安装时的依赖漂移风险 [查看](./changelogs/v2.1.10.md)                                |
| [2.1.9]      | 2026-06-08 | Patch | 文档补强：明确 `enabled:false` 与 `endpoint:"none"` 的关闭上报边界，并修正当前仓库 compare 链接口径                                                                |
| [2.1.0]      | 2026-05-18 | Minor | `capture` 能力增强：四类输入统一支持显式全量、规则对象控制、body flatten/snapshot 与 `maxItems`/`output` 护栏 [查看](./changelogs/v2.1.0.md)                       |
| [2.0.2]      | 2026-05-18 | Patch | Docker / 私有源兼容性回退：将 `@opentelemetry/auto-instrumentations-node` 临时回退到 `0.72.0`，锁文件同步刷新并保持 `verify` 全通过 [查看](./changelogs/v2.0.0.md) |
| [2.0.1]      | 2026-05-15 | Patch | `capture` 收口发布：`query/params` 显式全量采集、Koa/Egg 晚到字段修复、README 重构与依赖安全升级 [查看](./changelogs/v2.0.0.md)                                    |
| [2.0.0]      | 2026-05-14 | Major | 统一公开配置模型：`startAttributes / endAttributes / metrics.labels / lifecycle`，移除旧 API 主语义并完成仓库内迁移 [查看](./changelogs/v2.0.0.md)                 |
| [1.0.6]      | 2026-05-14 | Patch | 兼容性与文档收口：异常路径 span name 对齐、README 导航与矩阵修正、`lateAttributes` / `verify` 发布收口 [查看](./changelogs/v1.0.6.md)                              |
| [1.0.5]      | 2026-04-28 | Patch | deferred export 启动摘要默认静默，降低 VextJS preload 阶段误导性日志 [查看](./changelogs/v1.0.5.md)                                                                |
| [1.0.4]      | 2026-04-28 | Patch | gRPC h2c 导出成功日志默认静默，改为失败告警 + 恢复提示 [查看](./changelogs/v1.0.4.md)                                                                              |
| [1.0.3]      | 2026-04-28 | Patch | `service.name` 回退策略修正 + Egg 示例失效导入修复 + `vextjs` peer 约束放宽                                                                                        |
| [1.0.2]      | 2026-04-08 | Patch | `ignorePaths` 同时抑制 Trace / Metrics，并新增请求/响应体大小指标                                                                                                  |
| [1.0.1]      | 2026-04-08 | Patch | Egg access log `traceId` 回写修复                                                                                                                                  |
| [1.0.0]      | 2026-04-07 | Major | v1 完整重构：多框架适配器、instrumentation 预加载、日志桥接与统一核心抽象                                                                                          |

---

## Links

- [Detailed Changelog File](./changelogs/v2.1.0.md)

[Unreleased]: https://github.com/devcodex-labs/opentelemetry/compare/v2.1.12...HEAD
[2.1.12]: https://github.com/devcodex-labs/opentelemetry/compare/v2.1.11...v2.1.12
[2.1.11]: https://github.com/devcodex-labs/opentelemetry/compare/v2.1.10...v2.1.11
[2.1.10]: https://github.com/vextjs/vextjs-opentelemetry/compare/v2.1.9...v2.1.10
[2.1.9]: https://github.com/vextjs/vextjs-opentelemetry/compare/v2.1.8...v2.1.9
[2.1.0]: https://github.com/vextjs/vextjs-opentelemetry/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/vextjs/vextjs-opentelemetry/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/vextjs/vextjs-opentelemetry/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.6...v2.0.0
[1.0.6]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.0...v1.0.4
[1.0.3]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/vextjs/vextjs-opentelemetry/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vextjs/vextjs-opentelemetry/compare/v0.1.5...v1.0.0
[0.1.3]: https://github.com/vextjs/vextjs-opentelemetry/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/vextjs/vextjs-opentelemetry/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/vextjs/vextjs-opentelemetry/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vextjs/vextjs-opentelemetry/releases/tag/v0.1.0
