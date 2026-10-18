# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-10-18

### 引擎 fork 治理（#2–#7 合并）

- **死重清理（#3 PR-A）**：删除上游发布/社区死重设施（`examples/*_ci/`、`install.*`、`scripts/publish/*`、`scripts/github-actions/*`、`npm/*/package.json`、`internal/llm/gen/**`、`scripts/{install,update,version,platform}.js` 等 70 文件，净删约 2.9 万行）与指向已删目录的失效引用；`engine/AGENTS.md` 收敛为一句「沿用上游开发约定」
- **固定规则数据化（#2 PR-D）**：三条固定评审规则正文自 Go 常量迁至 `engine/internal/config/rules/rule_docs/fork_mandatory.md`（数据驱动，与同目录 54 个规则文档同构，`//go:embed` 读入）；项目规则 `.opencodereview/rule.json` 上移仓库根
- **fork 身份与版本可辨识（#4 PR-C）**：`codecheck --version` 输出 `<插件版本>+fork.<N> (g<sha>)`；构建单一真源 `engine/scripts/build-fork.sh`；新增 `engine/NOTICE`（Apache-2.0 §4 上游归属）与 `engine/FORK_NOTES.md`；`--version` 归属行保留
- **命令名收敛（#5 PR-B）**：用户可见文案 `ocr`→`codecheck`（135 处分类处置：改 101 / 契约保留 13 / 注释 19）；命令名唯一真源（`internal/buildinfo.CommandName`）+ 防漂移护栏测试
- **SPDX 双持有人合规（#6 PR-E）**：插件根 32 个 js/mjs 文件补 SPDX 头；`verify-license.sh`/`add-license.sh` 按路径分发持有人（engine/ → 上游 alibaba，插件根 → dsh-code-review contributors）
- **集成收尾（#7 PR-F）**：`engine/Makefile` 对齐 `build-fork.sh`（二进制名 `codecheck`、版本真源直读根 `package.json`、去 `/extensions/` 过期过滤器）；`root.go` 帮助文案 fork 身份化（保留 Apache-2.0 归属）；`verify-english-only.go` 豁免表清 4 条死条目；`.gitignore` 死条目清理；`engine/imgs/**` 孤儿图片（12 个，约 2.6 MB）整目录删除；CI 新增引擎 `go test -short` + `go build` 门禁；根 `README.md` 增加 `engine/FORK_NOTES.md` 指针

## [0.1.1] - 2026-10-18

### DSH 0.2.1 适配

面向 DeepSeek Harness **0.2.1**（npm `next` 线，如 `0.2.1-rc.2`；本插件原基线为 0.2.0）的适配。
0.2.1 在插件 API 面基本稳定，差异集中在数据语义与命令服务；本次逐条对齐，并修掉两个从未生效的历史接点。

- **兼容声明**：`package.json` 增补 `engines.dsh: ">=0.2.0-rc.2 <0.3.0"` —— 0.2.1 起插件版本兼容性
  以 `engines.dsh` 优先判定（`docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh`），显式声明支持的
  宿主区间（含 0.2.0-rc.2 ~ 0.2.1 各 prerelease）。
- **斜杠命令接入 0.2.x 命令 API（Fixed）**：`/review`、`/review-status` 改走**复数 `commands` 服务**
  `ctx.commands.register({ name, description, input, handler })`；此前用**单数 `command` 服务** +
  链式 `.command().option().argument().action()`，该服务在 0.2.x 任一版本都不存在 →
  `ctx.inject(['command'], …)` 永不就绪、命令**从未注册成功**。命令名之后的原文改由命令自解析
  （`parseReviewInput`），发起会话与工作目录取自 `invocation.agent.session`（`session.id` /
  `session.header.cwd`），不再依赖已不存在的 `argv.session`。
- **设置卡片可写判定（Fixed）**：客户端 `ConfigFormSnapshot` 在 0.2.1 移除了 `mode` 字段
  （0.2.0 为 `'host' | 'memory'`）——快照形状校验与可写判定不再依赖 `mode`，否则快照被误判为坏形状、
  卡片永久只读（并连带使面板内的并发开关失效）。
- **凭据优先级对齐 0.2.1（Changed）**：评审 key 解析改为**存储凭据优先于导出环境变量**
  （此前 env 优先），对齐 DSH 0.2.1 的 stored-credentials-precedence
  （`docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence`）；文件里存在非空值即采用，
  否则回退同名环境变量（覆盖 headless profile 无凭据存储、只用启动环境 / `.env` 的情形）。
- **评审模型取值口（Fixed）**：会话当前模型的读取改经 `ctx.get('agentDefaultModel')`
  （未在静态 `inject` 内的可选服务直接属性访问会落空 / 抛错），恢复「默认沿用会话模型」透传。
- **模型目录读法（Fixed）**：deepseek-account 路由 0.2.1 起不再接受 `models` 目录字段（模型改由账号
  端点列出、单模型调整迁 `modelOverrides`）——模型候选解析改为「数组 `models` 优先，缺失时回退
  `modelOverrides` 键集」，避免读到空目录。
- **自检增强**：Cordis 入口冒烟新增「/review 与 /review-status 已注册」断言；客户端冒烟的快照垫片
  去掉 `mode`，与 0.2.1 快照形状对齐。

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

[Unreleased]: https://github.com/Nicholas023/dsh-code-review/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Nicholas023/dsh-code-review/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Nicholas023/dsh-code-review/releases/tag/v0.1.1
[0.1.0]: https://github.com/Nicholas023/dsh-code-review/releases/tag/v0.1.0
