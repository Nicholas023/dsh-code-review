// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * fields.ts —— 配置字段描述（纯数据，零依赖）。
 *
 * 为什么单独成一个文件：这份描述**宿主端和浏览器端都要用**。
 *  - 宿主端（settings/schema.ts）用它生成 Standard Schema 校验；
 *  - 浏览器端（client/page.tsx）用它渲染控件。
 * 如果它 import 了任何 node 模块或服务端逻辑，客户端就打不进 bundle。
 * 所以这里只允许有类型和字面量。
 */

/** 字段类型。 */
export type FieldType = 'string' | 'boolean' | 'number' | 'array' | 'object'

/** 字段描述。 */
export interface Field {
  readonly type: FieldType
  readonly meta?: {
    /** 是否可热更新（宿主据此判定可编辑）。 */
    readonly volatile?: boolean
    /** 面板上显示的说明。 */
    readonly description?: string
    /** 数值范围（供控件做钳制）。 */
    readonly minimum?: number
    readonly maximum?: number
    /** 枚举值（供下拉框）。 */
    readonly enum?: readonly string[]
  }
  readonly inner?: Field
  readonly dict?: Readonly<Record<string, Field>>
}

/** 字段集合。 */
export type FieldDict = Readonly<Record<string, Field>>

/** 标一个可编辑字段。 */
export function editable(
  type: FieldType,
  description: string,
  extra: Partial<NonNullable<Field['meta']>> = {},
): Field {
  return { type, meta: { volatile: true, description, ...extra } }
}

/** 只读展示字段（不可编辑，但出现在面板里）。 */
export function readonlyField(type: FieldType, description: string): Field {
  return { type, meta: { volatile: false, description } }
}

/**
 * 0.2.0 的字段描述（分区结构）。
 *
 * 顺序即面板顺序：先模型（不填就没法跑），再规模与预算（决定花多少钱），
 * 最后报告与引导。
 */
export const CONFIG_FIELDS: FieldDict = {
  review: {
    type: 'object',
    meta: { volatile: false, description: '评审模型' },
    dict: {
      endpoint: editable('string', '模型端点（如 https://api.deepseek.com）。留空则评审直接失败，不会隐式兜底。'),
      model: editable('string', '模型标识（如 deepseek-flash）。'),
      protocol: editable('string', '协议（当前仅 openai-chat-completions）。', { enum: ['openai-chat-completions'] }),
      credentialRef: editable('string', '凭据引用名：DSH 凭据库里的名字或同名环境变量（如 COMMANDCODE_API_KEY）。只能字母数字下划线，不能有短横线；填名字，不要填明文 key。'),
      requestTimeoutMs: editable('number', '单次请求超时（毫秒）。', { minimum: 1000, maximum: 3600000 }),
      taskTimeoutMs: editable('number', '任务总超时（毫秒），只防死循环。', { minimum: 1000, maximum: 21600000 }),
    },
  },
  execution: {
    type: 'object',
    meta: { volatile: false, description: '执行' },
    dict: {
      concurrencyEnabled: editable('boolean', '允许并行执行多个评审任务。'),
      concurrency: editable('number', '并行任务数（语义：同时运行的评审任务）。', { minimum: 1, maximum: 32 }),
      runnerTimeoutMs: editable('number', '单次代码执行超时（毫秒）。', { minimum: 1000, maximum: 600000 }),
      runnerMemoryMb: editable('number', '代码执行内存上限（MB）。', { minimum: 64, maximum: 4096 }),
    },
  },
  budget: {
    type: 'object',
    meta: { volatile: false, description: '预算（0 表示不限）' },
    dict: {
      maxInputTokens: editable('number', '单任务输入 token 上限。', { minimum: 0, maximum: 100000000 }),
      maxOutputTokens: editable('number', '单任务输出 token 上限。', { minimum: 0, maximum: 10000000 }),
      maxCost: editable('number', '单任务费用上限（单位见「费用单位」）。0 表示不限；只有填了单价才生效。注意：上限在每次模型调用前检查，单次调用的费用无法预知，因此可能超出上限最多一次调用的开销（超支会在报告里点名）。', { minimum: 0, maximum: 100000 }),
      currency: editable('string', '费用单位。只影响显示与语义，不做汇率换算（按你要用的货币把单价换算好再填）。', { enum: ['CNY', 'USD'] }),
      inputPricePerMTok: editable('number', '输入 token 单价（每百万）。三项单价全为 0 = 不计费：不统计金额，也不因费用中断评审。', { minimum: 0, maximum: 1000000 }),
      outputPricePerMTok: editable('number', '输出 token 单价（每百万）。', { minimum: 0, maximum: 1000000 }),
      cacheReadPricePerMTok: editable('number', '缓存命中 token 单价（每百万）。留 0 时按输入单价计。', { minimum: 0, maximum: 1000000 }),
      maxAgentRounds: editable('number', '主 agent 最大轮次。', { minimum: 1, maximum: 50 }),
      maxChildren: editable('number', '最多派多少子 agent。', { minimum: 0, maximum: 64 }),
    },
  },
  report: {
    type: 'object',
    meta: { volatile: false, description: '报告' },
    dict: {
      directory: editable('string', '报告目录（支持 ~，且必须位于用户主目录之下）。'),
      writeMarkdown: editable('boolean', '输出 Markdown 报告。'),
      writeJson: editable('boolean', '输出机器可读 JSON 报告。'),
    },
  },
  sizing: {
    type: 'object',
    meta: { volatile: false, description: '规模阈值' },
    dict: {
      smallTokens: editable('number', '小档上界：低于此值主 agent 全看、不派子 agent。'),
      largeTokens: editable('number', '大档下界：高于此值主 agent 只看结构。'),
      fileLinesForChild: editable('number', '单文件改动超过此值必须派子 agent。'),
      fileTokensForChild: editable('number', '单文件 diff 超过此 token 数必须派子 agent。'),
      childTokensMax: editable('number', '单个子任务超过此值继续切分。'),
    },
  },
  onboarding: {
    type: 'object',
    meta: { volatile: false, description: '引导' },
    dict: {
      firstRunCompleted: readonlyField('boolean', '是否已完成首次配置引导。'),
    },
  },
}
