# Changelog

All notable changes to `vextjs-opentelemetry` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 📂 **Detailed changelogs**: 已发布版本的独立说明见 [`changelogs/`](./changelogs/) 目录。
> 本文件仅作为版本总览索引，方便快速浏览发布历史。

---

## Version History

| Version | Date | Type | Key Theme |
|---------|------|------|-----------|
| [Unreleased] | — | — | — |
| [2.0.0] | 2026-05-14 | Major | 统一公开配置模型：`startAttributes / endAttributes / metrics.labels / lifecycle`，移除旧 API 主语义并完成仓库内迁移 [查看](./changelogs/v2.0.0.md) |
| [1.0.6] | 2026-05-14 | Patch | 兼容性与文档收口：异常路径 span name 对齐、README 导航与矩阵修正、`lateAttributes` / `verify` 发布收口 [查看](./changelogs/v1.0.6.md) |
| [1.0.5] | 2026-04-28 | Patch | deferred export 启动摘要默认静默，降低 VextJS preload 阶段误导性日志 [查看](./changelogs/v1.0.5.md) |
| [1.0.4] | 2026-04-28 | Patch | gRPC h2c 导出成功日志默认静默，改为失败告警 + 恢复提示 [查看](./changelogs/v1.0.4.md) |
| [1.0.3] | 2026-04-28 | Patch | `service.name` 回退策略修正 + Egg 示例失效导入修复 + `vextjs` peer 约束放宽 |
| [1.0.2] | 2026-04-08 | Patch | `ignorePaths` 同时抑制 Trace / Metrics，并新增请求/响应体大小指标 |
| [1.0.1] | 2026-04-08 | Patch | Egg access log `traceId` 回写修复 |
| [1.0.0] | 2026-04-07 | Major | v1 完整重构：多框架适配器、instrumentation 预加载、日志桥接与统一核心抽象 |

---

## Links

- [Detailed Changelogs](./changelogs/)

[Unreleased]: https://github.com/vextjs/vextjs-plugins/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/vextjs/vextjs-plugins/compare/v1.0.6...v2.0.0
[1.0.6]: https://github.com/vextjs/vextjs-plugins/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/vextjs/vextjs-plugins/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/vextjs/vextjs-plugins/compare/v1.0.0...v1.0.4
[1.0.3]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@1.0.2...vextjs-opentelemetry@1.0.3
[1.0.2]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@1.0.1...vextjs-opentelemetry@1.0.2
[1.0.1]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@1.0.0...vextjs-opentelemetry@1.0.1
[1.0.0]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.5...vextjs-opentelemetry@1.0.0
[0.1.3]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.2...vextjs-opentelemetry@0.1.3
[0.1.2]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.1...vextjs-opentelemetry@0.1.2
[0.1.1]: https://github.com/vextjs/vextjs-plugins/compare/vextjs-opentelemetry@0.1.0...vextjs-opentelemetry@0.1.1
[0.1.0]: https://github.com/vextjs/vextjs-plugins/releases/tag/vextjs-opentelemetry@0.1.0
