// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * result-parser.ts —— 解析模型通过 finish 返回的结构化结果。
 *
 * 为什么必须严格解析：findings 会直接进报告和后续行号定位。
 * 一个坏字段（比如 category 拼错）会让整份报告的分类统计失真，
 * 而 confidence 越界会让排序错乱。所以这里逐字段校验并给默认值，
 * 宁可丢弃一条可疑发现，也不要让脏数据流进报告。
 */

import type { FindingCategory, FindingSeverity, LineSource } from '../domain/finding.js'

/** 模型返回的原始发现（未经行号定位与去重）。 */
export interface RawFinding {
  readonly path: string
  readonly line: number | null
  readonly category: FindingCategory
  readonly severity: FindingSeverity
  readonly title: string
  readonly evidence: string
  readonly explanation: string
  readonly recommendation: string
  readonly confidence: number
  /**
   * 行号可信度。
   *
   * 解析阶段只能给一个乐观默认值（模型给了行号就当 exact），
   * **真正的判定必须在编排层做** —— 那里才有 diff，能验证这个行号是不是
   * 真的落在新增行上。执行层如果拿不到 diff 就贸然标 unresolved，
   * 会让每一条正常发现都被显示成「位置未定位」。
   */
  readonly lineSource: LineSource
}

/** 子任务请求（主 agent 要求深挖的区域）。 */
export interface ChildRequest {
  readonly reason: string
  readonly files: readonly string[]
  readonly question: string
}

/** 解析后的完整结果。 */
export interface ParsedResult {
  readonly findings: readonly RawFinding[]
  readonly needsMoreContext: readonly string[]
  readonly childRequests: readonly ChildRequest[]
  /** 解析过程中的问题（供诊断，不进报告正文）。 */
  readonly issues: readonly string[]
}

const CATEGORIES = new Set<FindingCategory>(['security', 'privacy', 'bug', 'redundancy', 'scope-creep', 'sensitive-file'])
const SEVERITIES = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low', 'info'])

/** 安全转字符串。 */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** 解析一个 finding；无法恢复时返回 null。 */
function parseFinding(raw: unknown, issues: string[]): RawFinding | null {
  if (typeof raw !== 'object' || raw === null) {
    issues.push('findings 中存在非对象条目，已丢弃')
    return null
  }
  const o = raw as Record<string, unknown>
  const path = str(o.path)
  if (path === '') {
    issues.push('发现缺少 path，已丢弃')
    return null
  }
  const category = str(o.category) as FindingCategory
  if (!CATEGORIES.has(category)) {
    issues.push('未知 category ' + String(o.category) + '（' + path + '），已丢弃')
    return null
  }
  const severity = str(o.severity) as FindingSeverity
  if (!SEVERITIES.has(severity)) {
    issues.push('未知 severity ' + String(o.severity) + '（' + path + '），已丢弃')
    return null
  }
  const title = str(o.title).trim()
  if (title === '') {
    issues.push('发现缺少 title（' + path + '），已丢弃')
    return null
  }
  const rawLine = o.line
  const line = typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null
  const rawConfidence = o.confidence
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.5

  return {
    path: path.replace(/\\/g, '/'),
    line,
    category,
    severity,
    title,
    evidence: str(o.evidence).slice(0, 2000),
    explanation: str(o.explanation).slice(0, 4000),
    recommendation: str(o.recommendation).slice(0, 2000),
    confidence,
    lineSource: 'exact',
  }
}

/** 解析 finish 的入参。 */
export function parseResult(input: unknown): ParsedResult {
  const issues: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { findings: [], needsMoreContext: [], childRequests: [], issues: ['finish 入参不是对象'] }
  }
  const o = input as Record<string, unknown>

  const findings: RawFinding[] = []
  if (Array.isArray(o.findings)) {
    for (const item of o.findings) {
      const f = parseFinding(item, issues)
      if (f) findings.push(f)
    }
  } else if (o.findings !== undefined) {
    issues.push('findings 不是数组，已忽略')
  }

  const needsMoreContext: string[] = []
  if (Array.isArray(o.needsMoreContext)) {
    for (const item of o.needsMoreContext) {
      if (typeof item === 'string' && item.trim() !== '') needsMoreContext.push(item.trim())
    }
  }

  const childRequests: ChildRequest[] = []
  if (Array.isArray(o.childRequests)) {
    for (const item of o.childRequests) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : []
      // 没有文件清单的子请求无法执行，直接丢弃
      if (files.length === 0) {
        issues.push('子请求缺少 files，已丢弃')
        continue
      }
      childRequests.push({
        reason: str(r.reason, '未说明原因'),
        files,
        question: str(r.question, '请深入检查这些文件'),
      })
    }
  }

  return { findings, needsMoreContext, childRequests, issues }
}
