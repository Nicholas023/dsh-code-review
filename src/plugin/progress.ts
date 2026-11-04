// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * progress.ts —— 评审进度的落地与读取（供 GUI 展示）。
 *
 * 为什么需要它：内核是独立进程，而且拉起时 stdio 是 'ignore'，
 * 它的所有 console 输出都被丢弃。用户（和运维者）在评审跑 14 分钟时只能看到一个
 * 不会动的「评审中」，既不知道第几轮，也不知道花了多少。
 *
 * 形态：<pluginRoot>/progress/<taskId>.json，每个任务一个文件，原子写。
 * 为什么不用任务卡：任务卡是权威状态（阶段机、迁移校验都在那儿），
 * 进度是高频易变数据，混写会让权威文件反复落盘、也让不变量变复杂。
 *
 * 全部函数都接受显式 root，便于测试；不传时退回 resolveDshRoot()。
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../store/atomic.js'
import { pluginRoot, resolveDshRoot } from '../store/paths.js'

/** 一份进度快照（字段都可缺，缺表示"还没到那一步"）。 */
export interface ProgressSnapshot {
  readonly taskId: string
  readonly repoPath: string
  readonly command: string
  readonly mode: string | null
  /** 粗阶段：queued / collecting / reviewing / aggregating / reporting / completed / failed。 */
  readonly stage: string
  /** 细分说明，例如 'round 5/8'、'扫描 493 个文件'。 */
  readonly detail: string | null
  /** 主 agent 当前轮次（可选）。 */
  readonly round: number | null
  /** 轮次上限（可选）。 */
  readonly maxRounds: number | null
  /** 开始时间（ISO）。 */
  readonly startedAt: string
  /** 最后更新时间（ISO）。 */
  readonly updatedAt: string
}

/** 进度目录。 */
export function progressDir(root: string = resolveDshRoot()): string {
  return join(pluginRoot(root), 'progress')
}

/** 单个任务的进度文件路径（id 只允许安全字符）。 */
export function progressPath(taskId: string, root: string = resolveDshRoot()): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(progressDir(root), safe + '.json')
}

/**
 * 写入一份进度快照。
 * 失败不抛：进度是"锦上添花"，它坏了不能影响评审本身。
 */
export function writeProgress(snapshot: ProgressSnapshot, root: string = resolveDshRoot()): void {
  try {
    writeJsonAtomic(progressPath(snapshot.taskId, root), snapshot)
  } catch {
    // 忽略：磁盘满/权限问题不该让评审失败
  }
}

/** 读取全部进度快照，按更新时间倒序。目录不存在时返回空数组。 */
export function readAllProgress(root: string = resolveDshRoot()): ProgressSnapshot[] {
  let names: string[]
  try {
    names = readdirSync(progressDir(root)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: ProgressSnapshot[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(progressDir(root), name), 'utf8')) as ProgressSnapshot
      if (typeof raw?.taskId === 'string') out.push(raw)
    } catch {
      // 半截文件/损坏文件跳过
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** 删除某个任务的进度文件（任务结束时若不想保留历史）。 */
export function removeProgress(taskId: string, root: string = resolveDshRoot()): void {
  try { rmSync(progressPath(taskId, root), { force: true }) } catch { /* 忽略 */ }
}

/**
 * 只保留最近 N 条进度文件，其余删除。
 * 为什么需要：每个任务一个文件，长期运行会堆积成千上万个小文件。
 * @param keep 保留条数（按更新时间倒序）
 */
export function pruneProgress(keep = 20, root: string = resolveDshRoot()): number {
  const all = readAllProgress(root)
  let removed = 0
  for (const snapshot of all.slice(keep)) {
    removeProgress(snapshot.taskId, root)
    removed += 1
  }
  return removed
}
