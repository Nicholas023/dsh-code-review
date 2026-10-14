# GitHub Actions 工作流（规划中）

骨架阶段不放置空 workflow 文件（避免 GitHub 拉取后直接报失败告警）。
代码落地后按以下规划在此逐项落文件：

| 文件 | 计划内容 |
|---|---|
| `lint.yml` | src（eslint/prettier）+ engine（golangci-lint） |
| `test.yml` | 单元测试（插件 + 引擎） |
| `build.yml` | 编译验证：`node` 构建 + `go build`（Windows 单文件二进制） |
| `secret-scan.yml` | 零敏感自检：扫描仓库自身是否存在硬编码密钥 / 凭据 / 内部服务地址痕迹 |

> 红线提醒：工作流文件同样遵守零敏感原则，不得写入任何平台 key / 。
