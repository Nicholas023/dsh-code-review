// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * defaults.ts —— 0.2.0 配置的默认值唯一真源。
 *
 * 规则：任何模块需要默认值时都从这里取，禁止就地写魔法数字。
 * 设置页、迁移、校验、内核全部从这一份结构派生。
 *
 * 与 0.1.3 的关系：0.1.3 是扁平 snake_case（review_model / report_dir / ...），
 * 0.2.0 改为分区结构（review / execution / budget / report / sizing）。
 * 分区不是为了好看，是为了让「未知字段保留」能按区合并 —— 平坦结构下
 * 一个未知键和已知键混在一起，迁移逻辑很难只动该动的部分。
 */

import type { SizingThresholds } from '../domain/review.js'
import { DEFAULT_THRESHOLDS } from '../domain/review.js'

/** 支持的 LLM 协议。首发只实现 openai-chat-completions。 */
export type LlmProtocol = 'openai-chat-completions'

/** 评审模型配置。 */
export interface ReviewConfig {
  /** 模型标识。'session' 表示沿用会话模型（0.1.3 语义保留）。 */
  readonly model: string
  /** 端点基址（如 https://api.deepseek.com）。空串 = 未配置 → 评审必须失败。 */
  readonly endpoint: string
  /** 协议。 */
  readonly protocol: LlmProtocol
  /** 凭据引用名（不是明文 key）。空串 = 未配置。 */
  readonly credentialRef: string
  /** 单次 LLM 请求超时（毫秒）。与任务总超时解耦，防端点悬挂。 */
  readonly requestTimeoutMs: number
  /** 任务级兜底超时（毫秒）。只防内核死循环，不截断正常评审。 */
  readonly taskTimeoutMs: number
}

/** 执行配置。 */
export interface ExecutionConfig {
  /** 是否允许并行跑多个评审任务。 */
  readonly concurrencyEnabled: boolean
  /** 并行任务数（语义已从「引擎内并发会话」改为「同时运行的评审任务数」）。 */
  readonly concurrency: number
  /** 单次 run_code 子进程超时（毫秒）。 */
  readonly runnerTimeoutMs: number
  /** run_code 子进程内存上限（MB）。 */
  readonly runnerMemoryMb: number
}

/** 预算配置。0 表示不限。 */
export interface BudgetConfig {
  /** 单任务输入 token 上限。 */
  readonly maxInputTokens: number
  /** 单任务输出 token 上限。 */
  readonly maxOutputTokens: number
  /** 单任务费用上限（元）。 */
  /**
   * 单任务费用上限（单位见 currency）。
   * **0 表示不限**；且只有当三个单价至少填了一个时才会真正计费。
   * 注意语义：上限在**发起下一次调用之前**检查，单次调用的实际费用无法预知，
   * 因此最好情形下不会继续花钱，而不是「一分钱都不会超」。
   */
  readonly maxCost: number
  /** 费用单位（仅影响展示与配置语义，不做汇率换算）。 */
  readonly currency: Currency
  /** 输入 token 单价（每百万 token）。0 = 未配置，与输出/缓存一起决定是否计费。 */
  readonly inputPricePerMTok: number
  /** 输出 token 单价（每百万 token）。 */
  readonly outputPricePerMTok: number
  /** 缓存命中 token 单价（每百万 token）。留 0 时按输入单价计。 */
  readonly cacheReadPricePerMTok: number
  /** 主 agent 最大轮次。 */
  readonly maxAgentRounds: number
  /** 单任务最多派多少子 agent。 */
  readonly maxChildren: number
}

/** 报告配置。 */
export interface ReportConfig {
  /** 报告根目录（支持 ~）。 */
  readonly directory: string
  /** 是否写 Markdown。 */
  readonly writeMarkdown: boolean
  /** 是否写机器可读 JSON。 */
  readonly writeJson: boolean
}

/** 引导状态。 */
export interface OnboardingConfig {
  /** 是否已完成首启引导。 */
  readonly firstRunCompleted: boolean
}

/** 0.2.0 配置完整结构。 */
export interface ConfigV2 {
  readonly version: 2
  readonly review: ReviewConfig
  readonly execution: ExecutionConfig
  readonly budget: BudgetConfig
  readonly report: ReportConfig
  readonly sizing: SizingThresholds
  readonly onboarding: OnboardingConfig
}

/** 并发上限（防误填打爆端点与账单）。 */
export const CONCURRENCY_MIN = 1
export const CONCURRENCY_MAX = 32

/** 任务级兜底超时上界：6 小时（沿用 0.1.3 用户拍板）。 */
export const TASK_TIMEOUT_MAX = 6 * 60 * 60 * 1000

/** 默认配置（深拷贝安全：全部是原始值与一字面量对象）。 */
/** 费用单位。只影响展示与语义，不做汇率换算。 */
export type Currency = 'CNY' | 'USD'

export const DEFAULT_CONFIG: ConfigV2 = {
  version: 2,
  review: {
    model: 'session',
    // 端点与凭据默认留空：红线要求「未配置即明确失败」，不得有隐式兜底
    endpoint: '',
    protocol: 'openai-chat-completions',
    credentialRef: '',
    requestTimeoutMs: 10 * 60 * 1000,
    taskTimeoutMs: TASK_TIMEOUT_MAX,
  },
  execution: {
    concurrencyEnabled: false,
    concurrency: 8,
    runnerTimeoutMs: 30_000,
    runnerMemoryMb: 256,
  },
  budget: {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    // 单价全为 0 = 不计费：用户不填就完全跳过费用统计与限制
    maxCost: 0,
    currency: 'CNY',
    inputPricePerMTok: 0,
    outputPricePerMTok: 0,
    cacheReadPricePerMTok: 0,
    maxAgentRounds: 8,
    maxChildren: 8,
  },
  report: {
    directory: '~/dsh-code-review-reports',
    writeMarkdown: true,
    writeJson: true,
  },
  sizing: DEFAULT_THRESHOLDS,
  onboarding: {
    firstRunCompleted: false,
  },
}
