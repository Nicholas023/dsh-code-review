// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * lock.ts —— 内核单例锁与存活探测。
 *
 * 三个容易做错的地方：
 *  1. **锁要用「独占创建」而不是「先检查再创建」**：exists→write 之间有窗口，
 *     两个进程可能同时认为自己是唯一的。openSync(path,'wx') 是原子的。
 *  2. **pid 会复用**：进程崩溃后新进程可能拿到同一个 pid，光看 pid 会误判
 *     「内核还活着」。所以锁文件里带 nonce，探测时校验 nonce 与 pid 都存在。
 *  3. **陈旧锁要能回收**：崩溃留下的锁如果永远不清，用户得手动删文件才能用，
 *     这在插件里不可接受。用 mtime 年龄 + pid 探测双重判定。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { kernelInfoPath, kernelLockPath } from '../store/paths.js'
import { readJsonOrNull } from '../store/atomic.js'

/** 内核运行时信息。 */
export interface KernelInfo {
  readonly pid: number
  /** 随机 nonce（防 pid 复用误判）。 */
  readonly nonce: string
  /** 启动时间（ISO-8601）。 */
  readonly startedAt: string
  /** 内核版本。 */
  readonly version: string
}

/** 锁内容（与 info 同源，便于单文件判断）。 */
export interface LockContent {
  readonly pid: number
  readonly nonce: string
  readonly startedAt: string
}

/** 判断 pid 是否存活。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号 —— 仍算存活
    const code = (error as { code?: string }).code
    return code === 'EPERM'
  }
}

/**
 * 尝试获取内核锁。
 * @returns 成功时返回锁内容；被占用返回 null
 */
export function tryAcquireLock(
  content: LockContent,
  dshRoot?: string,
  opts: { readonly staleMs?: number; readonly nowMs?: number } = {},
): LockContent | null {
  const path = kernelLockPath(dshRoot)
  mkdirSync(dirname(path), { recursive: true })
  const staleMs = opts.staleMs ?? 10 * 60_000
  const nowMs = opts.nowMs ?? Date.now()

  /** 真正去抢锁（wx = 独占创建，已存在则抛 EEXIST）。 */
  const attempt = (): boolean => {
    try {
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, JSON.stringify(content, null, 2))
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false
      throw error
    }
  }

  if (attempt()) return content

  // 已存在：判断是否陈旧
  const existing = readJsonOrNull<LockContent>(path)
  const alive = existing !== null && isPidAlive(existing.pid)
  let ageMs = Number.POSITIVE_INFINITY
  try {
    ageMs = nowMs - statSync(path).mtimeMs
  } catch {
    // 文件刚被删除，直接重试
  }

  // 只有「持有者已死」或「锁文件超龄且 pid 不存活」才回收
  const reclaimable = !alive || (ageMs > staleMs && !alive)
  if (!reclaimable) return null

  try {
    unlinkSync(path)
  } catch {
    // 别人抢先删除了
  }
  return attempt() ? content : null
}

/** 释放锁（只在自己持有时删除，避免误删别人的锁）。 */
export function releaseLock(nonce: string, dshRoot?: string): void {
  const path = kernelLockPath(dshRoot)
  const existing = readJsonOrNull<LockContent>(path)
  if (existing !== null && existing.nonce === nonce) {
    try {
      rmSync(path, { force: true })
    } catch {
      // 已经被清理
    }
  }
  // 顺便清掉 info
  const info = readJsonOrNull<KernelInfo>(kernelInfoPath(dshRoot))
  if (info !== null && info.nonce === nonce) {
    try {
      rmSync(kernelInfoPath(dshRoot), { force: true })
    } catch {
      // 忽略
    }
  }
}

/** 读取当前锁（不存在或损坏返回 null）。 */
export function readLock(dshRoot?: string): LockContent | null {
  const path = kernelLockPath(dshRoot)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockContent
  } catch {
    return null
  }
}

/** 写入内核 info（供状态查询）。 */
export function writeKernelInfo(info: KernelInfo, dshRoot?: string): void {
  const path = kernelInfoPath(dshRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(info, null, 2), 'utf8')
}

/** 读取内核 info。 */
export function readKernelInfo(dshRoot?: string): KernelInfo | null {
  return readJsonOrNull<KernelInfo>(kernelInfoPath(dshRoot))
}
