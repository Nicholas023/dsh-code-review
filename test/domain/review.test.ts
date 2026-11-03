// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * review.test.ts —— 规模分档与派发规则的契约测试。
 *
 * 这两条规则直接决定 token 花多少，所以必须锁死边界：
 *  - 档位切点（正好等于阈值时算哪档）；
 *  - 派发触发条件（每种原因都能单独触发，且能同时记录多条）。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  classifySize,
  evaluateDispatch,
  mainAgentPolicy,
  needsFurtherSplit,
  type FileChangeProfile,
} from '../../src/domain/review.js'

/** 构造文件画像（默认「什么都不触发」）。 */
function profile(overrides: Partial<FileChangeProfile> = {}): FileChangeProfile {
  return {
    path: 'src/a.ts',
    changedLines: 10,
    diffTokens: 100,
    sensitive: false,
    crossCutting: false,
    ...overrides,
  }
}

describe('规模分档', () => {
  it('小于 smallTokens 为小档', () => {
    expect(classifySize(0)).toBe('small')
    expect(classifySize(DEFAULT_THRESHOLDS.smallTokens - 1)).toBe('small')
  })

  it('正好等于 smallTokens 归入中档（边界取闭区间右侧）', () => {
    expect(classifySize(DEFAULT_THRESHOLDS.smallTokens)).toBe('medium')
  })

  it('中档区间', () => {
    expect(classifySize(50_000)).toBe('medium')
    expect(classifySize(DEFAULT_THRESHOLDS.largeTokens)).toBe('medium')
  })

  it('超过 largeTokens 为大档', () => {
    expect(classifySize(DEFAULT_THRESHOLDS.largeTokens + 1)).toBe('large')
  })

  it('阈值可覆盖（配置化）', () => {
    const custom = { ...DEFAULT_THRESHOLDS, smallTokens: 1000, largeTokens: 2000 }
    expect(classifySize(500, custom)).toBe('small')
    expect(classifySize(1500, custom)).toBe('medium')
    expect(classifySize(5000, custom)).toBe('large')
  })
})

describe('主 agent 策略', () => {
  it('小档不声明 SDK（省掉那几百 token）', () => {
    expect(mainAgentPolicy('small')).toEqual({ depth: 'full', sdk: false })
  })

  it('中档看全局并给 SDK', () => {
    expect(mainAgentPolicy('medium')).toEqual({ depth: 'global', sdk: true })
  })

  it('大档只看大纲（正文交子 agent）', () => {
    expect(mainAgentPolicy('large')).toEqual({ depth: 'outline', sdk: true })
  })
})

describe('确定性派发规则', () => {
  it('普通小改动不派子 agent', () => {
    const d = evaluateDispatch(profile())
    expect(d.dispatch).toBe(false)
    expect(d.reasons).toEqual([])
  })

  it('单文件改动超阈值触发', () => {
    const d = evaluateDispatch(profile({ changedLines: DEFAULT_THRESHOLDS.fileLinesForChild + 1 }))
    expect(d.dispatch).toBe(true)
    expect(d.reasons.join()).toContain('行')
  })

  it('单文件 diff token 超阈值触发', () => {
    const d = evaluateDispatch(profile({ diffTokens: DEFAULT_THRESHOLDS.fileTokensForChild + 1 }))
    expect(d.dispatch).toBe(true)
  })

  it('敏感路径触发（且原因说明正文不送审）', () => {
    const d = evaluateDispatch(profile({ sensitive: true }))
    expect(d.dispatch).toBe(true)
    expect(d.reasons.join()).toContain('不送审')
  })

  it('横向影响文件触发', () => {
    const d = evaluateDispatch(profile({ crossCutting: true }))
    expect(d.dispatch).toBe(true)
  })

  it('多个条件同时命中时保留全部原因（便于解释为什么要多花钱）', () => {
    const d = evaluateDispatch(profile({
      changedLines: 500,
      diffTokens: 20_000,
      sensitive: true,
      crossCutting: true,
    }))
    expect(d.dispatch).toBe(true)
    expect(d.reasons.length).toBe(4)
  })

  it('边界值不触发（等于阈值不算超过）', () => {
    const d = evaluateDispatch(profile({
      changedLines: DEFAULT_THRESHOLDS.fileLinesForChild,
      diffTokens: DEFAULT_THRESHOLDS.fileTokensForChild,
    }))
    expect(d.dispatch).toBe(false)
  })
})

describe('切片下切判定', () => {
  it('未超预算不切', () => {
    expect(needsFurtherSplit(DEFAULT_THRESHOLDS.childTokensMax)).toBe(false)
  })

  it('超预算继续切', () => {
    expect(needsFurtherSplit(DEFAULT_THRESHOLDS.childTokensMax + 1)).toBe(true)
  })
})
