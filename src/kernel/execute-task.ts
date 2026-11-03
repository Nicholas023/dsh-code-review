// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * execute-task.ts —— 执行一个已认领的任务（内核侧）。
 *
 * 职责：把任务卡里的配置快照变成一次真实评审，并把结果写回去。
 *
 * 关键设计：**配置来自任务卡快照，不是重新读文件**。
 * 这样「发起时用的什么设置」和「执行时用的什么设置」永远一致 ——
 * 用户中途改设置不会让一个正在跑的任务突然换模型。
 */

import type { ConfigV2 } from '../config/defaults.js'
import { normalizeConfig } from '../config/schema.js'
import { KernelError } from '../domain/errors.js'
import type { Finding, FindingCategory, FindingSeverity } from '../domain/finding.js'
import type { TaskRecord, TaskSummary } from '../domain/task.js'
import { PROTOCOL_VERSIONS } from '../domain/version.js'
import type { LlmClientOptions } from '../llm/client.js'
import { runReview } from '../orchestrator/review.js'
import type { RunnerOptions } from '../ptc/runner-client.js'
import { fingerprint } from '../report/dedupe.js'
import { resolveLocation } from '../report/line-resolver.js'
import { renderMarkdown } from '../report/markdown.js'
import { redactDeep } from '../report/redact.js'
import type { ReviewReport } from '../report/schema.js'
import { writeReport } from '../report/writer.js'

/** 执行所需的宿主能力（便于测试注入）。 */
export interface ExecuteDeps {
  /** 解析凭据引用为明文（找不到返回 null）。 */
  readonly resolveCredential: (ref: string) => string | null
  /** node 可执行文件路径（传给 runner）。 */
  readonly nodePath: string
  /** runner 入口绝对路径。 */
  readonly runnerEntry: string
  /** 当前时间（ISO-8601）。 */
  readonly now: () => string
  /** 进度回调。 */
  readonly onProgress?: (detail: string) => void
}

/** 执行结果。 */
export interface ExecuteOutcome {
  readonly ok: boolean
  readonly summary: TaskSummary | null
  readonly failure: {
    readonly code: string
    readonly message: string
    readonly retry: 'never' | 'safe' | 'after-input-change'
    readonly effectState: 'none' | 'partial' | 'unknown'
    readonly nextAction?: string
    readonly stage: string
  } | null
  /** 报告路径（成功时）。 */
  readonly reportPath: string | null
  readonly reportJsonPath: string | null
}

/** 从任务卡 config 快照还原配置。 */
export function configOf(record: TaskRecord): ConfigV2 {
  return normalizeConfig(record.config).config
}

/** 取仓库名（用于报告子目录）。 */
export function repoNameOf(repoPath: string): string {
  const parts = repoPath.replace(/\\/g, '/').split('/').filter((p) => p !== '')
  return parts.length > 0 ? parts[parts.length - 1]! : 'repo'
}

/** 生成报告基础文件名（时间戳 + 任务 id 短号）。 */
function baseNameOf(now: string, taskId: string): string {
  const stamp = now.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  return stamp + '-' + taskId.slice(0, 8)
}

/**
 * 执行一个任务。
 * @param record 已认领的任务卡
 * @param deps   宿主能力
 */
export async function executeTask(record: TaskRecord, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const config = configOf(record)
  const startedAt = Date.now()

  // 端点 / 模型 / 凭据：缺任何一项都必须在**外呼之前**失败（红线）
  if (config.review.endpoint.trim() === '') {
    return {
      ok: false,
      summary: null,
      reportPath: null,
      reportJsonPath: null,
      failure: {
        code: 'CONFIG_MODEL_ENDPOINT_MISSING',
        message: '评审模型端点未配置',
        retry: 'after-input-change',
        effectState: 'none',
        nextAction: '在插件设置里填写评审模型的端点与凭据引用',
        stage: 'preparing',
      },
    }
  }
  const credentialRef = config.review.credentialRef.trim()
  if (credentialRef === '') {
    return {
      ok: false,
      summary: null,
      reportPath: null,
      reportJsonPath: null,
      failure: {
        code: 'CONFIG_CREDENTIAL_MISSING',
        message: '评审模型凭据引用未配置',
        retry: 'after-input-change',
        effectState: 'none',
        nextAction: '在插件设置里填写凭据引用（指向已配置的环境变量）',
        stage: 'preparing',
      },
    }
  }
  const apiKey = deps.resolveCredential(credentialRef)
  if (apiKey === null || apiKey.trim() === '') {
    return {
      ok: false,
      summary: null,
      reportPath: null,
      reportJsonPath: null,
      failure: {
        code: 'CONFIG_CREDENTIAL_MISSING',
        message: '凭据引用 ' + credentialRef + ' 未能解析出值',
        retry: 'after-input-change',
        effectState: 'none',
        nextAction: '确认该环境变量已配置且非空',
        stage: 'preparing',
      },
    }
  }

  const llm: LlmClientOptions = {
    baseUrl: config.review.endpoint,
    apiKey,
    requestTimeoutMs: config.review.requestTimeoutMs,
  }
  const runner: RunnerOptions = {
    nodePath: deps.nodePath,
    entryPath: deps.runnerEntry,
    timeoutMs: config.execution.runnerTimeoutMs,
    memoryMb: config.execution.runnerMemoryMb,
  }

  deps.onProgress?.('reviewing')
  let out
  try {
    out = await runReview({
      scope: {
        repoPath: record.scope.repoPath,
        command: record.scope.command,
        mode: record.scope.mode,
        baseRef: record.scope.baseRef,
        headRef: record.scope.headRef,
        commit: record.scope.commit,
        focus: record.scope.focus,
        excludePaths: record.scope.excludePaths,
      },
      config,
      llm,
      runner,
      ...(deps.onProgress ? { onProgress: (e) => deps.onProgress?.(e.stage) } : {}),
    })
  } catch (error) {
    const ke = error instanceof KernelError ? error : new KernelError('INTERNAL_UNEXPECTED', error instanceof Error ? error.message : String(error))
    return {
      ok: false,
      summary: null,
      reportPath: null,
      reportJsonPath: null,
      failure: { ...ke.toJSON(), stage: 'reviewing' },
    }
  }
  const elapsedSec = (Date.now() - startedAt) / 1000

  // 收敛 finding：行号定位 + 指纹
  deps.onProgress?.('aggregating')
  const findings: Finding[] = out.findings.map((raw, i) => {
    const resolved = resolveLocation(undefined, raw.line, raw.evidence)
    return {
      id: 'f-' + String(i + 1),
      path: raw.path,
      lineStart: raw.line,
      lineEnd: raw.line,
      lineSource: resolved.lineSource,
      category: raw.category as FindingCategory,
      severity: raw.severity as FindingSeverity,
      title: raw.title,
      evidence: raw.evidence,
      explanation: raw.explanation,
      recommendation: raw.recommendation,
      confidence: raw.confidence,
      sourceAgent: 'main',
      sourceTask: null,
      ruleIds: [],
      status: 'confirmed',
      suppressionReason: null,
      fingerprint: fingerprint(raw.path, raw.line, raw.category, raw.evidence),
    }
  })

  // 组装报告
  const generatedAt = deps.now()
  const endpointHost = (() => {
    try {
      return new URL(config.review.endpoint).host
    } catch {
      return config.review.endpoint
    }
  })()
  const report: ReviewReport = {
    schemaVersion: 1,
    generatedAt,
    run: {
      taskId: record.id,
      kernelVersion: '0.2.0',
      protocolVersion: PROTOCOL_VERSIONS.kernel,
    },
    model: { id: config.review.model, endpointHost },
    repository: {
      path: record.scope.repoPath,
      command: record.scope.command,
      mode: record.scope.mode,
      baseRef: record.scope.baseRef,
      headRef: record.scope.headRef,
      commit: record.scope.commit,
    },
    hashes: { systemPrompt: null },
    status: out.status,
    findings,
    sensitiveFiles: out.sensitiveFiles,
    excluded: out.excluded.map((e) => ({ path: e.path, reason: e.reason, detail: e.detail })),
    coverage: out.coverage,
    sizing: out.sizing,
    agents: out.agentStops.map((a) => ({ name: a.agent, stopReason: a.stopReason, rounds: a.rounds })),
    usage: out.usage,
    warnings: out.warnings,
    elapsedSec,
  }

  // 输出前统一脱敏（报告自身不能成为泄露载体）
  const safeReport = redactDeep(report)

  deps.onProgress?.('reporting')
  const written = writeReport({
    directory: config.report.directory,
    repoName: repoNameOf(record.scope.repoPath),
    baseName: baseNameOf(generatedAt, record.id),
    markdown: config.report.writeMarkdown ? renderMarkdown(safeReport) : null,
    json: config.report.writeJson ? JSON.stringify(safeReport, null, 2) + '\n' : null,
  })

  const severityCounts: Record<string, number> = {}
  for (const f of findings) severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1

  return {
    ok: out.status !== 'failed',
    summary: {
      reportPath: written.markdownPath,
      reportJsonPath: written.jsonPath,
      findingCount: findings.length,
      severityCounts,
      coverage: out.coverage,
      usage: {
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        cacheReadTokens: out.usage.cacheReadTokens,
        requests: out.usage.requests,
        agents: out.usage.agents,
      },
      elapsedSec,
    },
    reportPath: written.markdownPath,
    reportJsonPath: written.jsonPath,
    failure: written.errors.length > 0
      ? {
          code: 'STORAGE_WRITE_FAILED',
          message: written.errors.join('；'),
          retry: 'safe',
          effectState: 'partial',
          stage: 'reporting',
        }
      : null,
  }
}
