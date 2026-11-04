// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * schema.ts —— 配置的归一化与校验。
 *
 * 核心原则（对应设计定稿 6.2「升级不丢设置」）：
 *  1. **归一化只读不写**：它产出一个合法的 ConfigV2，但**绝不丢弃**原始对象。
 *     原始对象（raw）连同未知字段一起返回，写回时据此做 patch 合并。
 *     0.1.3 的 normalizeConfig 是「未知键剔除」，那是丢配置的根因。
 *  2. **非法值回退默认，不抛错**：配置坏了不能阻止插件加载（否则用户连
 *     设置页都打不开去修）。但非法值要能被诊断出来 —— 见 issues 收集。
 *  3. **钳制而不是丢弃**：数值越界钳到边界，保留用户「想更大/更小」的意图。
 */

import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  DEFAULT_CONFIG,
  TASK_TIMEOUT_MAX,
  type ConfigV2,
  type Currency,
} from './defaults.js'
import type { SizingThresholds } from '../domain/review.js'

/** 归一化结果：合法配置 + 原始对象（供写回合并）+ 诊断信息。 */
export interface NormalizedConfig {
  /** 通过校验、补齐默认后的配置。 */
  readonly config: ConfigV2
  /** 原始对象（可能含未知字段）。写回时以此为基底做 patch。 */
  readonly raw: Record<string, unknown>
  /** 被纠正/丢弃的字段说明（用于设置页诊断与迁移报告）。 */
  readonly issues: readonly string[]
}

/** 判断是否普通对象（排除 null 与数组）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 读取分区；缺失或类型不对时返回空对象（不报错，交给逐字段回退）。 */
function section(raw: Record<string, unknown>, key: string, issues: string[]): Record<string, unknown> {
  const v = raw[key]
  if (v === undefined) return {}
  if (!isRecord(v)) {
    issues.push(`${key} 不是对象，已忽略该区`);
    return {}
  }
  return v
}

/** 取字符串；非法则回退默认并记录。 */
function str(sec: Record<string, unknown>, key: string, fallback: string, issues: string[], where: string): string {
  const v = sec[key]
  if (v === undefined) return fallback
  if (typeof v !== 'string') {
    issues.push(`${where}.${key} 应为字符串，已回退默认`);
    return fallback
  }
  return v.trim()
}

/** 取布尔；非法则回退默认。 */
function bool(sec: Record<string, unknown>, key: string, fallback: boolean, issues: string[], where: string): boolean {
  const v = sec[key]
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') {
    issues.push(`${where}.${key} 应为布尔值，已回退默认`);
    return fallback
  }
  return v
}

/**
 * 取数值并钳制到 [min, max]。
 * 非有限值（NaN/Infinity）或类型错误 → 回退默认（钳制对非法态无意义）。
 */
function num(
  sec: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
  where: string,
): number {
  const v = sec[key]
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    issues.push(`${where}.${key} 应为有限数值，已回退默认`)
    return fallback
  }
  const clamped = Math.min(max, Math.max(min, v))
  if (clamped !== v) issues.push(`${where}.${key} 越界 ${v}，已钳制为 ${clamped}`)
  return clamped
}

/**
 * 把任意不可信输入归一为合法配置。
 * @param input 从磁盘读回的对象（可能缺字段、含未知字段、类型错误）
 */
export function normalizeConfig(input: unknown): NormalizedConfig {
  const issues: string[] = []
  const raw = isRecord(input) ? input : (issues.push('配置不是对象，已全部回退默认'), {})

  // —— review ——
  const rv = section(raw, 'review', issues)
  const review = {
    model: str(rv, 'model', DEFAULT_CONFIG.review.model, issues, 'review') || DEFAULT_CONFIG.review.model,
    endpoint: str(rv, 'endpoint', DEFAULT_CONFIG.review.endpoint, issues, 'review'),
    // 协议目前只有一个合法值；其余一律回退（将来扩协议时在此加白名单）
    protocol: (rv.protocol === 'openai-chat-completions'
      ? 'openai-chat-completions'
      : DEFAULT_CONFIG.review.protocol) as ConfigV2['review']['protocol'],
    credentialRef: str(rv, 'credentialRef', DEFAULT_CONFIG.review.credentialRef, issues, 'review'),
    requestTimeoutMs: num(rv, 'requestTimeoutMs', DEFAULT_CONFIG.review.requestTimeoutMs, 1_000, 60 * 60 * 1000, issues, 'review'),
    taskTimeoutMs: num(rv, 'taskTimeoutMs', DEFAULT_CONFIG.review.taskTimeoutMs, 1_000, TASK_TIMEOUT_MAX, issues, 'review'),
  }

  // —— execution ——
  const ex = section(raw, 'execution', issues)
  const execution = {
    concurrencyEnabled: bool(ex, 'concurrencyEnabled', DEFAULT_CONFIG.execution.concurrencyEnabled, issues, 'execution'),
    // 并发取整后钳制（小数没有意义）
    concurrency: Math.round(num(ex, 'concurrency', DEFAULT_CONFIG.execution.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX, issues, 'execution')),
    runnerTimeoutMs: num(ex, 'runnerTimeoutMs', DEFAULT_CONFIG.execution.runnerTimeoutMs, 1_000, 10 * 60 * 1000, issues, 'execution'),
    runnerMemoryMb: num(ex, 'runnerMemoryMb', DEFAULT_CONFIG.execution.runnerMemoryMb, 64, 4096, issues, 'execution'),
  }

  // —— budget ——（0 表示不限，因此下限为 0）
  const bd = section(raw, 'budget', issues)
  const budget = {
    maxInputTokens: num(bd, 'maxInputTokens', DEFAULT_CONFIG.budget.maxInputTokens, 0, Number.MAX_SAFE_INTEGER, issues, 'budget'),
    maxOutputTokens: num(bd, 'maxOutputTokens', DEFAULT_CONFIG.budget.maxOutputTokens, 0, Number.MAX_SAFE_INTEGER, issues, 'budget'),
    // 旧键 maxCostCny 仍被接受：0.2.0 早期把它写在配置里，改名后不能让用户的设置凭空消失
  maxCost: num(
    bd,
    'maxCost',
    typeof bd.maxCostCny === 'number' ? bd.maxCostCny : DEFAULT_CONFIG.budget.maxCost,
    0,
    Number.MAX_SAFE_INTEGER,
    issues,
    'budget',
  ),
  currency: (bd.currency === 'USD' ? 'USD' : 'CNY') as Currency,
  inputPricePerMTok: num(bd, 'inputPricePerMTok', DEFAULT_CONFIG.budget.inputPricePerMTok, 0, 1_000_000, issues, 'budget'),
  outputPricePerMTok: num(bd, 'outputPricePerMTok', DEFAULT_CONFIG.budget.outputPricePerMTok, 0, 1_000_000, issues, 'budget'),
  cacheReadPricePerMTok: num(bd, 'cacheReadPricePerMTok', DEFAULT_CONFIG.budget.cacheReadPricePerMTok, 0, 1_000_000, issues, 'budget'),
    maxAgentRounds: num(bd, 'maxAgentRounds', DEFAULT_CONFIG.budget.maxAgentRounds, 1, 50, issues, 'budget'),
    maxChildren: num(bd, 'maxChildren', DEFAULT_CONFIG.budget.maxChildren, 0, 64, issues, 'budget'),
  }

  // —— report ——
  const rp = section(raw, 'report', issues)
  const report = {
    directory: str(rp, 'directory', DEFAULT_CONFIG.report.directory, issues, 'report') || DEFAULT_CONFIG.report.directory,
    writeMarkdown: bool(rp, 'writeMarkdown', DEFAULT_CONFIG.report.writeMarkdown, issues, 'report'),
    writeJson: bool(rp, 'writeJson', DEFAULT_CONFIG.report.writeJson, issues, 'report'),
  }

  // —— sizing ——
  const sz = section(raw, 'sizing', issues)
  const sizing: SizingThresholds = {
    smallTokens: num(sz, 'smallTokens', DEFAULT_CONFIG.sizing.smallTokens, 1_000, 10_000_000, issues, 'sizing'),
    largeTokens: num(sz, 'largeTokens', DEFAULT_CONFIG.sizing.largeTokens, 1_000, 10_000_000, issues, 'sizing'),
    fileLinesForChild: num(sz, 'fileLinesForChild', DEFAULT_CONFIG.sizing.fileLinesForChild, 1, 100_000, issues, 'sizing'),
    fileTokensForChild: num(sz, 'fileTokensForChild', DEFAULT_CONFIG.sizing.fileTokensForChild, 100, 1_000_000, issues, 'sizing'),
    childTokensMax: num(sz, 'childTokensMax', DEFAULT_CONFIG.sizing.childTokensMax, 1_000, 10_000_000, issues, 'sizing'),
  }
  // 档位必须单调：小档上界不得大于等于大档下界，否则 classifySize 永不出 medium
  if (sizing.smallTokens >= sizing.largeTokens) {
    issues.push('sizing.smallTokens 应小于 largeTokens，已回退默认阈值')
    Object.assign(sizing, DEFAULT_CONFIG.sizing)
  }

  // —— onboarding ——
  const ob = section(raw, 'onboarding', issues)
  const onboarding = {
    firstRunCompleted: bool(ob, 'firstRunCompleted', DEFAULT_CONFIG.onboarding.firstRunCompleted, issues, 'onboarding'),
  }

  return {
    config: { version: 2, review, execution, budget, report, sizing, onboarding },
    raw,
    issues,
  }
}
