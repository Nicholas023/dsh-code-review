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

/** 本插件拥有的设置命名空间名（与 config.js 的 SETTINGS_NS 保持一致）。 */
export const SETTINGS_NS = 'dsh-code-review';

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
  const modelOptions = [SESSION_MODEL, ...models.map((m) => m.value)];
  // schemastery 的 enum 用 z.string().default() + UI select 约束。
  const schema = z.object({
    review_model: z
      .string()
      .default(SESSION_MODEL)
      .description(
        '评审模型：默认「沿用会话模型」（DSH 默认 DeepSeek-V41-Flash，账号体系认证）。' +
          '可手动另选 DSH 中已配置的其他模型（选项动态读取 DSH 模型配置，其他模型需先在 DSH 侧配好）。' +
          '选中的模型不可用时，运行时自动按「沿用会话模型」处理。'
      ),
    report_dir: z
      .string()
      .default('~/dsh-code-review-reports')
      .description(
        '评审报告落盘目录（支持 ~ 展开用户主目录）。每次评审按「日期/仓库」在该目录下建子目录，' +
          '留档作为「发 GitHub 前已审过」的凭证。'
      ),
    engine_bin: z
      .string()
      .default('')
      .description(
        '引擎 codecheck 二进制路径。留空 = 自动查找：插件包内 bin/ 下的 codecheck / codecheck.exe，' +
          '再回退 PATH 中的 codecheck。'
      ),
    first_run: z
      .boolean()
      .default(true)
      .description(
        '首次启动引导标记：首次启用时插件会输出引导消息（确认评审模型沿用、确认报告目录）。' +
          '确认无误后可将此开关关闭以静默。'
      ),
  });
  return schema;
}

/** 便捷默认 schema（apply 时若模型列表读取失败使用）。 */
export const defaultSettingsSchema = createSettingsSchema();
