// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * lock.test.ts —— 内核单例锁与认领的契约测试。
 *
 * 这两块决定「会不会有两个内核同时跑同一批任务」——
 * 一旦失效，同一次评审会被执行两遍，token 账单翻倍且结果互相覆盖。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimNextTask, isKernelAlive } from '../../src/kernel/serve.js'
import { isPidAlive, readLock, releaseLock, tryAcquireLock } from '../../src/kernel/lock.js'
import { createTask, listTasks } from '../../src/store/task-store.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { taskPath } from '../../src/store/paths.js'

const roots: string[] = []

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-lock-'))
  roots.push(d)
  return d
}

afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('单例锁', () => {
  it('首次获取成功', () => {
    const root = tempRoot()
    const got = tryAcquireLock({ pid: process.pid, nonce: 'n1', startedAt: '2026-11-04T00:00:00.000Z' }, root)
    expect(got?.nonce).toBe('n1')
    expect(readLock(root)?.nonce).toBe('n1')
  })

  it('存活进程持锁时第二个实例拿不到', () => {
    const root = tempRoot()
    tryAcquireLock({ pid: process.pid, nonce: 'n1', startedAt: '2026-11-04T00:00:00.000Z' }, root)
    const second = tryAcquireLock({ pid: process.pid, nonce: 'n2', startedAt: '2026-11-04T00:00:01.000Z' }, root)
    expect(second).toBeNull()
  })

  it('持有者已死时可回收陈旧锁', () => {
    const root = tempRoot()
    // 用一个几乎不可能存活的 pid
    tryAcquireLock({ pid: 999_999, nonce: 'dead', startedAt: '2020-01-01T00:00:00.000Z' }, root)
    const got = tryAcquireLock({ pid: process.pid, nonce: 'alive', startedAt: '2026-11-04T00:00:00.000Z' }, root)
    expect(got?.nonce).toBe('alive')
  })

  it('释放后别人可以拿到', () => {
    const root = tempRoot()
    tryAcquireLock({ pid: process.pid, nonce: 'n1', startedAt: '2026-11-04T00:00:00.000Z' }, root)
    releaseLock('n1', root)
    expect(readLock(root)).toBeNull()
    expect(tryAcquireLock({ pid: process.pid, nonce: 'n2', startedAt: '2026-11-04T00:00:01.000Z' }, root)?.nonce).toBe('n2')
  })

  it('用错误的 nonce 释放不会误删别人的锁', () => {
    const root = tempRoot()
    tryAcquireLock({ pid: process.pid, nonce: 'owner', startedAt: '2026-11-04T00:00:00.000Z' }, root)
    releaseLock('intruder', root)
    expect(readLock(root)?.nonce).toBe('owner')
  })
})

describe('存活探测', () => {
  it('当前进程存活', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('非法 pid 判为不存活', () => {
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(0)).toBe(false)
  })

  it('持有锁的存活进程被识别为内核在线', () => {
    const root = tempRoot()
    tryAcquireLock({ pid: process.pid, nonce: 'n1', startedAt: '2026-11-04T00:00:00.000Z' }, root)
    expect(isKernelAlive(root)).toBe(true)
  })

  it('无锁时判定内核不在线', () => {
    expect(isKernelAlive(tempRoot())).toBe(false)
  })
})

describe('任务认领', () => {
  const scope = {
    repoPath: 'D:/repo',
    command: 'review' as const,
    mode: 'uncommitted' as const,
    baseRef: null,
    headRef: null,
    commit: null,
    focus: null,
    excludePaths: [] as string[],
    pendingPaths: [] as string[],
  }

  function seed(root: string, id: string, now: string): void {
    createTask({ id, scope, config: {}, requestor: null, now }, root)
  }

  it('认领 queued 任务并推进到 claimed', () => {
    const root = tempRoot()
    seed(root, 't1', '2026-11-04T00:00:00.000Z')
    const claimed = claimNextTask('owner-1', '2026-11-04T00:01:00.000Z', root)
    expect(claimed?.id).toBe('t1')
    expect(claimed?.stage).toBe('claimed')
    expect(claimed?.owner).toBe('owner-1')
  })

  it('已被认领的任务不会被再次认领', () => {
    const root = tempRoot()
    seed(root, 't1', '2026-11-04T00:00:00.000Z')
    claimNextTask('owner-1', '2026-11-04T00:01:00.000Z', root)
    expect(claimNextTask('owner-2', '2026-11-04T00:02:00.000Z', root)).toBeNull()
  })

  it('没有任务时返回 null', () => {
    expect(claimNextTask('owner-1', '2026-11-04T00:01:00.000Z', tempRoot())).toBeNull()
  })

  it('心跳过期的进行中任务被判定为需要恢复', () => {
    const root = tempRoot()
    seed(root, 't1', '2026-11-04T00:00:00.000Z')
    // 先认领再把它改成 reviewing 并清空心跳（模拟内核被杀）
    const claimed = claimNextTask('owner-1', '2026-11-04T00:01:00.000Z', root)!
    writeJsonAtomic(taskPath('t1', root), { ...claimed, stage: 'reviewing', heartbeatAt: null, revision: claimed.revision + 1 })
    const recovered = claimNextTask('owner-2', '2026-11-04T00:10:00.000Z', root, 60_000)
    expect(recovered?.stage).toBe('recovering')
    expect(recovered?.owner).toBe('owner-2')
  })

  it('多任务时逐个认领', () => {
    const root = tempRoot()
    seed(root, 'a', '2026-11-04T00:00:01.000Z')
    seed(root, 'b', '2026-11-04T00:00:02.000Z')
    const first = claimNextTask('o', '2026-11-04T01:00:00.000Z', root)
    const second = claimNextTask('o', '2026-11-04T01:00:01.000Z', root)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.id).not.toBe(second!.id)
    expect(listTasks(root).filter((t) => t.stage === 'claimed')).toHaveLength(2)
  })
})
