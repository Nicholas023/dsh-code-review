# dsh-code-review

智能代码审查插件（DeepSeek Harness / DSH Cordis 插件）。

对代码仓库执行评审：调用引擎 **codecheck**（阿里 open-code-review 的 fork 改造，Apache-2.0）
读取 git diff 或做全目录扫描，由评审模型按三个固定视角挑刺：

1. **安全与脱敏** —— 硬编码密钥/口令/PII/内部信息泄露 + 安全漏洞；
2. **找 bug** —— 逻辑/边界/异常/并发缺陷；
3. **冗余与任务无关代码** —— scope creep / 死代码。

结果双给：会话内完整问题清单（文件 + 行号 + 类型 + 严重度 + 建议）；
同步落一份报告文件（按日期/仓库存放）留档，作为「发 GitHub 前已审过」的凭证。

## 双入口

| 入口 | 方式 | 用途 |
|---|---|---|
| 原生工具 `code_review` | 会话里说「审一下当前改动」自动触发 | 日常主力 |
| 斜杠命令 `/review` | 手动精确传参：分支/提交/目录/重点 | 需要指定范围时 |

## 评审模型

- 默认**沿用会话模型**（DSH 官方默认的 `deepseek-flash` / DeepSeek-V41-Flash，
  凭据走 DSH 既有通道，无需手工配置）；
- **另选**评审模型（异构评审：写代码的模型与审查的模型不同，「错」不一起错）：
  用原生工具 `code_review_set_config`（会话里说「把评审模型改成 X」自动触发）写入插件
  自有配置文件 `~/.dsh/dsh-code-review/plugin-config.json`，写入即生效（无需重启）；
  模型标识 = DSH 模型配置里已有的模型名（选项动态读取 DSH 模型配置体系
  —— 官方账号与副账号等已配置的 providers/models，含 thinkingFormat；
  其他模型需先在 DSH 侧配好，不硬编码）。
- ⚠️ 设置面板「智能代码审查」分区的 `review_model` / `report_dir` / `engine_bin` / `first_run`
  字段**暂不生效**（2026-10-13 实测：0.2.0 宿主「面板保存」对第三方 bundle 插件只写组合树文件、
  不回传运行层）——这些字段保留注册，宿主回传通道修复后自动启用；当前以
  `code_review_set_config` 工具 / 插件配置文件为运行真源。
- **并发评审 / 并发广度两字段为例外**（2026-10-14 迭代）：面板保存时插件经自有
  `POST /api/code-review/config` 写通道把值直落运行真源 `~/.dsh/dsh-code-review/plugin-config.json`，
  **正常生效**——关闭（默认）= 单线顺序审查（引擎显式 `--concurrency 1`）；开启即展开
  「并发广度」（1–32，默认 8），并行审查大幅提速，但 token 消耗随之成倍增加（成本由用户侧控制）。

**喂参机制（OCR-managed）**：插件运行时把评审模型解析成
`OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL / OCR_LLM_PROTOCOL / OCR_LLM_TIMEOUT`
五个环境变量注入引擎子进程（key 解析顺序：`~/.dsh/.credentials.yaml` 的 `refs` 条目 →
同名环境变量 —— **存储凭据优先于导出变量**，与 DSH 0.2.1 的
stored-credentials-precedence 口径一致；key 只进子进程环境，**不落盘、不进日志**）。若用户已在
`~/.opencodereview/config.json` 显式完整配置 provider，引擎按其自身优先序使用用户配置
（期望行为）；插件注入作为引擎侧未配置时的默认通道。

## 敏感文件点名

引擎内置敏感路径保护会**静默排除**敏感文件（内容不送审，防二次泄露）；
插件层额外自检待提交清单，命中敏感模式（`.env`、私钥、pem、token、credentials 等）的
每个文件**点名列入报告与会话结果**（类型=敏感文件），提示人工确认是否该提交——不许静默。

待提交清单默认**自动收集**（`git ls-files --others --exclude-standard` + `git diff --name-only`
+ `git diff --cached --name-only` 并集去重），也支持经工具参数 `pending_paths` 显式传入；
点名只涉及文件名，**不读取文件内容**（内容由引擎侧排除，双保险）。

## 安装（热装，免重启）

> ⚠️ **npm 同名包警告**：npm 上的 [`dsh-code-review`](https://www.npmjs.com/package/dsh-code-review)
> 属于另一个活跃项目（dsh-electron 生态的代码审查模式 agent preset），**不是本插件**。
> `npm install dsh-code-review` 装到的是对方的包，无法使用。本插件**不走 npm 分发**——
> 安装请按以下步骤从 GitHub Release 获取。

1. 从 [GitHub Releases](https://github.com/Nicholas023/dsh-code-review/releases) 下载最新版本，
   将插件目录 junction 进 profile 的 node_modules：
   ```powershell
   # 假设解压到 D:\DSH-Files-v2\02-DSH开发\代码审查插件\dsh-code-review
   node scripts/link-deps.mjs        # 连接开发期依赖（junction，幂等）
   npm install                        # 仅安装本仓库声明的依赖（js-yaml 等），不会从 npm 装本插件
   ```
2. 经 DSH 插件管理页把本包加入 profile（读取 `cordis.patch.yml` 注入组合树），
   或手工在 profile 的 `cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-code-review
         name: 'dsh-code-review'
   ```
3. 引擎 codecheck：从 Release 下载编译产物放到插件包 `bin/codecheck(.exe)`，
   或经工具 `code_review_set_config` 的 `engine_bin` 指定绝对路径。

## 开发

```powershell
node scripts/link-deps.mjs           # 连接开发期依赖（junction，幂等）
npm run check                        # 全部 js 语法检查
npm run unit                         # 确定性模块自检（60 项，不联网）
npm run smoke                        # Cordis 入口冒烟自检（挂载前提验证）
npm run e2e-engine                   # 引擎侧端到端（真实 DeepSeek 官方评审，需本机凭据）
npm run e2e-plugin                   # 插件管道端到端（model-provider→credentials→runner）
npm run e2e-switch                   # 切模型端到端（默认取本机 DSH 配置中的任一模型 id，实证「另选模型也通」）
npm run e2e-sensitive                # 敏感文件点名层端到端（判据⑥：含 .env 仓库 → 报告点名）
npm run selfcheck                    # unit + smoke 全量
```

> e2e 会调用真实评审 API（约 10-50s / 次、数千 token），在 CI/无凭据环境会自动
> 判失败并给出明确原因。切模型实证默认模型可经命令行参数替换：`node scripts/switch-model-e2e.mjs <模型id>`
> （模型 id 以本机 DSH 配置为准，即 `code_review_set_config` 的 review_model 取值）。

## 兼容性（DSH 版本）

- 适配目标：**DeepSeek Harness 0.2.1**（npm `next` 线，如 `0.2.1-rc.2`）；同时兼容本插件原基线
  **0.2.0**（如桌面端 `0.2.0-rc.2`）。
- 兼容区间由 `package.json` 的 `engines.dsh`（`>=0.2.0-rc.2 <0.3.0`）声明 —— DSH 0.2.1 起
  插件版本兼容性以该字段优先判定（`docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh`）。
- 插件 API 面（工具注册 / 设置域 `configForms` / 客户端模块协议 / `dsh.bundle.patch` 组合注入）
  在 0.2.1 保持稳定；0.2.1 的差异集中在数据语义（凭据优先级、模型目录）与命令服务（复数
  `commands` 服务，此前用的单数 `command` 服务不存在），本插件已逐条对齐 —— 详见
  `CHANGELOG.md` 的 Unreleased 小节。

## 许可与上游归属

本仓库以 **Apache-2.0** 发布（完整文本见 `LICENSE`）。

评审引擎是对 **open-code-review** 的 fork 改造，按 Apache-2.0 §4 履行归属与
修改声明义务：

- 上游项目：[alibaba/open-code-review](https://github.com/alibaba/open-code-review)
- 上游版权：Copyright 2026 alibaba/open-code-review Contributors
- 上游许可：Apache License 2.0（完整文本见 `engine/LICENSE`）
- fork 说明、构建方法与版本口径见 `engine/FORK_NOTES.md`（`engine/README.md` 同目录，含上游改造点清单）
- 修改声明：本仓库对引擎源码（`engine/`）做了 fork 改造（Windows 子进程隐藏窗口、
  跨平台进程树终止、敏感内容排除、R1–R8 评审整改等）；引擎每个源文件头保留
  上游 `SPDX-License-Identifier: Apache-2.0` 与版权声明。
- 引擎内嵌图标的上游归属声明保留于 `engine/internal/viewer/static/icons/NOTICE`。

完整第三方归属声明见根目录 [`NOTICE`](./NOTICE)。
