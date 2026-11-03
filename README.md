# dsh-code-review

智能代码审查插件 —— 接入 [DeepSeek Harness](https://www.deepseek.com/en/harness/)，
对仓库改动执行三个固定视角的评审：**安全与脱敏**、**找 bug**、**冗余与无关代码**。

> 0.2.0 是重写版本：不再依赖 Go 引擎与外部二进制，改为自研 Node/TypeScript 内核。
> 升级前的实现归档在 `archive/0.1.3-go-engine` 标签。

---

## 它怎么工作

```
DSH 插件（薄壳）
  ├─ code_review 工具 / /review 命令   → 写任务卡、拉起内核
  ├─ code_review_status 工具           → 读任务卡、呈现结果
  └─ 设置面板                          → 配置（端点在面板里填）
           │
           │ 任务簿（一任务一 JSON，原子写）
           ▼
自研内核（独立 Node 进程，单例）
  ├─ git 取 diff / 筛文件
  ├─ 规模分档 → 主 agent + 子 agent
  ├─ PTC：模型写程序调用只读工具
  └─ Markdown + JSON 双报告
           │
           ▼
run_code 子进程（模型代码在这里跑）
  ├─ sdk.read / sdk.glob / sdk.grep（只读）
  ├─ 路径围栏 + 结果预算
  └─ 硬超时 + 内存上限
```

### 三个关键设计

**1. 进程外，不受会话约束。** 评审在独立进程里跑，DSH 会话关闭、插件重载都不影响它；
任务卡是唯一的共享状态，插件崩了内核也还在跑。

**2. PTC 模式省 token。** 模型不逐个调工具，而是写一段程序在沙箱里执行，
工具结果不进模型上下文，只有程序返回值回来。对比传统多轮工具调用，
上下文开销从「每轮重发历史」变成「一次往返」。
```bash
npm run bench   # 本地估算两种模式的量级差异
```

**3. 评审绝不改代码。** 内核只暴露 read / glob / grep 三个只读工具，
没有写、没有 shell；代码在独立子进程执行，死循环会被硬超时杀掉。

---

## 安装

```bash
npm install
npm run build
```

然后在 DSH 中启用插件（`package.json` 的 `main` 指向 `dist/plugin/index.js`）。

## 配置

配置文件：`~/.dsh/dsh-code-review/config.json`（首次启动自动迁移 0.1.x 的 `plugin-config.json`）。

**端点与凭据必须在设置里显式填写**：

| 字段 | 说明 |
|---|---|
| `review.endpoint` | 模型端点，如 `https://api.deepseek.com` |
| `review.model` | 模型标识，如 `deepseek-flash` |
| `review.credentialRef` | **凭据引用名**（环境变量名），不填明文 key |

> 红线：端点或凭据缺失时，评审会在**发出任何请求之前**失败并提示去配置，
> 绝不隐式调用任何默认端点。

## 使用

在会话里：

```
用 code_review 审查 D:/projects/my-repo 的未提交改动
```

或用斜杠命令 `/review`。发起后立即返回任务 id，用 `code_review_status` 查进度。

报告落在 `~/dsh-code-review-reports/<仓库名>/`，同时产出 `.md` 与 `.json`。

## 安全边界

| 项 | 约束 |
|---|---|
| 写操作 | 内核无写工具，模型无法修改仓库 |
| 路径逃逸 | 拒绝绝对路径、`..`、符号链接逃逸；只放行仓库内普通文件 |
| 敏感文件 | 内容不送审，但在报告里**逐一点名**（不允许静默排除） |
| 报告脱敏 | 报告写入前统一脱敏，密钥/Bearer/连接串密码替换为 `[REDACTED]` |
| 凭据 | 只存引用名，明文 key 只在内存中用于请求 |
| 执行隔离 | 模型代码在独立子进程，硬超时 + 内存上限，崩溃不影响内核 |

## 开发

```bash
npm run typecheck   # 类型检查
npm run test        # 331 个测试
npm run build       # 构建到 dist/
npm run bench       # token 基准（不联网）
```

## 许可证

Apache-2.0。规则文本参考了 alibaba/open-code-review 的设计思路（见 `NOTICE`），
但 0.2.0 的实现与那套代码无关。
