// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * result-parser.test.ts —— 结构化结果解析的契约测试。
 *
 * 模型返回的 JSON 是**不可信输入**：可能缺字段、类型错、枚举拼错、
 * 数量爆炸。解析器必须做到：能用的尽量救，救不了的明确丢弃并记录原因，
 * 绝不让脏数据流进报告。
 */

import { describe, expect, it } from 'vitest'
import { parseResult } from '../../src/agent/result-parser.js'

/** 一条最小合法发现。 */
const good = {
  path: 'src/a.ts',
  line: 12,
  category: 'bug',
  severity: 'high',
  title: '空指针解引用',
  evidence: 'if (x.y) {}',
  explanation: 'x 可能为 null',
  recommendation: '加空值判断',
  confidence: 0.9,
}

describe('正常解析', () => {
  it('完整发现被保留', () => {
    const r = parseResult({ findings: [good] })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.path).toBe('src/a.ts')
    expect(r.findings[0]!.line).toBe(12)
  })

  it('空 findings 是合法输入（没问题也是结论）', () => {
    const r = parseResult({ findings: [] })
    expect(r.findings).toHaveLength(0)
    expect(r.issues).toHaveLength(0)
  })

  it('反斜杠路径被归一', () => {
    const r = parseResult({ findings: [{ ...good, path: 'src\\a.ts' }] })
    expect(r.findings[0]!.path).toBe('src/a.ts')
  })
})

describe('脏数据防御', () => {
  it('入参不是对象时返回空结果并记录问题', () => {
    const r = parseResult('not an object')
    expect(r.findings).toHaveLength(0)
    expect(r.issues.length).toBeGreaterThan(0)
  })

  it('缺 path 的发现被丢弃', () => {
    const r = parseResult({ findings: [{ ...good, path: '' }] })
    expect(r.findings).toHaveLength(0)
    expect(r.issues.join()).toContain('path')
  })

  // 0.2.0 修正：未知枚举**不再丢弃整条发现**，而是归类保留。
  // 原因：实机出现过模型返回 category:"info"，一条真实发现被静默丢掉，
  // 报告的数字与模型实际报告的问题数对不上。
  it('未知 category 被归类为 other 并保留', () => {
    const r = parseResult({ findings: [{ ...good, category: 'smell' }] })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.category).toBe('other')
    expect(r.issues.join()).toContain('category')
  })

  it('未知 severity 被归类为 info 并保留', () => {
    const r = parseResult({ findings: [{ ...good, severity: 'blocker' }] })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.severity).toBe('info')
    expect(r.issues.join()).toContain('severity')
  })

  it('缺 title 的发现被丢弃', () => {
    const r = parseResult({ findings: [{ ...good, title: '   ' }] })
    expect(r.findings).toHaveLength(0)
  })

  it('非法行号归为 null（不瞎猜）', () => {
    const r = parseResult({ findings: [{ ...good, line: -5 }] })
    expect(r.findings[0]!.line).toBeNull()
  })

  it('confidence 越界被钳制到 0..1', () => {
    expect(parseResult({ findings: [{ ...good, confidence: 5 }] }).findings[0]!.confidence).toBe(1)
    expect(parseResult({ findings: [{ ...good, confidence: -3 }] }).findings[0]!.confidence).toBe(0)
  })

  it('confidence 缺失给保守默认 0.5', () => {
    const r = parseResult({ findings: [{ ...good, confidence: undefined }] })
    expect(r.findings[0]!.confidence).toBe(0.5)
  })

  it('findings 不是数组时忽略并记录', () => {
    const r = parseResult({ findings: 'nope' })
    expect(r.findings).toHaveLength(0)
    expect(r.issues.join()).toContain('数组')
  })

  it('超长字段被截断（防止单条发现撑爆报告）', () => {
    const r = parseResult({ findings: [{ ...good, explanation: 'x'.repeat(10000) }] })
    expect(r.findings[0]!.explanation.length).toBeLessThanOrEqual(4000)
  })
})

describe('子任务请求', () => {
  it('合法子请求被保留', () => {
    const r = parseResult({
      findings: [],
      childRequests: [{ reason: '接口改动影响面大', files: ['src/a.ts'], question: '调用方都改了吗' }],
    })
    expect(r.childRequests).toHaveLength(1)
    expect(r.childRequests[0]!.files).toEqual(['src/a.ts'])
  })

  it('缺少 files 的子请求被丢弃（无法执行）', () => {
    const r = parseResult({ findings: [], childRequests: [{ reason: 'x', files: [], question: 'q' }] })
    expect(r.childRequests).toHaveLength(0)
    expect(r.issues.join()).toContain('files')
  })
})

describe('needsMoreContext', () => {
  it('过滤空串与非字符串', () => {
    const r = parseResult({ findings: [], needsMoreContext: ['需要看调用方', '', 123] })
    expect(r.needsMoreContext).toEqual(['需要看调用方'])
  })
})

describe('未知枚举：归类而不是丢弃', () => {
  it('未知 category 被归到 other，且发现本身保留', () => {
    // 实机踩过：模型返回 category:"info"，整条发现被静默丢掉，
    // 报告当时写「N 个问题」，实际少了一条。
    const r = parseResult({ findings: [{ ...good, category: 'info' }] })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.category).toBe('other')
    expect(r.issues.join()).toContain('已归类为 other')
  })

  it('未知 severity 降为 info，且发现本身保留', () => {
    const r = parseResult({ findings: [{ ...good, severity: 'blocker' }] })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.severity).toBe('info')
    expect(r.issues.join()).toContain('已归类为 info')
  })

  it('合法分类不受影响', () => {
    const r = parseResult({ findings: [good] })
    expect(r.findings[0]!.category).toBe('bug')
    expect(r.issues.join()).not.toContain('归类')
  })
})
