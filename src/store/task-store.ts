// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * task-store.ts —— 任务卡的持久化（一任务一文件，带乐观并发）。
 *
 * 为什么用文件而不是数据库：任务簿要在**没有服务端**的前提下被两个进程
 * （插件与内核）同时读写。文件 + 原子 rename 是最小可用的跨进程协议；
 * 端口、socket、数据库连接都会引入「谁先启动」的时序问题。
 *
 * 并发控制：每次写递增 revision，写前比对期望版本。
 * 不匹配说明别人改过了，此时**拒绝写入并报 STORAGE_CONCURRENT_MODIFICATION**，
 * 而不是覆盖 —— 覆盖会悄悄丢掉对方的阶段推进。
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { TASK_SCHEMA_VERSION } from '../domain/version.js'
import { KernelError } from '../domain/errors.js'
import { TERMINAL_STAGES, transition, type TaskRecord, type TaskStage, type TaskScope } from '../domain/task.js'
import { validateWith } from '../domain/validate.js'
import { readJsonOrNull, writeJsonAtomic } from './atomic.js'
import { taskPath, tasksDir } from './paths.js'

/**
 * 任务卡的最小结构约束。
 *
 * 只强制「没有它就无法理解这张卡」的字段：坏掉的卡如果被当成正常卡用，
 * 上层会读到 undefined.repoPath 之类的崩溃。其余字段靠 additionalProperties
 * 放行 —— 宁可多容忍，也不要因为加了个字段就让旧卡全部读不出来。
 */
const TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'stage', 'revision'],
  properties: {
    id: { type: 'string', minLength: 1 },
    stage: {
      type: 'string',
      enum: ['queued', 'claimed', 'preparing', 'reviewing', 'aggregating', 'reporting', 'completed', 'failed', 'cancelled', 'recovering'],
    },
    revision: { type: 'number' },
    schemaVersion: { type: 'number' },
    createdAt: { type: 'string' },
    scope: { type: 'object' },
  },
  additionalProperties: true,
}

/** 新建任务的输入。 */
export interface CreateTaskInput {
  readonly id: string
  readonly scope: TaskScope
  readonly config: Readonly<Record<string, unknown>>
  readonly requestor: { readonly sessionId: string } | null
  /** 创建时间（由调用方注入，便于测试）。 */
  readonly now: string
}

/**
 * 创建任务卡（queued）。
 * @throws KernelError(STORAGE_WRITE_FAILED) 写入失败时
 */
export function createTask(input: CreateTaskInput, dshRoot?: string): TaskRecord {
  const record: TaskRecord = {
    id: input.id,
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 0,
    stage: 'queued',
    createdAt: input.now,
    updatedAt: input.now,
    claimedAt: null,
    heartbeatAt: null,
    completedAt: null,
    owner: null,
    cancelRequested: false,
    failure: null,
    requestor: input.requestor,
    scope: input.scope,
    config: input.config,
    summary: null,
  }
  try {
    writeJsonAtomic(taskPath(input.id, dshRoot), record)
  } catch (error) {
    throw new KernelError('STORAGE_WRITE_FAILED', '创建任务卡失败：' + (error instanceof Error ? error.message : String(error)))
  }
  return record
}

/**
 * 读取任务卡；文件不存在、JSON 损坏、或结构不合法都返回 null。
 *
 * 为什么校验而不是直接 as TaskRecord：任务卡是跨进程、可被人工编辑的文件，
 * 把它当可信输入会让坏数据在很远的地方才炸（比如编排层读 scope.repoPath）。
 * 在这里拦住，失败表现为「任务不存在」，调用方有现成的处理分支。
 */
export function readTask(id: string, dshRoot?: string): TaskRecord | null {
  const raw = readJsonOrNull<unknown>(taskPath(id, dshRoot))
  if (raw === null) return null
  try {
    return validateWith<TaskRecord>('dsh-task', TASK_SCHEMA, raw)
  } catch {
    return null
  }
}

/**
 * 更新任务卡（乐观并发）。
 * @param id 任务 id
 * @param mutate 接收当前记录，返回新记录（通常用 transition）
 * @throws KernelError(STORAGE_TASK_NOT_FOUND | STORAGE_CONCURRENT_MODIFICATION | STORAGE_WRITE_FAILED)
 */
export function updateTask(id: string, mutate: (current: TaskRecord) => TaskRecord, dshRoot?: string): TaskRecord {
  const current = readTask(id, dshRoot)
  if (current === null) {
    throw new KernelError('STORAGE_TASK_NOT_FOUND', '任务不存在：' + id)
  }
  const next = mutate(current)
  // CAS：mutate 必须基于 current 的 revision 递增；若调用方擅自改了 revision 之外的东西
  // 或没递增，这里兜住
  if (next.revision <= current.revision) {
    throw new KernelError('INTERNAL_INVARIANT_VIOLATED', '更新任务卡未递增 revision：' + id)
  }
  // 写前再读一次，缩小竞态窗口（先读-改-再读-写）
  const beforeWrite = readTask(id, dshRoot)
  if (beforeWrite === null || beforeWrite.revision !== current.revision) {
    throw new KernelError('STORAGE_CONCURRENT_MODIFICATION', '任务卡被其他进程修改：' + id)
  }
  try {
    writeJsonAtomic(taskPath(id, dshRoot), next)
  } catch (error) {
    throw new KernelError('STORAGE_WRITE_FAILED', '写入任务卡失败：' + (error instanceof Error ? error.message : String(error)))
  }
  return next
}

/**
 * 推进任务阶段（常用路径的便捷封装）。
 */
export function advanceTask(
  id: string,
  to: TaskStage,
  now: string,
  patch: Partial<Pick<TaskRecord, 'failure' | 'summary' | 'owner' | 'cancelRequested'>> = {},
  dshRoot?: string,
): TaskRecord {
  return updateTask(id, (cur) => transition(cur, to, now, patch), dshRoot)
}

/**
 * 列出任务（按创建时间倒序，最新在前）。
 * @param limit 最多返回多少条（默认全部）
 */
export function listTasks(dshRoot?: string, limit?: number): TaskRecord[] {
  const dir = tasksDir(dshRoot)
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: TaskRecord[] = []
  for (const name of names) {
    const rec = readJsonOrNull<TaskRecord>(taskPath(name.slice(0, -5), dshRoot))
    if (rec !== null && typeof rec.id === 'string') out.push(rec)
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return limit === undefined ? out : out.slice(0, limit)
}

/** 删除任务卡（仅供测试与清理）。 */
export function deleteTask(id: string, dshRoot?: string): void {
  try {
    unlinkSync(taskPath(id, dshRoot))
  } catch {
    // 不存在视为已删除
  }
}

/** 确保任务目录存在。 */
export function ensureTasksDir(dshRoot?: string): void {
  mkdirSync(tasksDir(dshRoot), { recursive: true })
}

/**
 * 请求取消一个任务。
 *
 * 语义分两种情况（这是刻意的，不是简化）：
 *  - 仍在 queued：直接转 cancelled（内核还没碰它，取消是立即的）；
 *  - 已在执行：只设置 cancelRequested 标记，由内核在下一个检查点处理。
 *    标记与「已取消」是两件事 —— 把标记当结果会让用户以为线程停了，其实还在烧 token。
 *
 * @returns 更新后的记录
 */
export function requestCancellation(id: string, now: string, dshRoot?: string): TaskRecord {
  return updateTask(id, (cur) => {
    if (cur.stage === 'queued') {
      return transition(cur, 'cancelled', now, { cancelRequested: true })
    }
    if (TERMINAL_STAGES.has(cur.stage)) {
      throw new KernelError('INPUT_INVALID_ARGUMENT', '任务已结束（' + cur.stage + '），无法取消：' + id)
    }
    // 执行中：只打标记，等内核在检查点停下
    return { ...cur, cancelRequested: true, revision: cur.revision + 1, updatedAt: now }
  }, dshRoot)
}
