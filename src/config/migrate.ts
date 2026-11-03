// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * migrate.ts —— 配置文件版本迁移链。
 *
 * 用户明确要求：「更新一个版本不能把设置项搞丢了」。本模块是该要求的第一道保障。
 *
 * 迁移链设计（显式、单向、可测试）：
 *   v1（0.1.3 扁平 snake_case）──migrateV1toV2──> v2（分区结构）
 *
 * 三条铁律：
 *  1. **未知字段必须保留**。用户的配置里可能有本版本不认识的键（手动加的、
 *     未来版本写的）。迁移只搬运认识的字段，其余原样带到顶层，绝不丢弃。
 *  2. **删除的字段要有交代**。engine_bin 在 0.2.0 失去意义，迁移时删除，
 *     但必须登记进 removedFields，让设置页能告诉用户「它去哪了」。
 *  3. **语义变化要显式说明**。concurrency 数值保留，但含义变了（引擎内并发
 *     → 同时运行的评审任务数），必须登记进 notes 而不是悄悄沿用。
 */

import { DEFAULT_CONFIG } from './defaults.js'
import { normalizeConfig } from './schema.js'

/** 迁移结果。 */
export interface MigrationResult {
  /** 迁移后的配置对象（version=2）。 */
  readonly config: Record<string, unknown>
  /** 迁移前的版本号（0.1.3 无版本字段，一律视为 1）。 */
  readonly fromVersion: number
  /** 目标版本号。 */
  readonly toVersion: number
  /** 被删除的字段（附原因，供设置页展示）。 */
  readonly removedFields: readonly { readonly key: string; readonly reason: string }[]
  /** 语义发生变化但值被保留的字段。 */
  readonly notes: readonly string[]
  /** 原样保留的未知字段键名。 */
  readonly preservedUnknownKeys: readonly string[]
}

/** 0.1.3 认识的全部字段（除去 engine_bin，它是被删除的）。 */
const V1_KNOWN = new Set([
  'review_model',
  'report_dir',
  'engine_bin',
  'first_run',
  'review_timeout_ms',
  'concurrency_enabled',
  'concurrency',
])

/** 判断是否普通对象。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 从扁平对象里取字符串（带默认）。 */
function takeString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

/** 从扁平对象里取数值（带范围钳制）。 */
function takeNumber(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = raw[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

/**
 * 执行 v1 → v2 迁移。
 *
 * @param raw0 0.1.3 读回来的原始对象（可能含未知字段）
 * @returns 迁移结果；调用方负责落盘
 */
export function migrateV1toV2(raw0: unknown): MigrationResult {
  const raw = isRecord(raw0) ? raw0 : {}
  const removedFields: { key: string; reason: string }[] = []
  const notes: string[] = []

  // —— 模型（0.1.3 只存模型标识；端点/凭据由宿主路由提供）——
  const model = takeString(raw, 'review_model', DEFAULT_CONFIG.review.model)

  // —— 报告目录 ——
  const reportDir = takeString(raw, 'report_dir', DEFAULT_CONFIG.report.directory)

  // —— 超时（0.1.3 是任务级兜底）——
  const taskTimeoutMs = takeNumber(raw, 'review_timeout_ms', DEFAULT_CONFIG.review.taskTimeoutMs, 1_000, 6 * 60 * 60 * 1000)

  // —— 并发（值保留，语义变化需说明）——
  const concurrencyEnabled = raw.concurrency_enabled === true
  const concurrency = Math.round(takeNumber(raw, 'concurrency', DEFAULT_CONFIG.execution.concurrency, 1, 32))
  if (raw.concurrency !== undefined) {
    notes.push('concurrency 数值已保留，但语义由「引擎内部并发会话数」改为「同时运行的评审任务数」')
  }

  // —— 首启引导（0.1.3 用 first_run=true 表示「尚未引导」，语义反转）——
  // 只有严格布尔才采纳：非法类型（如字符串 'yes'）回退默认，
  // 否则会被误判成「已完成引导」而跳过首次使用说明。
  const firstRunCompleted =
    typeof raw.first_run === 'boolean'
      ? !raw.first_run
      : DEFAULT_CONFIG.onboarding.firstRunCompleted

  // —— engine_bin：删除并登记 ——
  if (Object.hasOwn(raw, 'engine_bin')) {
    removedFields.push({
      key: 'engine_bin',
      reason: '0.2.0 不再使用独立引擎二进制（评审由内置 Node 内核完成），该字段已失效',
    })
  }

  // —— 未知字段：原样保留到顶层 ——
  const preserved: Record<string, unknown> = {}
  const preservedUnknownKeys: string[] = []
  for (const key of Object.keys(raw)) {
    if (V1_KNOWN.has(key)) continue
    preserved[key] = raw[key]
    preservedUnknownKeys.push(key)
  }

  // 组装 v2：显式写出每个分区（不整体复制默认值，避免把默认值误当用户设置）
  const config: Record<string, unknown> = {
    version: 2,
    review: {
      model,
      // 端点与凭据在 0.1.3 由宿主路由注入，配置文件里没有；迁移后留空，
      // 由用户在新设置页显式填写（红线：不得隐式兜底）
      endpoint: DEFAULT_CONFIG.review.endpoint,
      protocol: DEFAULT_CONFIG.review.protocol,
      credentialRef: DEFAULT_CONFIG.review.credentialRef,
      requestTimeoutMs: DEFAULT_CONFIG.review.requestTimeoutMs,
      taskTimeoutMs,
    },
    execution: {
      concurrencyEnabled,
      concurrency,
      runnerTimeoutMs: DEFAULT_CONFIG.execution.runnerTimeoutMs,
      runnerMemoryMb: DEFAULT_CONFIG.execution.runnerMemoryMb,
    },
    budget: { ...DEFAULT_CONFIG.budget },
    report: {
      directory: reportDir,
      writeMarkdown: DEFAULT_CONFIG.report.writeMarkdown,
      writeJson: DEFAULT_CONFIG.report.writeJson,
    },
    sizing: { ...DEFAULT_CONFIG.sizing },
    onboarding: { firstRunCompleted },
    // 未知字段放在顶层，读写都原样带着
    ...preserved,
  }

  return {
    config,
    fromVersion: 1,
    toVersion: 2,
    removedFields,
    notes,
    preservedUnknownKeys,
  }
}

/**
 * 按版本号选择迁移路径。
 * 已是 v2 时返回 null（表示无需迁移）。
 * @throws 版本高于当前支持时抛错（不允许静默降级）
 */
export function migrate(raw: unknown): MigrationResult | null {
  const obj = isRecord(raw) ? raw : {}
  const version = typeof obj.version === 'number' ? obj.version : 1

  if (version === 2) return null
  if (version === 1) return migrateV1toV2(obj)
  // 版本高于本代码支持：必须显式失败，不能当成已知版本处理
  throw new Error(`配置文件版本 ${version} 高于本插件支持的版本 2：请升级插件后再试（拒绝静默降级）`)
}

/** 归一化迁移结果（供调用方直接得到可用的 ConfigV2）。 */
export function migrateAndNormalize(raw: unknown): { migrated: MigrationResult | null; normalized: ReturnType<typeof normalizeConfig> } {
  const migrated = migrate(raw)
  const source = migrated ? migrated.config : raw
  return { migrated, normalized: normalizeConfig(source) }
}
