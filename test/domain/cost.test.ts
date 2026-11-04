// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * cost.test.ts —— 费用估算的契约测试。
 *
 * 这条线的设计前提只有一个：**用户不填单价就完全不计费**。
 * 因此最容易出事的不是数学，而是「没配价目表却被算成 0 元」——
 * 0 元会被当成「很便宜」，而真相是「不知道」。下面把两种状态严格分开。
 */

import { describe, expect, it } from 'vitest'
import { costOvershootNotice, estimateCost, formatCost, priceTableOf } from '../../src/domain/cost.js'

/** 一个填了单价的预算。 */
const priced = {
  currency: 'CNY' as const,
  inputPricePerMTok: 2,
  outputPricePerMTok: 8,
  cacheReadPricePerMTok: 0.2,
}

describe('价目表', () => {
  it('三项单价全为 0 → null（不计费）', () => {
    expect(priceTableOf({ currency: 'CNY', inputPricePerMTok: 0, outputPricePerMTok: 0, cacheReadPricePerMTok: 0 })).toBeNull()
  })

  it('填了任意一项就启用计费', () => {
    const t = priceTableOf({ currency: 'USD', inputPricePerMTok: 0, outputPricePerMTok: 1, cacheReadPricePerMTok: 0 })
    expect(t).not.toBeNull()
    expect(t!.currency).toBe('USD')
  })
})

describe('费用计算', () => {
  it('未配置价目表时返回 null，不是 0', () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 }, null)).toBeNull()
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 }, undefined)).toBeNull()
  })

  it('输入/输出按各自单价计（每百万 token）', () => {
    // 1M 输入 @2 + 1M 输出 @8 = 10
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 }, priced)).toBeCloseTo(10, 6)
  })

  it('缓存命中从输入里扣除，按缓存单价计', () => {
    // 输入 1M，其中 800k 命中：200k*2/1M + 800k*0.2/1M = 0.4 + 0.16
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 800_000 }, priced)).toBeCloseTo(0.56, 6)
  })

  it('缓存单价留 0 时按输入单价计（不会变成免费）', () => {
    const noCachePrice = { ...priced, cacheReadPricePerMTok: 0 }
    // 1M 输入全部命中：应等于「全按输入价」= 2
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 }, noCachePrice)).toBeCloseTo(2, 6)
  })

  it('命中数大于输入数时按 0 计，绝不产生负成本', () => {
    expect(estimateCost({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 999 }, priced)).toBeGreaterThanOrEqual(0)
  })

  it('负的输出数被钳到 0', () => {
    expect(estimateCost({ inputTokens: 0, outputTokens: -100, cacheReadTokens: 0 }, priced)).toBe(0)
  })

  it('零用量是 0 元，而不是 null', () => {
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, priced)).toBe(0)
  })
})

describe('展示', () => {
  it('金额保留两位小数', () => {
    expect(formatCost(0.5678)).toBe('0.57')
  })
})

describe('超支提示', () => {
  it('未配置单价时不提示', () => {
    expect(costOvershootNotice(null, 1, 'CNY')).toBeNull()
  })

  it('上限为 0（不限）时不提示', () => {
    expect(costOvershootNotice(9.99, 0, 'CNY')).toBeNull()
  })

  it('未超支时不提示', () => {
    expect(costOvershootNotice(0.5, 1, 'CNY')).toBeNull()
  })

  it('恰好等于上限不算超支', () => {
    expect(costOvershootNotice(1, 1, 'CNY')).toBeNull()
  })

  it('超支时点名金额、上限与原因', () => {
    const msg = costOvershootNotice(0.0092, 0.000001, 'CNY')
    expect(msg).not.toBeNull()
    expect(msg).toContain('0.01')
    expect(msg).toContain('超过上限')
    expect(msg).toContain('CNY')
  })

  it('美元时显示 USD', () => {
    expect(costOvershootNotice(2, 1, 'USD')).toContain('USD')
  })
})
