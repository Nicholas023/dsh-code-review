// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * schema.ts —— 设置字段描述（照搬 dsh-ops 的第一层）。
 *
 * 设计要点（来自 dsh-ops 的实践）：
 *  - 字段用**纯数据**描述（type + meta.volatile + description），
 *    宿主据此决定哪些字段可编辑、渲染成什么控件；
 *  - 同时提供 Standard Schema 的 validate（`~standard`），
 *    宿主用同一份描述做「渲染」和「校验」，不会出现两套规则；
 *  - meta.volatile = true 表示该字段可热更新。
 *
 * 为什么不直接用 schemastery：ds-ops 的经验是宿主会剥掉 volatile
 * 元数据做校验副本，用自定义描述树能保证「描述」和「校验」永远一致。
 */

import { normalizeConfig } from '../config/schema.js'
import type { ConfigV2 } from '../config/defaults.js'

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
  /** 数组/对象的子结构。 */
  readonly inner?: Field
  readonly dict?: Readonly<Record<string, Field>>
}

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

/** 字段集合。 */
export type FieldDict = Readonly<Record<string, Field>>

/**
 * 组装成宿主可直接消费的配置描述。
 * @param normalize 归一化函数（与运行时用的是同一个）
 * @param fields    字段描述
 */
export function settingsConfig(normalize: (value: unknown) => unknown, fields: FieldDict) {
  return {
    type: 'object' as const,
    meta: { volatile: false, description: '智能代码审查配置' },
    dict: fields,
    '~standard': {
      version: 1 as const,
      vendor: 'dsh-code-review',
      validate(value: unknown): { value: unknown } | { issues: { message: string }[] } {
        try {
          return { value: normalize(value) }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
  }
}

/** 把任意输入收敛成对象（供 validate 使用）。 */
export function configObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('配置必须是对象')
  }
  return value as Record<string, unknown>
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
      credentialRef: editable('string', '凭据引用名（指向已配置的环境变量，不填明文 key）。'),
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
      maxCostCny: editable('number', '单任务费用上限（元）。', { minimum: 0, maximum: 100000 }),
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

/** 完整设置描述（宿主注册用）。 */
export const Config = settingsConfig((value) => normalizeConfig(configObject(value)).config, CONFIG_FIELDS)

/** 供测试引用的配置类型。 */
export type { ConfigV2 }
