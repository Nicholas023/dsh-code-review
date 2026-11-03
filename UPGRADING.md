# 从 0.1.x 升级到 0.2.0

0.2.0 是重写版本。**配置会自动迁移，但有两处行为变了，需要你确认。**

---

## 升级后会自动发生什么

1. **配置迁移**：首次读取配置时，插件检测到 `~/.dsh/dsh-code-review/plugin-config.json`（0.1.x 格式）
   且 `config.json`（0.2.0 格式）不存在，会自动迁移并写备份。
2. **旧字段搬运**：`review_model` → `review.model`、`report_dir` → `report.directory`、
   `review_timeout_ms` → `review.taskTimeoutMs`、`first_run` → `onboarding.firstRunCompleted`（语义反转）。
3. **未知字段保留**：你在旧配置里手加的任何字段都会原样带到新文件。

迁移**不会**做的事：不会删除旧文件（保留到下个版本）、不会覆盖已存在的 `config.json`。

---

## 两处行为变化（需要你处理）

### ① `engine_bin` 被删除

0.2.0 不再使用外部引擎二进制，评审由内置 Node 内核完成。

- 迁移时该字段被移除，并记录在迁移结果的 `removedFields` 里；
- 如果你曾依赖「换一个引擎二进制」来切换行为，现在没有这条路径了；
- 仓库里的 `bin/codecheck.exe` 可以删掉。

### ② `concurrency` 的语义变了

| | 0.1.x | 0.2.0 |
|---|---|---|
| 含义 | 引擎**内部**并行审查的会话数 | **同时运行的评审任务数** |
| 生效前提 | `concurrency_enabled` | 同左 |

数值被保留，但如果你原来设的是 8，现在意味着「最多同时跑 8 个评审任务」，
而不是「一个任务内部开 8 路」。**建议先设小（1~2）观察一次真实开销再调大。**

---

## 必须重新配置的一项

0.1.x 的评审模型端点由宿主路由注入，配置文件里没有端点。

0.2.0 **要求你显式填写**：

```jsonc
{
  "review": {
    "endpoint": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "credentialRef": "DEEPSEEK_API_KEY"   // 环境变量名，不是 key 本身
  }
}
```

或者用会话工具：

```
code_review_set_config({ patch: {
  "review.endpoint": "https://api.deepseek.com",
  "review.model": "deepseek-flash",
  "review.credentialRef": "DEEPSEEK_API_KEY"
}})
```

> 这是刻意的：**没有端点或凭据时，评审在发出任何请求之前就失败并提示你去配置**。
> 这样就不会再出现「不知道为什么扣了钱」的情况。

---

## 任务与报告的兼容性

| 对象 | 0.2.0 的行为 |
|---|---|
| 0.1.x 已完成的任务卡 | 仍可查询状态；`summary` 字段为空（旧格式没有） |
| 0.1.x 运行中的任务 | 升级时内核已不在，标记为中断；可以重新发起 |
| 0.1.x 的 Markdown 报告 | 原样保留，不做改写 |
| 0.2.0 的 JSON 报告 | 从 `schemaVersion: 1` 开始，字段只增不改 |

---

## 回退到 0.1.3

```bash
git checkout archive/0.1.3-go-engine
```

该标签保留了完整的 Go 引擎与旧插件外壳。

回退后注意：
- 0.2.0 写过的 `config.json` **不会**被 0.1.3 读取（它读 `plugin-config.json`）；
- 如果需要回到旧配置，用迁移时生成的备份文件 `plugin-config.json.bak.<时间戳>`。

---

## 已知限制（0.2.0 首发）

1. **没有图形设置面板**。用 `code_review_set_config` 工具或直接编辑 `config.json`。
   字段说明见 `src/settings/schema.ts` 的 `CONFIG_FIELDS`。
2. **token 基准只有估算**。`npm run bench` 给出的是量级（不联网）；
   真实数字需要配 `BENCH_*` 环境变量跑 `--real`。
3. **没有实机验收记录**。代码层面 373 个测试全绿，但「装进 DSH 跑通一次真实评审」
   需要你在自己的环境里确认。
