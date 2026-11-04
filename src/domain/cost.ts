// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * cost.ts —— 费用估算（纯函数，无 IO）。
 *
 * 设计前提（用户拍板）：**单价不填就完全不计费**。
 * 因为单价随模型、供应商、时段变化，插件无从得知；与其内置一张迟早过期的价目表，
 * 不如让用户自己填——不填就是「我不关心钱」，一切费用统计与限制都跳过。
 *
 * 三个单价全为 0 → priceTableOf() 返回 null → 全链路（循环、报告、状态回显）
 * 都不出现任何费用数字，也不会因为「费用上限」而中断评审。
 *
 * 计价口径：
 *   成本 = (输入 - 缓存命中) × 输入单价 + 缓存命中 × 缓存单价 + 输出 × 输出单价
 * 之所以把缓存命中从输入里扣掉：DeepSeek 等厂商的 prompt_tokens **包含** 命中部分，
 * 而命中部分的单价低一个数量级。用 (输入 - 命中) 才不会把便宜的 token 按贵价算。
 * 若某厂商报的命中数大于输入数（口径不同），按 0 处理，绝不产生负成本。
 */

import type { Currency } from '../config/defaults.js'

/** 一份生效中的价目表。 */
export interface PriceTable {
  readonly currency: Currency
  // 字段名刻意与配置项保持一致（inputPricePerMTok …）：
  // 两套名字是同一个值，一旦不一致就会出现「配置对了但算出来是 NaN」的错位。
  /** 输入 token 每百万单价。 */
  readonly inputPricePerMTok: number
  /** 输出 token 每百万单价。 */
  readonly outputPricePerMTok: number
  /** 缓存命中 token 每百万单价；为 0 时按输入单价计。 */
  readonly cacheReadPricePerMTok: number
}

/** 参与计价的用量。 */
export interface CostUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
}

/** 一份可选的价目表（未配置时为 null）。 */
export interface BudgetPricing {
  readonly maxCost: number
  readonly table: PriceTable | null
}

/** 从归一化后的配置里取价目表；三个单价全为 0 时返回 null。 */
export function priceTableOf(budget: {
  readonly currency: Currency
  readonly inputPricePerMTok: number
  readonly outputPricePerMTok: number
  readonly cacheReadPricePerMTok: number
}): PriceTable | null {
  const anySet = budget.inputPricePerMTok > 0 || budget.outputPricePerMTok > 0 || budget.cacheReadPricePerMTok > 0
  if (!anySet) return null
  return {
    currency: budget.currency,
    inputPricePerMTok: budget.inputPricePerMTok,
    outputPricePerMTok: budget.outputPricePerMTok,
    cacheReadPricePerMTok: budget.cacheReadPricePerMTok,
  }
}

/**
 * 估算一次用量的费用。
 * @param usage 累计用量
 * @param table 价目表（null 时直接返回 null，表示「不计费」）
 * @returns 金额（与 table.currency 同单位）；未配置价目表时返回 null
 */
export function estimateCost(usage: CostUsage, table: PriceTable | null | undefined): number | null {
  // 防御 undefined：老调用方（或未来新增的调用点）不传价目表时必须视为「不计费」，而不是崩掉
  if (table === null || table === undefined) return null
  const cacheRead = Math.max(0, Math.min(usage.cacheReadTokens, usage.inputTokens))
  const billableInput = Math.max(0, usage.inputTokens - cacheRead)
  // 缓存单价留 0 表示「按输入价计」，避免用户只填两个单价时缓存部分被算成免费
  const cachePrice = table.cacheReadPricePerMTok > 0 ? table.cacheReadPricePerMTok : table.inputPricePerMTok
  const perToken = 1 / 1_000_000
  return (
    billableInput * table.inputPricePerMTok * perToken +
    cacheRead * cachePrice * perToken +
    Math.max(0, usage.outputTokens) * table.outputPricePerMTok * perToken
  )
}

/** 把金额格式化成两位小数（显示用）。 */
export function formatCost(amount: number): string {
  return amount.toFixed(2)
}

/**
 * 超支提示。
 *
 * 语义必须说清楚（这里踩过一次）：费用上限是在**发起下一次模型调用之前**检查的，
 * 单次调用本身花多少，调用前无法预知。所以上限保证的是「不会继续花钱」，
 * 不是「一分钱都不会超」。一旦本次总额已经超过上限，就必须显式说出来 ——
 * 静默超支比没有上限更恶劣。
 * @param cost    本次实际费用（null = 未配置单价）
 * @param maxCost 上限（0 = 不限）
 * @param currency 货币单位
 * @returns 需要提示的文本；未超支或不计费时返回 null
 */
export function costOvershootNotice(cost: number | null, maxCost: number, currency: string): string | null {
  if (cost === null || maxCost <= 0 || cost <= maxCost) return null
  return (
    '本次费用 ' + cost.toFixed(2) + ' ' + currency +
    ' 已超过上限 ' + maxCost.toFixed(2) + ' ' + currency +
    '：上限只在发起下一次模型调用前检查，单次调用的实际费用无法预知'
  )
}
