# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 初始化仓库骨架：README、LICENSE（Apache-2.0）、.gitignore（含敏感文件红线）、协作与提交规范（CONTRIBUTING.md）、安全约定（SECURITY.md）、PR 模板。
- **并发评审设置（2026-10-14 迭代，用户拍板）**：设置面板新增「并发评审」开关（默认关 = 单线）与「并发广度」设置项（默认 8，范围 1–32，仅在开关开启时展开显示）。
  - 未开启 → 引擎显式 `--concurrency 1`（单线，行为确定，不随引擎默认并发 8 漂移）；
  - 开启 → `--concurrency <n>` 并行审查（提速明显，token 消耗增加——成本控制权在用户侧）；
  - 面板保存经新增 `POST /api/code-review/config` 写通道直落运行真源
    `~/.dsh/dsh-code-review/plugin-config.json`（0.2.0 宿主面板保存不回传运行层，并发字段因此单独修通）；
  - 报告正文新增「并发: 单线 / N 路并行」注记行；评审报告留档可复现当次怎么跑的。

### Changed
- 发布净化（2026-10-14）：内部开发文档移出公开仓库，仅保留最简可发布文件集；全仓零敏感重扫通过。
- 引擎参数组装（runner.js `buildReviewArgs`）恒带 `--concurrency`：关闭并发 = `1`、开启 = 用户广度（1..32 钳制）。
