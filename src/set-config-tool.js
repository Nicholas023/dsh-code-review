/**
 * set-config-tool.js —— 原生工具 code_review_set_config。
 *
 * 作用：会话/AI 程序化读写插件运行配置（评审模型、报告目录、引擎路径等）。
 * 写入目标是插件自有配置文件（~/.dsh/dsh-code-review/plugin-config.json，
 * 见 file-config.js）——这是 0.2.0-rc.2 宿主回传链路失效后插件自己的运行真源，
 * 写入后**下一次评审立即生效**（getConfig 每次调用都重新读文件，无需重启客户端）。
 *
 * 语义：
 *  - 传了哪个字段就写哪个（merge）；传空串 '' 或 null = 清空该字段恢复默认；
 *  - 一个字段都不传 = 只查询当前生效配置；
 *  - 返回值含生效配置全量（含默认值补齐）+ 配置文件路径，供发起方确认。
 *
 * 零敏感：字段值是用户传入的模型标识/路径文本，工具描述不点名任何供应商；
 * 配置文件在用户态 DSH_HOME。
 *
 * @module dsh-code-review/set-config-tool
 */
import { writeFileConfig, PLUGIN_CONFIG_FILE } from './file-config.js';

/** 配置工具名（独立于 code_review / code_review_status 的第三入口）。 */
export const SET_CONFIG_TOOL_NAME = 'code_review_set_config';

/**
 * 创建配置读写工具。
 *
 * @param {object} ctx        Cordis 上下文（仅用于日志）。
 * @param {Function} getConfig 实时配置读取函数（返回归一化后的完整生效配置）。
 * @param {object} [io]       依赖注入（测试用）：writeFileConfig/PLUGIN_CONFIG_FILE。
 * @returns {object} 工具对象（ctx.tools.register 直接消费）。
 */
export function createSetConfigTool(ctx, getConfig, io = {}) {
  const store = io.writeFileConfig || writeFileConfig;
  const configFile = io.PLUGIN_CONFIG_FILE || PLUGIN_CONFIG_FILE;
  const tool = SET_CONFIG_TOOL_NAME;
  return {
    name: tool,
    description: [
      '读写代码审查插件的运行配置（评审模型、报告目录、引擎路径等）。',
      '【写入即生效】本工具把配置写入插件自有配置文件（用户目录下），后续评审任务立即按新值执行——',
      '不需要改客户端设置面板、不需要重启（0.2.0 宿主「面板保存」对第三方插件暂不回传运行层，面板改值会落盘但不到运行时，以本工具为准）。',
      '参数：review_model（评审模型标识：留空/省略 = 沿用会话模型；传其他值 = 显式另选，如 DSH 模型配置里已有的模型名）；',
      'report_dir（评审报告落盘目录，支持 ~；传空串恢复默认 ~/dsh-code-review-reports）；',
      'engine_bin（引擎 codecheck 路径；留空 = 自动探测）。',
      '一个参数都不传 = 只查询当前生效配置（含默认值补齐），返回全量字段。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        review_model: { type: 'string', description: '评审模型标识。省略/空串 = 沿用会话模型；其他值 = 显式另选的模型。' },
        report_dir: { type: 'string', description: '报告目录（支持 ~）。空串恢复默认。' },
        engine_bin: { type: 'string', description: '引擎二进制路径。空串恢复自动探测。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          config_path: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `${tool}：${Object.keys(args ?? {}).length ? '写入配置' : '查询配置'}`,
      kind: 'read',
      locations: [],
    }),
    async execute(args, _exec) {
      const patch = {
        ...(args?.review_model !== undefined ? { review_model: String(args.review_model) } : {}),
        ...(args?.report_dir !== undefined ? { report_dir: String(args.report_dir) } : {}),
        ...(args?.engine_bin !== undefined ? { engine_bin: String(args.engine_bin) } : {}),
      };
      let wrote = false;
      if (Object.keys(patch).length > 0) {
        store(patch); // 同步实现
        wrote = true;
      }
      // 写后重读：getConfig 每次调用都读文件 → 立即包含新值。
      const active = getConfig();
      const lines = [
        `## 代码审查插件配置${wrote ? '（已写入）' : '（当前生效）'}`,
        '',
        `- 配置文件：\`${configFile}\``,
        `- 评审模型：\`${active.review_model}\``,
        `- 报告目录：\`${active.report_dir}\``,
        `- 引擎路径：\`${active.engine_bin || '（自动探测）'}\``,
        '- 提示：面板「设置」里的同名字段在 0.2.0 宿主对第三方插件的回传通道修复前暂不生效，以本工具/本配置文件为准。',
      ];
      return { ok: true, config_path: configFile, text: lines.join('\n') };
    },
  };
}
