/**
 * plugin-config.js —— 宿主设置页可编辑的插件配置 schema（DSH 0.2.0 设置机制）
 *
 * DSH 0.2.0 起设置页展示「profile 条目中可编辑字段」的投影：客户端用
 * `ctx.configForms.get(<包名>)` 读写插件配置（旧 settingsScope API 已换代，
 * 宿主 describe 行的 `schema` 来自插件导出的 `Config`
 * （`entry.fiber.runtime.Config`），据此投影出可编辑表单；用户保存后写入
 * profile 的 Cordis patch 并回传到 `apply(ctx, config)`。
 *
 *  - 每个字段标 `.volatile()`（可在 Web 端热改，保存即回传 apply）；
 *  - **不设默认值**（关键）：未填写时解析为 undefined，运行时经
 *    config.js 的 normalizeConfig 兜底内置默认——设置页是「覆盖层」，
 *    不是唯一真源；
 *  - 字段命名一律 snake_case（与 settings-schema.js 及 DEFAULT_CONFIG
 *    键名一致，可并入同一套归一化流程）；
 *  - schemastery 由宿主提供（import z from '@deepseek-ai/schemastery'）。
 *
 * 字段说明（description 供 0.2.0 自动生成「设置」页分区时作中文标签；
 * 插件页卡片内表单的标签在 client.js 本地声明）：
 *  - review_model：评审模型，留空/`session` = 沿用会话模型（默认）；其他值 =
 *    手动另选的模型标识（异构评审）。0.2.0 静态 schema 不做动态枚举，
 *    选项跟随 DSH 模型配置的能力由服务端 settings 命名空间保留（见
 *    settings-schema.js，两者键一致）。
 *  - report_dir：评审报告目录（支持 `~`），默认 ~/dsh-code-review-reports。
 *  - engine_bin：引擎 codecheck 二进制路径；留空 = 插件包 bin/ 内
 *    或 PATH 中 codecheck。
 *  - first_run：首启引导标记（默认 true = 尚未引导确认）。
 *  - concurrency_enabled：并发评审开关（默认 false = 单线； 加）。
 *  - concurrency：并发广度（默认 8，合法域 1..32；仅开关开启时生效）。
 *
 * 零敏感：不硬编码任何平台内部标识；描述文案不点名任何供应商。
 *
 * @module dsh-code-review/plugin-config
 */
import z from '@deepseek-ai/schemastery';
import { CONCURRENCY_MIN, CONCURRENCY_MAX } from './config.js';

/** 宿主设置页可编辑的插件配置 schema（0.2.0 configForms 表单字段真源）。 */
export const Config = z.object({
  // 评审模型：'' / 'session' = 沿用会话模型；其他值 = 显式另选的模型标识。
  review_model: z.string().description('评审模型（留空或 session = 沿用会话模型）').volatile(),
  // 报告目录：支持 ~ 展开；空 = 默认 ~/dsh-code-review-reports。
  // （路径类字段为自由格式字符串且「空 = 回退默认」是有意
  // 语义，故不加 schema 层非空约束；下游校验点 = config.js normalizeConfig
  // 的 trim + 空值回退默认。schema 层不拦内嵌
  // NUL/换行的极端非法值——此类值会在落盘/建目录时由 writeFile/mkdir 显式
  // 报错，属配置层防御边界，不在表单层拦截。）
  report_dir: z.string().description('评审报告目录（支持 ~，默认 ~/dsh-code-review-reports）').volatile(),
  // 引擎路径：留空 = 插件包 bin/ 或 PATH 中的 codecheck；写入值经
  // set-config-tool 的存在性校验（见 src/set-config-tool.js execute）。
  engine_bin: z.string().description('引擎 codecheck 二进制路径（留空自动探测）').volatile(),
  // 首启引导标记。
  first_run: z.boolean().description('首次运行引导').volatile(),
  // 并发评审开关：默认关 = 单线；开 = 并行（token 消耗增加，用户侧成本控制）。
  concurrency_enabled: z.boolean().description('并发评审（默认关 = 单线；开启 = 并行审查，token 消耗增加）').volatile(),
  // 并发广度：仅开关开启时生效；引擎 --concurrency 取值 1..32（默认 8）。
  // schema 层补 min/max（与 config.js CONCURRENCY_MIN/MAX
  // 及 normalizeConfig 钳制同一来源）——此前无约束 z.number() 与 description
  // 「1–32」不符，宿主表单可接受越界值造成「面板显示值 ≠ 实际使用值」。
  concurrency: z
    .number()
    .min(CONCURRENCY_MIN)
    .max(CONCURRENCY_MAX)
    .description('并发广度（1–32，默认 8；仅开启并发评审后生效）')
    .volatile(),
});
