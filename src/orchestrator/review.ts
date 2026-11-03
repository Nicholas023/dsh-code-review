// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * review.ts —— 一次评审的总编排。
 *
 * 这是把确定性层、prompt、LLM、agent 循环、子 agent 全部串起来的地方。
 * 流程：
 *   1. 取 diff（git）
 *   2. 筛文件（selection）
 *   3. 算规模 → 定档位 → 定主 agent 深度
 *   4. 主 agent 跑一轮（可能产出 childRequests）
 *   5. 按「确定性规则 + 主 agent 请求」派子 agent
 *   6. 合并结果
 *
 * 错误处理原则：**任何一步失败都要能说清是哪一步**。
 * 静默返回空结果是最坏的结果 —— 用户会以为「没问题」。
 */

import type { ConfigV2 } from '../config/defaults.js'
import type { ReviewScope, SizeTier } from '../domain/review.js'
import { classifySize, evaluateDispatch, mainAgentPolicy, needsFurtherSplit, type SizingThresholds } from '../domain/review.js'
import { collectReviewDiff, listScanFiles } from '../git/diff.js'
import type { FileDiff } from '../git/diff-parser.js'
import { summarizeDiff } from '../git/diff-parser.js'
import type { LlmClientOptions } from '../llm/client.js'
import type { RunnerOptions } from '../ptc/runner-client.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { buildTaskPrompt } from '../prompt/task.js'
import { resolveRules } from '../prompt/rules.js'
import { selectFiles, estimateFileTokens, type ExcludedFile } from '../selection/select.js'
import { runAgentLoop } from '../agent/loop.js'
import type { RawFinding } from '../agent/result-parser.js'

/** 编排输入。 */
export interface ReviewInput {
  readonly scope: ReviewScope
  readonly config: ConfigV2
  /** LLM 连接（端点/key 已解析）。 */
  readonly llm: LlmClientOptions
  /** runner 配置。 */
  readonly runner: RunnerOptions
  /** 进度回调。 */
  readonly onProgress?: (event: { stage: string; detail?: string }) => void
}

/** 编排结果。 */
export interface ReviewOutput {
  readonly status: 'completed' | 'partial' | 'failed'
  readonly findings: readonly RawFinding[]
  /** 敏感文件（内容未审，必须点名）。 */
  readonly sensitiveFiles: readonly string[]
  /** 被排除的文件及原因。 */
  readonly excluded: readonly ExcludedFile[]
  /** 覆盖统计。 */
  readonly coverage: { readonly reviewed: number; readonly total: number }
  /** 规模信息。 */
  readonly sizing: { readonly tier: SizeTier; readonly totalTokens: number; readonly fileCount: number }
  /** 用量汇总。 */
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly requests: number
    readonly agents: number
  }
  /** 各 agent 的停止原因（可追溯）。 */
  readonly agentStops: readonly { readonly agent: string; readonly stopReason: string; readonly rounds: number }[]
  /** 警告与诊断（进报告的「未覆盖」段）。 */
  readonly warnings: readonly string[]
  readonly error: string | null
}

/** 从配置取规模阈值。 */
function thresholdsOf(config: ConfigV2): SizingThresholds {
  return config.sizing
}

/** 支持的扩展名（首发集合，与 rules.ts 对齐）。 */
const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.java', '.kt', '.json', '.md']

/**
 * 执行一次完整评审。
 */
export async function runReview(input: ReviewInput): Promise<ReviewOutput> {
  const { scope, config } = input
  const warnings: string[] = []
  const agentStops: { agent: string; stopReason: string; rounds: number }[] = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0, agents: 0 }

  // ── 1. 取 diff / 枚举文件 ──
  input.onProgress?.({ stage: 'collect' })
  let files: FileDiff[] = []
  if (scope.command === 'scan') {
    const listed = await listScanFiles(scope.repoPath)
    warnings.push(...listed.warnings)
    // scan 没有 diff：把每个文件当作「新增」处理会失真，所以这里只取文件清单，
    // 内容由子 agent 通过 read 工具按需读取（见下方 large 档策略）。
    files = listed.files.map((path) => ({
      oldPath: path,
      newPath: path,
      status: 'modified' as const,
      hunks: [],
      additions: 0,
      deletions: 0,
    }))
  } else {
    const collected = await collectReviewDiff(scope.repoPath, scope)
    warnings.push(...collected.warnings)
    files = [...collected.parsed.files]
  }

  // ── 2. 筛选 ──
  input.onProgress?.({ stage: 'select', detail: String(files.length) + ' 个文件' })
  const selection = selectFiles(files, {
    excludePaths: scope.excludePaths,
    maxFileTokens: config.sizing.childTokensMax * 4,
    supportedExtensions: SUPPORTED_EXTENSIONS,
  })

  if (selection.selected.length === 0) {
    return {
      status: 'completed',
      findings: [],
      sensitiveFiles: selection.sensitive,
      excluded: selection.excluded,
      coverage: { reviewed: 0, total: files.length },
      sizing: { tier: 'small', totalTokens: 0, fileCount: 0 },
      usage,
      agentStops,
      warnings,
      error: null,
    }
  }

  // ── 3. 算规模与档位 ──
  const t = thresholdsOf(config)
  const totalTokens = selection.selected.reduce((sum, f) => sum + estimateFileTokens(f), 0)
  const tier = classifySize(totalTokens, t)
  const policy = mainAgentPolicy(tier)
  input.onProgress?.({ stage: 'sizing', detail: tier + ' / ' + String(totalTokens) + ' tokens' })

  // 大档 + scan：主 agent 不拿正文（否则上下文直接爆）
  const mainFiles = policy.depth === 'outline' ? [] : selection.selected

  // ── 4. 主 agent ──
  const rules = resolveRules(selection.selected.map((f) => f.newPath))
  const system = buildSystemPrompt({ rules, depth: policy.depth })
  const task = buildTaskPrompt({
    files: mainFiles,
    focus: scope.focus,
    scopeNote: scope.command === 'scan' ? '全仓扫描' : '本次变更评审',
  })

  input.onProgress?.({ stage: 'main-agent' })
  usage.agents += 1
  const main = await runAgentLoop({
    llm: input.llm,
    model: config.review.model,
    system,
    task,
    root: scope.repoPath,
    maxRounds: config.budget.maxAgentRounds,
    maxInputTokens: config.budget.maxInputTokens,
    maxOutputTokens: config.budget.maxOutputTokens,
    runner: input.runner,
    tools: policy.sdk ? ['read', 'glob', 'grep'] : [],
    ...(input.onProgress ? { onProgress: (e) => input.onProgress?.({ stage: 'main-agent', detail: 'round ' + String(e.round) }) } : {}),
  })
  agentStops.push({ agent: 'main', stopReason: main.stopReason, rounds: main.rounds })
  usage.inputTokens += main.usage.inputTokens
  usage.outputTokens += main.usage.outputTokens
  usage.cacheReadTokens += main.usage.cacheReadTokens
  usage.requests += main.usage.requests
  warnings.push(...main.result.issues)
  if (main.error !== null) warnings.push('主 agent 失败：' + main.error.message)

  const findings: RawFinding[] = [...main.result.findings]

  // ── 5. 派子 agent ──
  // 确定性规则打底 + 主 agent 追加（用户拍板 C）
  const dispatchTargets = new Map<string, string[]>()
  for (const f of selection.selected) {
    const decision = evaluateDispatch(
      {
        path: f.newPath,
        changedLines: f.additions + f.deletions,
        diffTokens: estimateFileTokens(f),
        sensitive: false, // 敏感文件已被筛选层排除，不会到这里
        crossCutting: /\.(d\.ts|json|ya?ml|toml)$/.test(f.newPath) || /(^|\/)(types|interfaces|api)\//.test(f.newPath),
      },
      t,
    )
    if (decision.dispatch) {
      const key = decision.reasons.join('；')
      const bucket = dispatchTargets.get(key) ?? []
      bucket.push(f.newPath)
      dispatchTargets.set(key, bucket)
    }
  }
  // 主 agent 追加的请求
  for (const req of main.result.childRequests) {
    const existing = dispatchTargets.get('主 agent 要求深挖：' + req.question) ?? []
    dispatchTargets.set('主 agent 要求深挖：' + req.question, [...new Set([...existing, ...req.files])])
  }

  // 子 agent 数量上限
  const maxChildren = Math.min(config.budget.maxChildren, dispatchTargets.size)
  let childIndex = 0
  for (const [reason, paths] of dispatchTargets) {
    if (childIndex >= maxChildren) {
      warnings.push('子 agent 数量达到上限 ' + String(maxChildren) + '，剩余深挖请求未执行：' + reason)
      break
    }
    childIndex += 1
    const childFiles = selection.selected.filter((f) => paths.includes(f.newPath))
    if (childFiles.length === 0) continue

    const childTokens = childFiles.reduce((sum, f) => sum + estimateFileTokens(f), 0)
    if (needsFurtherSplit(childTokens, t)) {
      warnings.push('子任务 ' + reason + ' 仍超过 ' + String(t.childTokensMax) + ' tokens，本次未进一步切分')
    }

    input.onProgress?.({ stage: 'child-agent', detail: reason })
    usage.agents += 1
    const childSystem = buildSystemPrompt({ rules: resolveRules(childFiles.map((f) => f.newPath)), depth: 'global' })
    const childTask = buildTaskPrompt({
      files: childFiles,
      focus: scope.focus,
      scopeNote: '子任务：' + reason,
      question: '重点排查这几处：' + reason,
    })
    const child = await runAgentLoop({
      llm: input.llm,
      model: config.review.model,
      system: childSystem,
      task: childTask,
      root: scope.repoPath,
      maxRounds: config.budget.maxAgentRounds,
      maxInputTokens: config.budget.maxInputTokens,
      maxOutputTokens: config.budget.maxOutputTokens,
      runner: input.runner,
      tools: ['read', 'glob', 'grep'],
    })
    agentStops.push({ agent: 'child-' + String(childIndex), stopReason: child.stopReason, rounds: child.rounds })
    usage.inputTokens += child.usage.inputTokens
    usage.outputTokens += child.usage.outputTokens
    usage.cacheReadTokens += child.usage.cacheReadTokens
    usage.requests += child.usage.requests
    warnings.push(...child.result.issues)
    findings.push(...child.result.findings)
  }

  // ── 6. 汇总 ──
  const stats = summarizeDiff(selection.selected)
  const status = main.stopReason === 'finished' ? 'completed' : 'partial'
  if (status === 'partial') {
    warnings.push('主 agent 未正常完成（' + main.stopReason + '），结果可能不完整')
  }

  return {
    status,
    findings,
    sensitiveFiles: selection.sensitive,
    excluded: selection.excluded,
    coverage: { reviewed: selection.selected.length, total: files.length },
    sizing: { tier, totalTokens, fileCount: stats.fileCount },
    usage,
    agentStops,
    warnings,
    error: main.error === null ? null : main.error.message,
  }
}
