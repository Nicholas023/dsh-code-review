# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-17

首个公开版本：Cordis 原生代码审查插件，把评审引擎 `codecheck`（open-code-review 的 fork 改造，Apache-2.0）
接入 DeepSeek Harness（DSH）——对仓库 diff / 全量扫描执行安全与脱敏、找 bug、冗余与任务无关代码
三个固定视角的评审，会话内返回问题清单并落一份报告文件留档。

### Added

- 双入口：原生工具 `code_review`（会话自然语言自动触发，日常主力）与斜杠命令 `/review`（手动精确传参：分支 / 提交 / 目录 / 重点）。
- 两种评审：`review`（工作区未提交 / 分支对比 / 指定提交）与 `scan`（整仓全量扫描）。
- 三个固定评审视角（引擎内置默认规则，零配置也生效）：① 安全审核——脱敏（硬编码密钥 / 口令 / PII / 内部信息）+ 安全漏洞；② 找 bug；③ 冗余与任务无关代码（scope creep / 死代码）。
- 评审模型：默认沿用会话模型（DSH 官方 `deepseek-flash` / DeepSeek-V41-Flash）；可另选异构模型（写码与审查不同模型，「错」不一起错），选项动态读取 DSH 模型配置体系（含 `thinkingFormat`），不硬编码。
- 后台评审任务：serve 按需拉起、单例多会话共享，任务簿走目录协议（`~/.dsh/dsh-code-review/tasks/<id>.json`，免端口、断线不丢）——不阻塞会话前台、慢模型不超时；`code_review_status` 查状态取结果，完成后推送回发起会话。
- GUI 可见性：插件页任务卡实时刷新（`/api/code-review/tasks`、`/api/code-review/events` 数据路由 + SSE）。
- 敏感文件点名：敏感 / 凭据类路径内容不送审（引擎内置排除），插件层自检待提交清单并逐文件点名列入报告，提示人工确认是否该提交——不许静默。
- 结果双给：会话内完整问题清单（文件 + 行号 + 类型 + 严重度 + 建议）+ 报告文件按日期 / 仓库存档（`<报告目录>/<YYYY-MM-DD>/<仓库名>-<时间戳>.md`），作为「发 GitHub 前已审过」的凭证。
- 并发评审开关与并发广度（范围 1–32，默认 8；开关默认关 = 单线顺序审查）——开启后并行审查提速、token 消耗增加，成本控制权在用户侧；设置面板保存经 `POST /api/code-review/config` 直落运行真源。
- 配置通道：运行真源为插件自有配置文件 `~/.dsh/dsh-code-review/plugin-config.json`，经 `code_review_set_config` 工具读写（写入即生效，无需重启）。
- 首次启用引导（确认评审模型沿用 / 报告目录等，见 `first_run`）。
- 仓库基础文件：README、LICENSE（Apache-2.0）、NOTICE（上游归属）、CONTRIBUTING、SECURITY、PR 模板、package-lock.json 锁依赖。
- GitHub Actions CI 门禁：JS `node --check` + 引擎 `gofmt`/`go vet`、冒烟矩阵、敏感扫描三组（ubuntu / windows 双平台矩阵）。

### Changed

- 评审通道红线：移除官方付费 API 兜底——会话模型拿不到 / 路由表为空 / 目标模型不存在时，回退用户配置路由表首或明确报错并提示配置，绝不静默发起外部调用产生未知账单。
- 评审超时语义：取消任务级严格超时（进程级兜底放宽至 6 小时，仅防引擎死循环占死 serve）；引擎侧 LLM 单请求超时独立（默认 600s，防端点悬挂）。
- 引擎参数组装恒带 `--concurrency`：关闭并发 = `1`（单线，行为确定，不随引擎默认并发漂移）、开启 = 用户广度（1..32 钳制）；报告正文含「并发: 单线 / N 路并行」注记，留档可复现当次怎么跑的。
- 引擎 fork 改造：全局改名 `ocr` → `codecheck`、内置三条固定评审规则、Windows 子进程隐藏窗口（`internal/sysproc`，全部运行期 exec 接点）、跨平台进程树终止、敏感内容排除、R1–R8 评审整改。
- 发布净化：内部开发文档移出公开仓库，仅保留最简可发布文件集；清除已入库的本机绝对路径；全仓零敏感重扫通过。

### Fixed

- 状态单查把 `lines` 声明为 `const` 却在分支里 `+=`，抛 `Assignment to constant variable`。
- `result-text` 的 `elapsedSec` 非有限值回退 0，避免渲染 `NaN`。
- 评审链路边界整改：并发配置传递、`--exclude` 单值语义、readBody 分片计数上限等（R8 剩余条目 / R9 评审）。

[Unreleased]: https://github.com/Nicholas023/dsh-code-review/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nicholas023/dsh-code-review/releases/tag/v0.1.0
