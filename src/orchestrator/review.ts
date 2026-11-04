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
import { collectReviewDiff, listScanFiles, synthesizeWholeFile } from '../git/diff.js'
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
import { resolveLocation } from '../report/line-resolver.js'

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

/**
 * 决定本次评审的规模档位。
 *
 * 历史：scan 曾经被**无条件**判为大档，因为那时 scan 的文件没有 hunk，
 * estimateFileTokens 恒为 0，不强制就会被判成小档 → 模型拿不到工具也拿不到正文 → 盲审。
 *
 * 现在 scan 会把文件整份合成（见本文件上方 scan 分支），体积是真实的，
 * 于是「小仓库给正文、大仓库给清单 + 工具」这条正常规则对 scan 同样成立。
 * 强制大档反而有害：一个 2 文件的小仓库也要多花几轮去 read，白白烧预算。
 * @param command 评审模式（保留参数以便将来再分叉，当前两种模式规则一致）
 */
export function decideTier(command: 'review' | 'scan', totalTokens: number, thresholds: SizingThresholds): SizeTier {
  void command
  return classifySize(totalTokens, thresholds)
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
    // scan 没有 diff，所以把受支持的文件**整份**合成为「新增」，得到真实体积与内容。
    //
    // 为什么不能只给空清单（0.2.0 早期的写法，实机踩过）：
    //   estimateFileTokens 只统计 hunk 行 → 每个文件恒为 0 →
    //   ① 报表「规模 0 tokens」；
    //   ② classifySize 必然小档，当年靠「scan 强制大档」打补丁；
    //   ③ 单文件超限过滤形同虚设（maxFileTokens 永远不触发）；
    //   ④ 任务提示词里「变更内容」是空的，文件清单写着 +0 -0，模型没有任何体积信号，
    //      只能一轮读一个文件，很快撞上轮次上限 —— 表现为「评审没跑完但报 0 个问题」。
    //
    // 不受支持的扩展名仍然只留占位，让筛选层把它们干净地记进 excluded（不读盘）。
    for (const path of listed.files) {
      const supported = SUPPORTED_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))
      if (!supported) {
        files.push({ oldPath: path, newPath: path, status: 'modified', hunks: [], additions: 0, deletions: 0 })
        continue
      }
      const made = synthesizeWholeFile(scope.repoPath, path)
      if (made.warning !== null) warnings.push(made.warning)
      if (made.diff !== null) files.push(made.diff)
    }
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
  const tier = decideTier(scope.command, totalTokens, t)
  const policy = mainAgentPolicy(tier)
  input.onProgress?.({ stage: 'sizing', detail: tier + ' / ' + String(totalTokens) + ' tokens' })

  // 大档：主 agent 只拿清单、不拿正文（否则上下文直接爆），
  // 正文它可以自己用 tools.read 按需取。
  const mainFiles = policy.depth === 'outline'
    ? selection.selected.map((f) => ({ ...f, hunks: [] }))
    : selection.selected

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

  // 打来源标记：主 agent 归 main，子 agent 归 child-<n>。
  // 不标的话，报告里所有问题看起来都是主 agent 发现的，调子任务这件事就无从追溯。
  const findings: RawFinding[] = main.result.findings.map((f) => ({ ...f, sourceAgent: 'main', sourceTask: null }))

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
    findings.push(...child.result.findings.map((f) => ({
      ...f,
      sourceAgent: 'child-' + String(childIndex),
      sourceTask: reason,
    })))
  }

  // ── 5.5 行号定位 ──
  // 只有这里同时握有「模型给的行号」和「真实 diff」，所以定位只能在这里做。
  // 交给执行层（它看不到 diff）会导致每条发现都被标成 unresolved。
  const diffByPath = new Map<string, FileDiff>()
  for (const f of selection.selected) diffByPath.set(f.newPath.replace(/\\/g, '/'), f)
  const locatedFindings: RawFinding[] = findings.map((f) => {
    const diff = diffByPath.get(f.path.replace(/\\/g, '/'))
    const loc = resolveLocation(diff, f.line, f.evidence)
    return {
      ...f,
      line: loc.lineStart ?? f.line,
      lineSource: loc.lineSource,
    }
  })

  // ── 6. 汇总 ──
  const stats = summarizeDiff(selection.selected)
  const status = main.stopReason === 'finished' ? 'completed' : 'partial'
  if (status === 'partial') {
    warnings.push('主 agent 未正常完成（' + main.stopReason + '），结果可能不完整')
  }

  return {
    status,
    findings: locatedFindings,
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
