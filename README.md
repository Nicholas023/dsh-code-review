# dsh-code-review · 智能代码审查插件

> 把阿里开源 AI 代码评审工具 **open-code-review**（Go CLI）改造为 DSH 插件：用户写完代码说一声，插件调用改后的引擎 **codecheck**，用模型从 **安全脱敏 / 找 bug / 冗余与无关代码** 三个通用角度挑刺，返回问题清单 + 落一份评审报告留档。

**项目定位 = 通用代码审查工具**——对任何代码库做常规质量与安全评审；「发 GitHub 前防开盒」是安全维度下的典型使用场景，不是产品定位。

## 状态

| 项 | 状态 |
|---|---|
| 仓库骨架 | ✅ 已初始化（本提交） |
| 引擎 codecheck（fork 改造） | 🚧 规划中 |
| DSH 插件 dsh-code-review | 🚧 规划中 |

开发依据：`-代码审查插件开发.md`（设计定稿 18 项，已拍板）。

## 交付物（两层）

1. **内核引擎 `codecheck`**：open-code-review 的 fork 改造版，编译为 Windows 单文件二进制，随插件分发。
2. **DSH 插件 `dsh-code-review`**：Cordis 原生插件（`src/` + `cordis.patch.yml` + `package.json` 的 dsh 字段），是引擎的「管家」。

## 仓库结构

```
dsh-code-review/
├── src/            # DSH 插件源码（Cordis 原生插件）—— 规划中
├── engine/         # codecheck 引擎（Go，fork 自 open-code-review）—— 规划中
├── docs/           # 设计 / 技术文档（含 ADR）
├── .github/        # GitHub 协作配置（PR 模板 / workflows）
├── scripts/        # 开发辅助脚本 —— 规划中
├── -代码审查插件开发.md   # 项目（自包含，开工依据）
├── AGENTS.md       # 项目词汇表
├── CONTRIBUTING.md # 仓库协作规范（分支 / 提交 / 标签 / 红线）
├── SECURITY.md     # 安全漏洞报告约定
└── CHANGELOG.md    # 变更记录
```

## 快速开始（骨架阶段占位）

引擎与插件尚未落地，暂无可执行命令。后续按第五、六节实施步骤推进。

## 许可证

[Apache-2.0](LICENSE)（引擎 fork 自 open-code-review，沿用上游同款许可；插件一并采用）。
