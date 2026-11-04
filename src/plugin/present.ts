// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * present.ts —— 任务状态 → 会话内文本。
 *
 * 单一呈现点：工具返回与命令返回共用这里的函数，
 * 避免 0.1.3 那种「工具一套文案、命令另一套」的漂移。
 */

import { formatAmount } from '../domain/cost.js'
import type { TaskRecord } from '../domain/task.js'

/** 阶段 → 中文说明。 */
const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  claimed: '已认领',
  preparing: '准备中',
  reviewing: '评审中',
  aggregating: '汇总中',
  reporting: '写报告中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  recovering: '恢复中',
}

/** 阶段图标。 */
const STAGE_ICON: Record<string, string> = {
  queued: '🕐', claimed: '⏳', preparing: '⏳', reviewing: '⏳',
  aggregating: '⏳', reporting: '⏳', completed: '✅', failed: '❌',
  cancelled: '🚫', recovering: '🔄',
}

/** 渲染单个任务卡。 */
export function presentTask(record: TaskRecord): string {
  // 评审状态 vs 任务阶段是两回事：
  //   stage=completed 只说明内核跑完了这一轮，
  //   summary.status=partial 才说明「评审没拿到完整结论」。
  // 二者混同会让失败伪装成「✅ 已完成 · 0 个问题」，所以这里优先看评审状态。
  const reviewStatus = record.summary?.status
  const partial = reviewStatus !== undefined && reviewStatus !== 'completed'
  const icon = partial ? '⚠️' : (STAGE_ICON[record.stage] ?? '🕐')
  const label = partial
    ? (STAGE_LABEL[record.stage] ?? record.stage) + '（评审未完整完成）'
    : (STAGE_LABEL[record.stage] ?? record.stage)
  const lines: string[] = []

  lines.push(icon + ' 任务 ' + record.id + ' — ' + label)
  lines.push('')
  lines.push('- 仓库：' + record.scope.repoPath)
  lines.push('- 范围：' + record.scope.command + (record.scope.mode === null ? '' : ' / ' + record.scope.mode))
  if (record.scope.baseRef !== null) lines.push('- 对比：' + record.scope.baseRef + ' → ' + (record.scope.headRef ?? 'HEAD'))
  if (record.scope.commit !== null) lines.push('- 提交：' + record.scope.commit)
  if (record.scope.focus !== null) lines.push('- 重点：' + record.scope.focus)
  lines.push('- 创建：' + record.createdAt)

  if (record.summary !== null) {
    const s = record.summary
    lines.push('')
    if (partial) {
      lines.push('**状态**：' + String(reviewStatus) + ' —— 本次评审**没有完整跑完**，下面的问题数不代表全部，也不是「没有问题」')
      lines.push('')
    }
    lines.push('**结果**：' + String(s.findingCount) + ' 个问题，覆盖 ' + String(s.coverage?.reviewed ?? 0) + '/' + String(s.coverage?.total ?? 0) + ' 个文件，耗时 ' + s.elapsedSec.toFixed(1) + ' 秒')
    if (s.usage !== null) {
      lines.push('**用量**：输入 ' + String(s.usage.inputTokens ?? 0) + ' / 输出 ' + String(s.usage.outputTokens ?? 0) + ' / 缓存命中 ' + String(s.usage.cacheReadTokens ?? 0) + ' tokens，' + String(s.usage.requests ?? 0) + ' 次请求')
    }
    const warns = s.warnings ?? []
    if (warns.length > 0) {
      lines.push('**告警**：')
      for (const w of warns) lines.push('- ' + w)
    }
    if (s.cost !== undefined && s.cost !== null) {
      lines.push('**估算费用**：' + formatAmount(s.cost.amount) + ' ' + s.cost.currency)
    }
    if (s.reportPath !== null) lines.push('**报告**：' + s.reportPath)
    if (s.reportJsonPath !== null) lines.push('**机器可读**：' + s.reportJsonPath)
    const sev = s.severityCounts
    const sevParts = Object.keys(sev).filter((k) => (sev[k] ?? 0) > 0).map((k) => String(sev[k]) + ' ' + k)
    if (sevParts.length > 0) lines.push('**严重度**：' + sevParts.join(' / '))
  }

  if (record.failure !== null) {
    lines.push('')
    lines.push('**失败原因**：' + record.failure.message)
    lines.push('**错误码**：' + record.failure.code + '（可重试：' + record.failure.retry + '）')
    if (record.failure.nextAction !== undefined) lines.push('**建议**：' + record.failure.nextAction)
  }

  return lines.join('\n')
}

/** 渲染任务列表。 */
export function presentTaskList(records: readonly TaskRecord[], limit = 10): string {
  if (records.length === 0) {
    return '任务簿为空。用 code_review 发起一次评审。'
  }
  const lines: string[] = ['最近的任务（最多 ' + String(limit) + ' 条）：', '']
  for (const r of records.slice(0, limit)) {
    const icon = STAGE_ICON[r.stage] ?? '🕐'
    const label = STAGE_LABEL[r.stage] ?? r.stage
    const parts = r.scope.repoPath.replace(/\\/g, '/').split('/')
    const repo = parts.length > 0 ? parts[parts.length - 1] : r.scope.repoPath
    lines.push('- ' + icon + ' ' + r.id + ' ' + label + ' · ' + repo + ' · ' + r.createdAt)
  }
  lines.push('')
  lines.push('用 code_review_status 并传入 task_id 查看详情。')
  return lines.join('\n')
}

/** 渲染提交成功后的回执。 */
export function presentSubmitted(taskId: string, stage: string): string {
  const label = STAGE_LABEL[stage] ?? stage
  return [
    '✅ 已提交评审任务 ' + taskId + '（' + label + '）',
    '',
    '评审在后台独立进程执行，不影响当前会话。用 code_review_status 并传入 task_id 查询进度与结果。',
  ].join('\n')
}
