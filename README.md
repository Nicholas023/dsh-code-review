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

- 默认**沿用会话模型**（DSH 默认 DeepSeek-V41-Flash，账号体系认证，无需 API Key）；
- 设置面板「智能代码审查」分区可**另选**评审模型（选项动态读取 DSH 模型配置，
  其他模型需先在 DSH 侧配置好）。

## 敏感文件点名

引擎内置敏感路径保护会**静默排除**敏感文件（内容不送审，防二次泄露）；
插件层额外自检待提交清单，命中敏感模式（`.env`、私钥、`credentials*`、token 等）的
每个文件**点名列入报告**（类型=敏感文件），提示人工确认是否该提交——不许静默。

## 安装（热装，免重启）

1. 把本包目录 junction 进 profile 的 node_modules（或以 npm 方式安装依赖）：
   ```powershell
   node scripts/link-deps.mjs        # 开发期：连接本机 schema 依赖
   npm install                       # 发布安装：正式依赖
   ```
2. 经 DSH 插件管理页把本包加入 profile（读取 `cordis.patch.yml` 注入组合树），
   或手工在 profile 的 `cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-code-review
         name: 'dsh-code-review'
   ```
3. 引擎 codecheck：把编译产物放到插件包 `bin/codecheck(.exe)`，或在设置面板
   指定 `engine_bin` 绝对路径。

## 开发

```powershell
node scripts/link-deps.mjs           # 连接开发期依赖（junction，幂等）
npm run check                        # 全部 js 语法检查
npm run smoke                        # Cordis 入口冒烟自检（挂载前提验证）
```

## 许可

Apache-2.0。引擎继承上游 open-code-review（Apache-2.0）的归属声明。
