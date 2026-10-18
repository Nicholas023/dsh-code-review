// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * settings-schema.js —— dsh-code-review「智能代码审查」设置命名空间的 schemastery 定义。
 *
 * 用途：宿主 ctx.settings 引用本 schema 渲染 DSH Web 设置页分区，字段以宿主
 * settings.yaml 持久化、运行时热生效（工具执行时经 getRuntimeConfig 惰性读取，
 * 优先级：工具参数 > 设置页 > 默认值）。
 *
 * 关键设计——评审模型选择器「动态来自 DSH 模型配置」：
 *   - schema 用工厂函数 createSettingsSchema(models) 构造，models 为
 *     [{ value, label }]（来自步骤 1 探明的 DSH 模型取数口：ctx.llm 的
 *     listProviders/discoverModels/resolveModelInfo）；
 *   - 选项永不硬编码平台清单：模型列表由 index.js 在 apply 时尽力读取；
 *     读不到（宿主能力差异/网络未就绪）时 schema 只含默认项 "session"，
 *     并在 description 说明「选项取决于 DSH 模型配置」；
 *   - 默认项 "session" 恒存在 = 沿用会话模型（首选，同构评审）。
 *
 * 零敏感：无任何平台内部标识；模型标签一律取自 DSH 配置文本本身。
 */
import z from '@deepseek-ai/schemastery';
// SETTINGS_NS / 默认值 / 并发取值域统一从 config.js 取单一来源
// （此前 SETTINGS_NS 与本文件各定义一份字面量、默认值各自硬编码，两处漂移会
// 导致命名空间注册/读取错位、默认值不一致）。
// SETTINGS_NS 由文件底部 `export { SETTINGS_NS } from './config.js'`
// 单独 re-export，此处 import 的 SETTINGS_NS 在本文件内无使用（死 import，移除）。
import { DEFAULT_CONFIG, CONCURRENCY_DEFAULT, CONCURRENCY_MIN, CONCURRENCY_MAX } from './config.js';

/** 本插件拥有的设置命名空间名（单一来源：config.js，勿在本文件重复定义）。 */
export { SETTINGS_NS } from './config.js';

/** 沿用会话模型的标识（引擎侧会解析为 DSH 默认模型的 provider 注入）。 */
export const SESSION_MODEL = 'session';

/**
 * 构造设置 schema。
 *
 * @param {Array<{value: string, label: string}>} [models]
 *   可用评审模型选项（动态来自 DSH 模型配置）；缺省为空数组 → 仅默认项。
 * @returns {object} schemastery object schema（z.object 实例）。
 */
export function createSettingsSchema(models = []) {
  // modelOptions 此前构造后从未被引用（models 只在构造
  // 这行用到），DSH 模型候选被完全丢弃。现在真正接入 schema：
  //   - description 动态列出当前可用选项（随 DSH 模型配置变化，设置页可见）；
  //   - 仍保留自由文本输入语义（用户可手输未列出的模型标识），不用 union 硬约束
  //     枚举——选中不可用的模型由运行时按「会话模型 / 首个可用配置」回退
  //     （description 承诺，与 model-provider 回退口径一致）。
  // 删 `.role('select')`——该 role 只声明「应渲染成下拉」
  // 但无机器可读选项列表，宿主收到后无法渲染出实际选项（选项又是动态的，
  // union 枚举不可行），退化为文本输入反而诚实；选项清单由 description 呈现。
  // models 候选里可能本身含 session 项（宿主模型
  // 列表含会话模型时重复）——Set 去重保唯一。
  const modelOptions = [...new Set([SESSION_MODEL, ...models.map((m) => m.value)])];
  // 字段用 z.string().default() 声明默认值（schemastery 兼容
  // 旧注释「schemastery 的 enum 用 z.string().default() +
  // UI select 约束」是误导——select 约束早已删除（无机器可读选项列表，
  // 见下方 review_model 的说明），这行只是普通默认值声明，与 enum 无关。
  const schema = z.object({
    review_model: z
      .string()
      .default(DEFAULT_CONFIG.review_model)
      .description(
        '评审模型：默认「沿用会话模型」（DSH 默认 DeepSeek-V41-Flash，账号体系认证）。' +
          '此项为文本输入，可手输 DSH 中已配置的模型标识（选项动态读取 DSH 模型配置，其他模型需先在 DSH 侧配好）。' +
          `当前可选：${modelOptions.join('、')}。` +
          '选中的模型不可用时，运行时自动改走首个可用配置；若路由表为空（无任何可用配置）则本次评审明确失败并提示配置评审模型，不会静默外呼。'
      ),
    report_dir: z
      .string()
      .default(DEFAULT_CONFIG.report_dir)
      .description(
        '评审报告落盘目录（支持 ~ 展开用户主目录）。每次评审按「日期/仓库」在该目录下建子目录，' +
          '留档作为「发 GitHub 前已审过」的凭证。'
      ),
    engine_bin: z
      .string()
      .default(DEFAULT_CONFIG.engine_bin)
      .description(
        '引擎 codecheck 二进制路径。留空 = 自动查找：插件包内 bin/ 下的 codecheck / codecheck.exe，' +
          '再回退 PATH 中的 codecheck。'
      ),
    first_run: z
      .boolean()
      .default(DEFAULT_CONFIG.first_run)
      .description(
        '首次启动引导标记：首次启用时插件会输出引导消息（确认评审模型沿用、确认报告目录）。' +
          '确认无误后可将此开关关闭以静默。'
      ),
    // 并发评审（开关默认关 = 单线；开 = 并行审查）。
    // ⚠ 开启并发会显著增加 token 消耗——成本由用户自行权衡（控制权交回用户）。
    concurrency_enabled: z
      .boolean()
      .default(DEFAULT_CONFIG.concurrency_enabled)
      .description(
        '并发评审：关闭 = 单线顺序审查（默认，引擎显式单并发）。' +
          '开启 = 并行审查、大幅提速，但 token 消耗随之增加（成本由你控制）。' +
          '开启后在设置面板展开「并发广度」设置项。'
      ),
    // 并发广度：仅 concurrency_enabled=true 时生效；取值域 1..32（config.js 的
    // CONCURRENCY_MIN/MAX 与 normalizeConfig 钳制同一来源，schema 层同步约束，
    // 此前仅 z.number() 无边界，与 description「1–32」自相矛盾）。
    concurrency: z
      .number()
      .default(CONCURRENCY_DEFAULT)
      .min(CONCURRENCY_MIN)
      .max(CONCURRENCY_MAX)
      .description(
        '并发广度：并行审查的会话数（1–32，默认 8）。仅「并发评审」开启时生效；' +
          '值越大审得越快，但 token 消耗与端点限流风险越高。'
      ),
  });
  return schema;
}
// （原 defaultSettingsSchema 导出已删除——全仓库无任何
// 引用，注释声称的「apply 时模型列表读取失败使用」与实际不符；index.js 走的
// 是 createSettingsSchema(candidates)，candidates 为空时自然退化为仅默认项。）
