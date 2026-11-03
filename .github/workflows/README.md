# GitHub Actions 工作流

0.2.0 起只有两个工作流，都在 `ci.yml` 里：

| Job | 内容 |
|---|---|
| `verify`（ubuntu + windows） | 类型检查 → 测试（331 个，含端到端与安全回归）→ 构建 → 入口可加载断言 → token 基准（估算模式） |
| `secret-scan` | 确保没有被跟踪的凭据文件（`.env`、私钥、`.pem` 等） |

## 红线

- 任何需要**真实凭据或联网**的验证都不进 CI。
- 需要真实端点的对比实验走 `scripts/benchmark-tokens.mjs --real`，由人工在本地执行。
- 工作流文件本身也遵守零敏感原则：不写入任何平台的 key、端点或内部地址。

## 为什么没有 lint 工作流

0.1.x 的 lint 依赖引擎侧的 golangci-lint；引擎已随 0.2.0 退役。
TypeScript 侧目前以 `tsc --noEmit`（strict 全开）作为主要静态门禁，
引入额外 lint 规则前先确认它真的能拦住一类问题，而不是制造格式噪声。
