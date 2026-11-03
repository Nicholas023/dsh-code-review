// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * serve.ts —— 内核主循环（单例、认领、执行、空闲退出）。
 *
 * 生命周期：
 *   启动 → 抢锁（失败说明已有内核在跑，直接退出）→ 写 info
 *        → 循环：找 queued → CAS 认领 → 执行 → 写回状态
 *        → 空闲超过阈值 → 释放锁 → 退出
 *
 * 为什么需要「空闲退出」：插件是常驻的，但内核不是必需的。
 * 没人用的时候让它退出，能省内存也少一个可能出问题的进程；
 * 有任务时插件会重新拉起它。
 *
 * 崩溃恢复：认领时写 claimedAt + heartbeatAt。若内核在 reviewing 阶段被杀，
 * 任务会停在非终态且心跳过期，下次启动时判定为 recovering。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { KernelError } from '../domain/errors.js'
import { isHeartbeatStale, RUNNING_STAGES, TERMINAL_STAGES, transition, type TaskRecord } from '../domain/task.js'
import { listTasks, readTask, updateTask } from '../store/task-store.js'
import { executeTask, type ExecuteDeps } from './execute-task.js'
import { isPidAlive, readLock, releaseLock, tryAcquireLock, writeKernelInfo } from './lock.js'

/** 内核运行选项。 */
export interface ServeOptions {
  readonly dshRoot?: string
  /** 空闲多久后退出（毫秒，默认 10 分钟）。 */
  readonly idleExitMs?: number
  /** 轮询间隔（毫秒，默认 1 秒）。 */
  readonly pollIntervalMs?: number
  /** 心跳多久算过期（毫秒，默认 5 分钟）。 */
  readonly staleMs?: number
  /** 执行依赖。 */
  readonly deps: ExecuteDeps
  /** 日志输出（默认 console）。 */
  readonly log?: (line: string) => void
  /** 单轮之后是否继续（测试用：false 表示跑完一轮就返回）。 */
  readonly once?: boolean
}

/** 内核运行结果。 */
export interface ServeResult {
  readonly reason: 'idle-exit' | 'once' | 'lock-held' | 'stopped'
  readonly processed: number
}

/**
 * 认领一个 queued 任务（CAS：只有仍处于 queued 且 revision 未变才能抢到）。
 * @returns 认领后的记录；没有可认领的返回 null
 */
export function claimNextTask(ownerNonce: string, now: string, dshRoot?: string, staleMs = 5 * 60_000): TaskRecord | null {
  const tasks = listTasks(dshRoot)
  const nowMs = Date.parse(now)
  for (const t of tasks) {
    // ① 正常的 queued：直接抢
    if (t.stage === 'queued') {
      try {
        return updateTask(t.id, (cur) => {
          if (cur.stage !== 'queued') throw new KernelError('STORAGE_CONCURRENT_MODIFICATION', '任务已被他人认领')
          return transition(cur, 'claimed', now, { owner: ownerNonce })
        }, dshRoot)
      } catch {
        // 被别的内核抢了，继续看下一个
        continue
      }
    }
    // ② 心跳过期的进行中任务：判定为需要恢复
    if (RUNNING_STAGES.has(t.stage) && isHeartbeatStale(t.heartbeatAt, nowMs, staleMs)) {
      try {
        return updateTask(t.id, (cur) => {
          if (!RUNNING_STAGES.has(cur.stage)) throw new KernelError('STORAGE_CONCURRENT_MODIFICATION', '任务状态已变化')
          // 进入 recovering，由执行逻辑决定从哪继续（当前版本重跑）
          return transition(cur, 'recovering', now, { owner: ownerNonce })
        }, dshRoot)
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * 跑一个任务到终态。
 */
export async function runClaimedTask(record: TaskRecord, deps: ExecuteDeps, dshRoot?: string): Promise<TaskRecord> {
  const nowOf = deps.now
  let current = record

  // 从 recovering/claimed 推进到 preparing
  current = updateTask(current.id, (cur) => transition(cur, 'preparing', nowOf()), dshRoot)
  current = updateTask(current.id, (cur) => transition(cur, 'reviewing', nowOf()), dshRoot)

  const outcome = await executeTask(current, deps)

  if (!outcome.ok) {
    // 收窄到局部常量，避免闭包里重复判定 null
    const f = outcome.failure
    const failure = f === null
      ? { code: 'INTERNAL_UNEXPECTED' as const, message: '执行失败但未给原因', retry: 'never' as const, effectState: 'unknown' as const, stage: current.stage }
      : {
          code: f.code as never,
          message: f.message,
          retry: f.retry,
          effectState: f.effectState,
          ...(f.nextAction === undefined ? {} : { nextAction: f.nextAction }),
          stage: f.stage as never,
        }
    return updateTask(current.id, (cur) => transition(cur, 'failed', nowOf(), { failure }), dshRoot)
  }

  current = updateTask(current.id, (cur) => transition(cur, 'aggregating', nowOf()), dshRoot)
  current = updateTask(current.id, (cur) => transition(cur, 'reporting', nowOf()), dshRoot)
  const partialFailure = outcome.failure
  if (partialFailure !== null) {
    // 报告写了但有问题（比如 JSON 写失败）：算部分成功，明确标出来
    return updateTask(current.id, (cur) => transition(cur, 'failed', nowOf(), {
      summary: outcome.summary,
      failure: {
        code: partialFailure.code as never,
        message: partialFailure.message,
        retry: partialFailure.retry,
        effectState: partialFailure.effectState,
        stage: partialFailure.stage as never,
      },
    }), dshRoot)
  }
  return updateTask(current.id, (cur) => transition(cur, 'completed', nowOf(), { summary: outcome.summary }), dshRoot)
}

/**
 * 启动内核主循环。
 */
export async function serve(opts: ServeOptions): Promise<ServeResult> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const idleExitMs = opts.idleExitMs ?? 10 * 60_000
  const pollIntervalMs = opts.pollIntervalMs ?? 1000
  const staleMs = opts.staleMs ?? 5 * 60_000
  const nonce = randomUUID()
  const startedAt = opts.deps.now()

  const lock = tryAcquireLock({ pid: process.pid, nonce, startedAt }, opts.dshRoot, { staleMs })
  if (lock === null) {
    log('[codecheck] 已有内核实例在运行，本实例退出')
    return { reason: 'lock-held', processed: 0 }
  }
  writeKernelInfo({ pid: process.pid, nonce, startedAt, version: '0.2.0' }, opts.dshRoot)

  let stopped = false
  const onSignal = (): void => { stopped = true }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let processed = 0
  let lastActiveMs = Date.now()
  let result: ServeResult = { reason: 'stopped', processed }

  try {
    for (;;) {
      if (stopped) { result = { reason: 'stopped', processed }; break }

      const claimed = claimNextTask(nonce, opts.deps.now(), opts.dshRoot, staleMs)
      if (claimed === null) {
        if (opts.once === true) { result = { reason: 'once', processed }; break }
        if (Date.now() - lastActiveMs > idleExitMs) {
          result = { reason: 'idle-exit', processed }
          break
        }
        await new Promise<void>((r) => setTimeout(r, pollIntervalMs))
        continue
      }

      lastActiveMs = Date.now()
      log('[codecheck] 认领任务 ' + claimed.id)
      try {
        const done = await runClaimedTask(claimed, opts.deps, opts.dshRoot)
        processed += 1
        log('[codecheck] 任务 ' + done.id + ' → ' + done.stage)
      } catch (error) {
        processed += 1
        log('[codecheck] 任务 ' + claimed.id + ' 执行异常：' + (error instanceof Error ? error.message : String(error)))
      }
      if (opts.once === true) { result = { reason: 'once', processed }; break }
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    releaseLock(nonce, opts.dshRoot)
  }

  return result
}

/** 判断是否已有存活内核（插件侧用于决定要不要拉起）。 */
export function isKernelAlive(dshRoot?: string): boolean {
  const lock = readLock(dshRoot)
  if (lock === null) return false
  return isPidAlive(lock.pid)
}

/** 供调试：判断某任务是否处于终态。 */
export function isTerminalTask(record: TaskRecord): boolean {
  return TERMINAL_STAGES.has(record.stage)
}

/** 读取并判断任务是否存在（供 CLI）。 */
export function taskExists(id: string, dshRoot?: string): boolean {
  return existsSync(String(readTask(id, dshRoot)?.id))
}
