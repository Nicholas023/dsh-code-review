// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * schema.ts —— 机器可读报告的 JSON 结构（唯一真源）。
 *
 * 这份结构会随包发布，外部工具（面板聚合、趋势统计）依赖它。
 * 因此：字段只增不改，语义变更必须升 schemaVersion。
 */

import type { Finding } from '../domain/finding.js'

/** 报告结构版本（与 domain/version.ts 的 REPORT_SCHEMA_VERSION 一致）。 */
export const REPORT_SCHEMA_VERSION = 1

/** 运行状态。 */
export type ReportStatus = 'completed' | 'partial' | 'failed' | 'cancelled'

/** 一个 agent 的执行摘要。 */
export interface AgentSummary {
  readonly name: string
  readonly stopReason: string
  readonly rounds: number
}

/** 用量。 */
export interface ReportUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly requests: number
  readonly agents: number
  /**
   * 估算费用。**null 表示用户没填单价**，此时全链路不出现任何金额
   * （不是「0 元」，是「不计量」——两者含义完全不同）。
   */
  readonly cost?: { readonly amount: number; readonly currency: string } | null
}

/** 完整报告。 */
export interface ReviewReport {
  readonly schemaVersion: number
  /** 生成时间（ISO-8601）。 */
  readonly generatedAt: string
  /** 任务与运行标识。 */
  readonly run: {
    readonly taskId: string | null
    readonly kernelVersion: string
    readonly protocolVersion: number
  }
  /** 模型信息（不含凭据）。 */
  readonly model: {
    readonly id: string
    readonly endpointHost: string
  }
  /** 仓库与范围。 */
  readonly repository: {
    readonly path: string
    readonly command: 'review' | 'scan'
    readonly mode: string | null
    readonly baseRef: string | null
    readonly headRef: string | null
    readonly commit: string | null
  }
  /** 可选哈希（用于判断「规则变了吗」）。 */
  readonly hashes: {
    readonly systemPrompt: string | null
  }
  readonly status: ReportStatus
  readonly findings: readonly Finding[]
  readonly sensitiveFiles: readonly string[]
  readonly excluded: ReadonlyArray<{ readonly path: string; readonly reason: string; readonly detail: string }>
  readonly coverage: {
    readonly reviewed: number
    readonly total: number
  }
  readonly sizing: {
    readonly tier: string
    readonly totalTokens: number
    readonly fileCount: number
  }
  readonly agents: readonly AgentSummary[]
  readonly usage: ReportUsage
  readonly warnings: readonly string[]
  readonly elapsedSec: number
}
