// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * row-schema.ts —— 设置页的结构描述（照搬 dsh-ops 第三层）。
 *
 * 纯数据，不含任何 UI 逻辑。每个控件用**路径**寻址（[section, key]），
 * 所以「读当前值」「写回」都只需要一条路径，不需要为每个字段写专属代码。
 *
 * 支持 gatedBy：被门控的字段在父开关关闭时置灰但不丢值 ——
 * 用户重新打开时原来的选择还在。
 */

/** 一个可编辑控件。 */
export interface FieldSpec {
  /** 字段路径（section.key）。 */
  readonly path: readonly [string, string]
  /** 显示名。 */
  readonly label: string
  /** 说明文字。 */
  readonly hint: string
  /** 数值范围（type=number 时生效）。 */
  readonly min?: number
  readonly max?: number
  /** 枚举选项（type=string 且需要下拉时）。 */
  readonly options?: readonly string[]
  /** 被哪个开关门控（该开关为 false 时置灰）。 */
  readonly gatedBy?: readonly [string, string]
}

/** 一个分组。 */
export interface GroupSpec {
  readonly id: string
  readonly label: string
  readonly hint: string
  /** 分组自带总开关时给出其路径。 */
  readonly togglePath?: readonly [string, string]
  readonly fields: readonly FieldSpec[]
}

/** 从配置对象里按路径取值。 */
export function readPath(config: Record<string, unknown>, path: readonly [string, string]): unknown {
  const section = config[path[0]]
  if (typeof section !== 'object' || section === null) return undefined
  return (section as Record<string, unknown>)[path[1]]
}

/** 生成一个只改指定路径的 patch（写回时用，避免全量覆盖丢掉未知字段）。 */
export function patchFor(path: readonly [string, string], value: unknown): Record<string, unknown> {
  return { [path[0]]: { [path[1]]: value } }
}

/** 判断某字段当前是否可用（门控开关是否为真）。 */
export function isEnabled(config: Record<string, unknown>, field: FieldSpec): boolean {
  if (field.gatedBy === undefined) return true
  return readPath(config, field.gatedBy) === true
}

/** 全部页面分组（顺序即渲染顺序）。 */
export const GROUPS: readonly GroupSpec[] = [
  {
    id: 'review',
    label: '评审模型',
    hint: '不填端点与凭据时，评审会在发起前直接失败 —— 这是刻意设计，不会隐式调用任何默认端点。',
    fields: [
      { path: ['review', 'endpoint'], label: '端点', hint: '如 https://api.deepseek.com' },
      { path: ['review', 'model'], label: '模型', hint: '如 deepseek-flash' },
      { path: ['review', 'credentialRef'], label: '凭据引用', hint: '环境变量名，填写明文 key 无效' },
      { path: ['review', 'requestTimeoutMs'], label: '单请求超时（毫秒）', hint: '防端点悬挂；不影响任务总时长', min: 1000, max: 3600000 },
      { path: ['review', 'taskTimeoutMs'], label: '任务超时（毫秒）', hint: '只防死循环，正常评审不会因此截断', min: 1000, max: 21600000 },
    ],
  },
  {
    id: 'execution',
    label: '执行',
    hint: '并发指同时跑几个评审任务；单任务内部的子 agent 并发另有上限。',
    togglePath: ['execution', 'concurrencyEnabled'],
    fields: [
      { path: ['execution', 'concurrency'], label: '并行任务数', hint: '1 表示串行', min: 1, max: 32, gatedBy: ['execution', 'concurrencyEnabled'] },
      { path: ['execution', 'runnerTimeoutMs'], label: '代码执行超时（毫秒）', hint: '单次 run_code 的硬上限', min: 1000, max: 600000 },
      { path: ['execution', 'runnerMemoryMb'], label: '代码执行内存（MB）', hint: '超限会杀掉执行进程，不影响内核', min: 64, max: 4096 },
    ],
  },
  {
    id: 'budget',
    label: '预算',
    hint: '全部填 0 表示不限制。限额是为了防意外，不是为了限制正常使用。',
    fields: [
      { path: ['budget', 'maxInputTokens'], label: '输入 token 上限', hint: '0 = 不限', min: 0, max: 100000000 },
      { path: ['budget', 'maxOutputTokens'], label: '输出 token 上限', hint: '0 = 不限', min: 0, max: 10000000 },
      { path: ['budget', 'maxCost'], label: '费用上限', hint: '0 = 不限；填了单价才生效', min: 0, max: 100000 },
      { path: ['budget', 'inputPricePerMTok'], label: '输入单价（每百万）', hint: '三项全 0 = 不计费', min: 0, max: 1000000 },
      { path: ['budget', 'outputPricePerMTok'], label: '输出单价（每百万）', hint: '每百万 token', min: 0, max: 1000000 },
      { path: ['budget', 'cacheReadPricePerMTok'], label: '缓存命中单价（每百万）', hint: '留 0 按输入单价计', min: 0, max: 1000000 },
      { path: ['budget', 'maxAgentRounds'], label: '主 agent 轮次', hint: '越大越可能发现问题，也越贵', min: 1, max: 50 },
      { path: ['budget', 'maxChildren'], label: '子 agent 数量上限', hint: '0 表示不派子 agent', min: 0, max: 64 },
    ],
  },
  {
    id: 'sizing',
    label: '规模阈值',
    hint: '决定「主 agent 自己看多深、什么时候派子 agent」。默认值来自设计定稿。',
    fields: [
      { path: ['sizing', 'smallTokens'], label: '小档上界（tokens）', hint: '低于此值：主 agent 全看，不派子 agent' },
      { path: ['sizing', 'largeTokens'], label: '大档下界（tokens）', hint: '高于此值：主 agent 只看结构' },
      { path: ['sizing', 'fileLinesForChild'], label: '单文件行数阈值', hint: '改动超过此值必须派子 agent' },
      { path: ['sizing', 'fileTokensForChild'], label: '单文件 token 阈值', hint: 'diff 超过此值必须派子 agent' },
      { path: ['sizing', 'childTokensMax'], label: '子任务 token 上限', hint: '超过则继续切分' },
    ],
  },
  {
    id: 'report',
    label: '报告',
    hint: '报告目录必须在用户主目录之下（防止被配置导向任意位置）。',
    fields: [
      { path: ['report', 'directory'], label: '报告目录', hint: '支持 ~ 前缀' },
      { path: ['report', 'writeMarkdown'], label: '输出 Markdown', hint: '给人读' },
      { path: ['report', 'writeJson'], label: '输出 JSON', hint: '给工具读' },
    ],
  },
]

/**
 * 把当前配置投影成页面值（供宿主渲染控件）。
 * @returns 每组的字段当前值与可用性
 */
export function projectGroups(config: Record<string, unknown>): ReadonlyArray<{
  readonly group: GroupSpec
  readonly enabled: boolean
  readonly values: ReadonlyArray<{ readonly field: FieldSpec; readonly value: unknown; readonly enabled: boolean }>
}> {
  return GROUPS.map((group) => ({
    group,
    enabled: group.togglePath === undefined ? true : readPath(config, group.togglePath) === true,
    values: group.fields.map((field) => ({
      field,
      value: readPath(config, field.path),
      enabled: group.togglePath === undefined || readPath(config, group.togglePath) === true
        ? isEnabled(config, field)
        : false,
    })),
  }))
}
