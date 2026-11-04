// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * webapi.ts —— 给浏览器半区用的两个 HTTP 接口。
 *
 * 为什么走 webServer 而不是 remote/typert：
 *   本机的 mac-tunnel / dsh-opencode-ip-guard 已经证明这条路可行且最简单——
 *   宿主侧 ctx.webServer.register 挂一个 exact 路由，客户端直接 fetch。
 *   不需要生成描述符，也不引入新的依赖。
 *
 * 两个接口：
 *   GET  /api/code-review/progress  → 最近若干条任务的进度（倒序）
 *   POST /api/code-review/cancel    → { taskId } 请求取消
 *
 * 安全边界：只读进度文件 + 取消任务，**不返回任何绝对路径以外的敏感信息**，
 * 也不提供"打开文件/执行命令"这类能力。
 */

import { readAllProgress, type ProgressSnapshot } from './progress.js'
import { listTasks, requestCancellation } from '../store/task-store.js'
import { resolveDshRoot } from '../store/paths.js'

/** 路由前缀。 */
export const API_PREFIX = '/api/code-review'

/** 一条给界面看的数据。 */
export interface ProgressItem {
  readonly taskId: string
  readonly repoPath: string
  readonly command: string
  readonly mode: string | null
  readonly stage: string
  readonly detail: string | null
  readonly round: number | null
  readonly maxRounds: number | null
  readonly startedAt: string
  readonly updatedAt: string
  /** 已经不在进度文件里（进程重启后）时，用任务卡补上的终态。 */
  readonly finished: boolean
  readonly reportPath: string | null
  readonly findingCount: number | null
}

/** 判断是不是"还在跑"的阶段。 */
export function isRunningStage(stage: string): boolean {
  return !['completed', 'failed', 'cancelled'].includes(stage)
}

/**
 * 合并进度快照与任务卡，产出界面要的列表。
 * @param snapshots 进度文件读到的快照（倒序）
 * @param cards     任务卡（用于补终态与报告路径）
 * @param limit     最多返回几条
 */
export function buildProgressItems(
  snapshots: readonly ProgressSnapshot[],
  cards: ReadonlyArray<{ id: string; stage: string; summary: unknown }>,
  limit = 5,
): ProgressItem[] {
  const byId = new Map(cards.map((c) => [c.id, c]))
  return snapshots.slice(0, limit).map((s) => {
    const card = byId.get(s.taskId)
    const summary = card?.summary as { reportPath?: string | null; findingCount?: number } | undefined
    return {
      taskId: s.taskId,
      repoPath: s.repoPath,
      command: s.command,
      mode: s.mode,
      stage: s.stage,
      detail: s.detail,
      round: s.round,
      maxRounds: s.maxRounds,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      finished: !isRunningStage(s.stage) || (card !== undefined && !isRunningStage(card.stage)),
      reportPath: summary?.reportPath ?? null,
      findingCount: summary?.findingCount ?? null,
    }
  })
}

/** 读进度 + 任务卡，返回可直接 JSON 化的列表。 */
export function currentProgress(limit = 5): ProgressItem[] {
  const root = resolveDshRoot()
  const snapshots = readAllProgress(root)
  const cards = listTasks(root, 50).map((c) => ({ id: c.id, stage: c.stage, summary: c.summary }))
  return buildProgressItems(snapshots, cards, limit)
}

/**
 * 注册路由。
 * @param webServer 宿主的 webServer 服务
 * @param logger    可选日志
 */
export function registerWebApi(
  webServer: {
    register: (route: {
      kind: 'exact'
      path: string
      handler: (req: unknown, res: unknown) => void
    }) => () => void
  },
  logger?: { warn?: (m: string) => void },
): Array<() => void> {
  const disposers: Array<() => void> = []

  try {
    disposers.push(webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/progress',
      handler: (_req: unknown, res: any) => {
        try {
          res.setHeader?.('content-type', 'application/json')
          res.end?.(JSON.stringify({ ok: true, tasks: currentProgress(5) }))
        } catch (error) {
          res.statusCode = 500
          res.end?.(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }))
  } catch (error) {
    logger?.warn?.('[dsh-code-review] 注册进度路由失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    disposers.push(webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/cancel',
      handler: (req: any, res: any) => {
        res.setHeader?.('content-type', 'application/json')
        // 只接受 POST：GET 不应该有副作用
        if (req?.method !== 'POST') {
          res.statusCode = 405
          res.end?.(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let body = ''
        req.on?.('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
        req.on?.('end', () => {
          try {
            const parsed = JSON.parse(body) as { taskId?: unknown }
            const taskId = typeof parsed.taskId === 'string' ? parsed.taskId.trim() : ''
            if (taskId === '') {
              res.statusCode = 400
              res.end?.(JSON.stringify({ ok: false, error: 'taskId required' }))
              return
            }
            requestCancellation(taskId, new Date().toISOString(), resolveDshRoot())
            res.end?.(JSON.stringify({ ok: true }))
          } catch (error) {
            res.statusCode = 400
            res.end?.(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        })
      },
    }))
  } catch (error) {
    logger?.warn?.('[dsh-code-review] 注册取消路由失败：' + (error instanceof Error ? error.message : String(error)))
  }

  return disposers
}
