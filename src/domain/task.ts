// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * task.ts —— 评审任务的状态机与记录结构。
 *
 * 状态机存在的意义：任务卡是插件与内核之间唯一的共享状态，两边都会写。
 * 没有显式状态机，就会出现「插件把 running 改成 done，而内核还在写结果」
 * 这类竞争。这里把所有合法迁移列成表，非法迁移在写入前就抛错。
 *
 * 生命周期：
 *   queued → claimed → preparing → reviewing → aggregating → reporting → completed
 *     任一进行中状态都可 → failed / cancelled
 *     心跳过期的进行中状态 → recovering → 回到可恢复阶段或 failed
 *
 * 关键设计：
 *  - revision 单调递增，所有写入走 compare-and-swap，防止双方互相覆盖；
 *  - 「已请求取消」与「已取消完成」是两个独立事实，不能用一个布尔糊在一起；
 *  - 失败信息只保存可序列化的分类字段，不保存 stack、不保存请求体、不保存凭据。
 */

import { KernelError } from './errors.js'
import type { ErrorCode } from './errors.js'

/** 任务阶段。 */
export type TaskStage =
  | 'queued'      // 已入队，等待内核认领
  | 'claimed'     // 内核已认领（有了唯一 owner）
  | 'preparing'   // 取 diff / 筛文件 / 生成 manifest
  | 'reviewing'   // agent 循环执行中
  | 'aggregating' // 汇总子 agent 结果、去重、跨文件复核
  | 'reporting'   // 写报告文件
  | 'completed'   // 终态：成功
  | 'failed'      // 终态：失败
  | 'cancelled'   // 终态：已取消
  | 'recovering'  // 中间态：检测到 owner 失联，等待恢复

/** 终态集合（进入后不再迁移）。 */
export const TERMINAL_STAGES: ReadonlySet<TaskStage> = new Set(['completed', 'failed', 'cancelled'])

/** 进行中集合（会写心跳、可被判定过期）。 */
export const RUNNING_STAGES: ReadonlySet<TaskStage> = new Set(['claimed', 'preparing', 'reviewing', 'aggregating', 'reporting'])

/** 合法迁移表：从某阶段可以去到哪里。未列出的目标一律非法。 */
const ALLOWED: Readonly<Record<TaskStage, readonly TaskStage[]>> = {
  queued: ['claimed', 'failed', 'cancelled'],
  claimed: ['preparing', 'recovering', 'failed', 'cancelled'],
  preparing: ['reviewing', 'recovering', 'failed', 'cancelled'],
  reviewing: ['aggregating', 'recovering', 'failed', 'cancelled'],
  aggregating: ['reporting', 'recovering', 'failed', 'cancelled'],
  reporting: ['completed', 'recovering', 'failed', 'cancelled'],
  // 终态：completed/cancelled 不再迁移；failed 允许 recovering（人工/自动恢复入口）
  completed: [],
  cancelled: [],
  failed: ['recovering'],
  // 恢复中：可回到任一可续跑的阶段，也可直接判定失败
  recovering: ['claimed', 'preparing', 'reviewing', 'aggregating', 'reporting', 'failed', 'cancelled'],
}

/** 判断迁移是否合法。 */
export function canTransition(from: TaskStage, to: TaskStage): boolean {
  return ALLOWED[from].includes(to)
}

/** 返回某阶段所有合法目标（供诊断信息使用）。 */
export function allowedNext(from: TaskStage): readonly TaskStage[] {
  return ALLOWED[from]
}

/** 任务失败信息（只含分类字段，绝不含 stack/凭据/请求体）。 */
export interface TaskFailure {
  readonly code: ErrorCode
  readonly message: string
  readonly retry: 'never' | 'safe' | 'after-input-change'
  readonly effectState: 'none' | 'partial' | 'unknown'
  readonly nextAction?: string
  /** 失败发生在哪个阶段（便于判断能否续跑）。 */
  readonly stage: TaskStage
}

/** 任务记录。落盘为 <DSH_HOME>/dsh-code-review/tasks/<id>.json。 */
export interface TaskRecord {
  /** 任务 id（插件生成，全局唯一）。 */
  readonly id: string
  /** 任务卡结构版本（见 domain/version.ts）。 */
  readonly schemaVersion: number
  /** 乐观并发版本号：每次变更 +1。 */
  readonly revision: number
  /** 当前阶段。 */
  readonly stage: TaskStage
  /** 创建时间（ISO-8601）。 */
  readonly createdAt: string
  /** 最近一次变更时间。 */
  readonly updatedAt: string
  /** 被认领的时间（未认领为 null）。 */
  readonly claimedAt: string | null
  /** 最近一次心跳时间（进行中才有）。 */
  readonly heartbeatAt: string | null
  /** 完成/失败/取消的时间（终态才有）。 */
  readonly completedAt: string | null
  /** 认领者身份 nonce（防 pid 复用误认）。 */
  readonly owner: string | null
  /** 是否已请求取消（请求与完成是两个事实）。 */
  readonly cancelRequested: boolean
  /** 失败信息（stage=failed 时必有）。 */
  readonly failure: TaskFailure | null
  /** 发起会话（用于完成后推送，拿不到则为 null）。 */
  readonly requestor: { readonly sessionId: string } | null
  /** 任务参数快照（评审范围）。 */
  readonly scope: TaskScope
  /** 配置快照（不含明文凭据，只含引用）。 */
  readonly config: Readonly<Record<string, unknown>>
  /** 结果摘要（完成时填充；完整结果在报告文件）。 */
  readonly summary: TaskSummary | null
}

/** 评审范围（任务的输入参数）。 */
export interface TaskScope {
  /** 仓库绝对路径。 */
  readonly repoPath: string
  /** 评审命令。 */
  readonly command: 'review' | 'scan'
  /** review 模式（scan 时为 null）。 */
  readonly mode: 'uncommitted' | 'branch' | 'commit' | null
  /** branch 模式基线。 */
  readonly baseRef: string | null
  /** branch 模式目标端。 */
  readonly headRef: string | null
  /** commit 模式提交号。 */
  readonly commit: string | null
  /** 本次重点领域。 */
  readonly focus: string | null
  /** 排除路径模式。 */
  readonly excludePaths: readonly string[]
  /** 待提交文件清单（敏感点名用）。 */
  readonly pendingPaths: readonly string[]
}

/** 任务结果摘要（完整内容在报告文件里）。 */
export interface TaskSummary {
  /** 报告文件路径（Markdown）。 */
  readonly reportPath: string | null
  /** 机器可读报告路径（JSON）。 */
  readonly reportJsonPath: string | null
  /** 发现总数。 */
  readonly findingCount: number
  /** 各严重度计数。 */
  readonly severityCounts: Readonly<Record<string, number>>
  /** 覆盖率（已审文件/总文件）。 */
  readonly coverage: { readonly reviewed: number; readonly total: number } | null
  /** token 用量。 */
  readonly usage: Readonly<Record<string, number>> | null
  /** 实际耗时（秒）。 */
  readonly elapsedSec: number
}

/**
 * 断言迁移合法。
 * @throws KernelError(INTERNAL_INVARIANT_VIOLATED) 当迁移非法时。
 */
export function assertTransition(from: TaskStage, to: TaskStage): void {
  if (canTransition(from, to)) return
  throw new KernelError(
    'INTERNAL_INVARIANT_VIOLATED',
    `非法任务状态迁移：${from} → ${to}（允许的目标：${ALLOWED[from].join(', ') || '无'}）`,
  )
}

/**
 * 生成一次迁移后的新记录（不可变更新）。
 *
 * @param record 当前记录
 * @param to     目标阶段
 * @param now    ISO-8601 时间戳（由调用方注入，便于测试与确定性）
 * @param patch  可选附加字段（如 failure / summary / owner）
 * @returns 新记录（revision 已递增）
 * @throws KernelError 迁移非法时
 */
export function transition(
  record: TaskRecord,
  to: TaskStage,
  now: string,
  patch: Partial<Pick<TaskRecord, 'failure' | 'summary' | 'owner' | 'cancelRequested'>> = {},
): TaskRecord {
  assertTransition(record.stage, to)
  const terminal = TERMINAL_STAGES.has(to)
  return {
    ...record,
    ...patch,
    stage: to,
    revision: record.revision + 1,
    updatedAt: now,
    // 认领时间：只有首次进入 claimed 时记录，后续覆盖会丢失「什么时候被认领」
    claimedAt: record.claimedAt ?? (to === 'claimed' ? now : null),
    heartbeatAt: RUNNING_STAGES.has(to) ? now : record.heartbeatAt,
    completedAt: terminal ? now : record.completedAt,
  }
}

/** 判断任务是否已结束。 */
export function isTerminal(record: Pick<TaskRecord, 'stage'>): boolean {
  return TERMINAL_STAGES.has(record.stage)
}

/**
 * 判断心跳是否过期。
 * @param heartbeatAt 最近心跳（null 表示从未心跳）
 * @param nowMs       当前毫秒时间戳
 * @param staleMs     过期阈值（毫秒）
 */
export function isHeartbeatStale(heartbeatAt: string | null, nowMs: number, staleMs: number): boolean {
  if (heartbeatAt === null) return true
  const last = Date.parse(heartbeatAt)
  if (!Number.isFinite(last)) return true
  return nowMs - last > staleMs
}
