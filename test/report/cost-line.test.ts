// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * cost-line.test.ts —— 报告里「估算费用」这一行的出现条件。
 *
 * 唯一要守住的语义：**没配单价 ≠ 花了 0 元**。
 * 未配置时那一行必须完全不出现，否则用户会以为「这次评审免费」。
 */

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/report/markdown.js'
import type { ReviewReport } from '../../src/report/schema.js'

/** 造一份最小但完整的报告。 */
function makeReport(cost: ReviewReport['usage']['cost']): ReviewReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-04T00:00:00.000Z',
    run: { taskId: 't1', kernelVersion: '0.2.0', protocolVersion: 1 },
    model: { id: 'm', endpointHost: 'api.example.com' },
    repository: { path: 'D:/repo', command: 'review', mode: 'uncommitted', baseRef: null, headRef: null, commit: null },
    hashes: { systemPrompt: null },
    status: 'completed',
    findings: [],
    sensitiveFiles: [],
    excluded: [],
    coverage: { reviewed: 1, total: 1 },
    sizing: { tier: 'small', totalTokens: 100, fileCount: 1 },
    agents: [{ name: 'main', stopReason: 'finished', rounds: 1 }],
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, requests: 1, agents: 1, cost },
    warnings: [],
    elapsedSec: 1,
  }
}

describe('报告费用行', () => {
  it('配了单价时显示金额与单位', () => {
    const md = renderMarkdown(makeReport({ amount: 0.42, currency: 'CNY' }))
    expect(md).toContain('估算费用：0.42 CNY')
  })

  it('未配置单价（null）时完全不出现费用行', () => {
    const md = renderMarkdown(makeReport(null))
    expect(md).not.toContain('估算费用')
  })
})
