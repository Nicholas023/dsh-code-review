// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * markdown.ts —— 人类可读报告的渲染。
 *
 * 排布顺序按「人先看什么」排：
 *   结论摘要 → 状态与覆盖 → 问题清单 → 敏感文件 → 未覆盖 → 成本 → 分工 → 诊断
 *
 * 一个刻意的取舍：**未覆盖文件必须显式列出**。
 * 只写「发现 3 个问题」而不说「还有 40 个文件没审」，是在制造虚假的安全感。
 */

import type { Finding, FindingSeverity } from '../domain/finding.js'
import { sortBySeverity } from '../domain/finding.js'
import type { ReviewReport } from './schema.js'

/** 严重度图标。 */
const SEVERITY_ICON: Record<FindingSeverity, string> = {
  critical: '🟥',
  high: '🟧',
  medium: '🟨',
  low: '🟦',
  info: '⬜',
}

/** 类别中文名。 */
const CATEGORY_LABEL: Record<string, string> = {
  security: '安全',
  privacy: '脱敏',
  bug: '缺陷',
  redundancy: '冗余',
  'scope-creep': '无关改动',
  'sensitive-file': '敏感文件',
}

/** 位置渲染。 */
function locationOf(f: Finding): string {
  if (f.lineStart === null) return '位置未定位'
  if (f.lineSource === 'exact') return '第 ' + String(f.lineStart) + ' 行'
  const suffix = f.lineSource === 'diff-resolved' ? '（按证据定位）' : '（按文件内容定位）'
  return '第 ' + String(f.lineStart) + ' 行' + suffix
}

/** 渲染一个发现。 */
function renderFinding(f: Finding, index: number): string[] {
  const lines: string[] = []
  lines.push('### ' + String(index) + '. ' + SEVERITY_ICON[f.severity] + ' ' + f.title)
  lines.push('')
  lines.push('- 位置：`' + f.path + '` ' + locationOf(f))
  lines.push('- 类别：' + (CATEGORY_LABEL[f.category] ?? f.category) + ' · 严重度：' + f.severity + ' · 置信度：' + f.confidence.toFixed(2))
  if (f.ruleIds.length > 0) lines.push('- 规则：' + f.ruleIds.join(', '))
  lines.push('')
  if (f.evidence.trim() !== '') {
    lines.push('**证据**')
    lines.push('')
    lines.push('```')
    lines.push(f.evidence.trim())
    lines.push('```')
    lines.push('')
  }
  if (f.explanation.trim() !== '') {
    lines.push('**为什么是问题**')
    lines.push('')
    lines.push(f.explanation.trim())
    lines.push('')
  }
  if (f.recommendation.trim() !== '') {
    lines.push('**建议**')
    lines.push('')
    lines.push(f.recommendation.trim())
    lines.push('')
  }
  return lines
}

/**
 * 渲染 Markdown 报告。
 */
export function renderMarkdown(report: ReviewReport): string {
  const out: string[] = []
  const findings = sortBySeverity(report.findings)
  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1

  out.push('# 代码审查报告')
  out.push('')
  out.push('> 生成时间：' + report.generatedAt)
  out.push('> 仓库：`' + report.repository.path + '`')
  out.push('> 范围：' + report.repository.command + (report.repository.mode === null ? '' : ' / ' + report.repository.mode))
  if (report.repository.baseRef !== null) {
    out.push('> 对比：' + report.repository.baseRef + ' → ' + (report.repository.headRef ?? 'HEAD'))
  }
  if (report.repository.commit !== null) out.push('> 提交：' + report.repository.commit)
  out.push('> 模型：' + report.model.id + '（' + report.model.endpointHost + '）')
  out.push('')

  // ── 结论摘要 ──
  out.push('## 结论')
  out.push('')
  if (findings.length === 0) {
    out.push('未发现问题。')
  } else {
    const parts = ['critical', 'high', 'medium', 'low', 'info']
      .filter((s) => (counts[s] ?? 0) > 0)
      .map((s) => String(counts[s]) + ' ' + s)
    out.push('共 **' + String(findings.length) + '** 个问题（' + parts.join(' / ') + '）。')
  }
  out.push('')

  // ── 状态与覆盖 ──
  out.push('## 运行状态')
  out.push('')
  out.push('- 状态：' + report.status)
  out.push('- 覆盖：已审 ' + String(report.coverage.reviewed) + ' / ' + String(report.coverage.total) + ' 个变更文件')
  out.push('- 规模：' + report.sizing.tier + '（约 ' + String(report.sizing.totalTokens) + ' tokens）')
  out.push('- 耗时：' + report.elapsedSec.toFixed(1) + ' 秒')
  out.push('')
  if (report.status !== 'completed') {
    out.push('> ⚠ 本次评审**未完整完成**，下方结论可能不完整。原因见「诊断」一节。')
    out.push('')
  }

  // ── 问题清单 ──
  if (findings.length > 0) {
    out.push('## 问题清单')
    out.push('')
    findings.forEach((f, i) => { out.push(...renderFinding(f, i + 1)) })
  }

  // ── 敏感文件 ──
  if (report.sensitiveFiles.length > 0) {
    out.push('## ⚠ 敏感文件点名（内容未送审）')
    out.push('')
    for (const p of report.sensitiveFiles) out.push('- `' + p.replace(/[`\r\n]/g, ' ') + '`')
    out.push('')
    out.push('> 这些文件命中敏感路径规则，其内容**未被评审**。请人工确认是否应提交。')
    out.push('')
  }

  // ── 未覆盖 ──
  const uncovered = report.excluded.filter((e) => e.reason !== 'sensitive')
  if (uncovered.length > 0) {
    out.push('## 未覆盖的文件')
    out.push('')
    const byReason = new Map<string, string[]>()
    for (const e of uncovered) {
      const bucket = byReason.get(e.reason) ?? []
      bucket.push(e.path)
      byReason.set(e.reason, bucket)
    }
    for (const [reason, paths] of byReason) {
      out.push('- **' + reason + '**（' + String(paths.length) + ' 个）：' + paths.slice(0, 10).map((p) => '`' + p + '`').join('、') + (paths.length > 10 ? ' 等' : ''))
    }
    out.push('')
  }

  // ── 成本 ──
  out.push('## 用量')
  out.push('')
  out.push('- 输入 tokens：' + String(report.usage.inputTokens))
  out.push('- 输出 tokens：' + String(report.usage.outputTokens))
  out.push('- 缓存命中 tokens：' + String(report.usage.cacheReadTokens))
  out.push('- 请求次数：' + String(report.usage.requests) + '（' + String(report.usage.agents) + ' 个 agent）')
  out.push('')

  // ── 分工 ──
  if (report.agents.length > 0) {
    out.push('## Agent 分工')
    out.push('')
    for (const a of report.agents) {
      out.push('- ' + a.name + '：' + a.stopReason + '（' + String(a.rounds) + ' 轮）')
    }
    out.push('')
  }

  // ── 诊断 ──
  if (report.warnings.length > 0) {
    out.push('## 诊断')
    out.push('')
    for (const w of report.warnings) out.push('- ' + w)
    out.push('')
  }

  return out.join('\n')
}
