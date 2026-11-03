// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * cancel.test.ts —— 任务取消的语义测试。
 *
 * 取消最容易做错的地方是把「已请求」当成「已取消」：
 * 用户看到「已取消」以为停了，其实内核还在跑、还在烧 token。
 * 这里把两种状态分开断言。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimNextTask } from '../../src/kernel/serve.js'
import { createTask, readTask, requestCancellation } from '../../src/store/task-store.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { taskPath } from '../../src/store/paths.js'

const roots: string[] = []
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-cancel-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

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

function seed(root: string, id: string, stage: 'queued' | 'reviewing' = 'queued') {
  const rec = createTask({ id, scope, config: {}, requestor: null, now: '2026-11-04T00:00:00.000Z' }, root)
  if (stage === 'reviewing') {
    // 直接把状态推进到 reviewing（绕过 CLI，只测取消语义）
    writeJsonAtomic(taskPath(id, root), { ...rec, stage: 'reviewing', revision: 1, claimedAt: '2026-11-04T00:01:00.000Z', heartbeatAt: '2026-11-04T00:01:00.000Z' })
  }
  return rec
}

describe('取消：排队中', () => {
  it('立即进入 cancelled（内核还没碰它）', () => {
    const root = tempRoot()
    seed(root, 't1')
    const next = requestCancellation('t1', '2026-11-04T00:02:00.000Z', root)
    expect(next.stage).toBe('cancelled')
    expect(next.cancelRequested).toBe(true)
    expect(next.completedAt).not.toBeNull()
  })

  it('取消后内核不会再认领它', () => {
    const root = tempRoot()
    seed(root, 't1')
    requestCancellation('t1', '2026-11-04T00:02:00.000Z', root)
    expect(claimNextTask('o', '2026-11-04T00:03:00.000Z', root)).toBeNull()
  })
})

describe('取消：执行中', () => {
  it('只打标记，不假装已结束', () => {
    const root = tempRoot()
    seed(root, 't1', 'reviewing')
    const next = requestCancellation('t1', '2026-11-04T00:02:00.000Z', root)
    expect(next.cancelRequested).toBe(true)
    // 关键：阶段没有变成 cancelled —— 内核还在跑
    expect(next.stage).toBe('reviewing')
  })

  it('重复请求取消是幂等的', () => {
    const root = tempRoot()
    seed(root, 't1', 'reviewing')
    requestCancellation('t1', '2026-11-04T00:02:00.000Z', root)
    const again = requestCancellation('t1', '2026-11-04T00:03:00.000Z', root)
    expect(again.cancelRequested).toBe(true)
    expect(again.stage).toBe('reviewing')
  })
})

describe('取消：已结束的任务', () => {
  it('取消已完成的任务报错（而不是静默成功）', () => {
    const root = tempRoot()
    seed(root, 't1')
    // 先取消一次 → 变 cancelled（终态）
    requestCancellation('t1', '2026-11-04T00:02:00.000Z', root)
    expect(() => requestCancellation('t1', '2026-11-04T00:03:00.000Z', root)).toThrow(/无法取消/)
  })

  it('取消不存在的任务报错', () => {
    expect(() => requestCancellation('ghost', '2026-11-04T00:02:00.000Z', tempRoot())).toThrow()
  })
})

describe('内核认领时清理取消标记', () => {
  it('已请求取消的排队任务被标记 cancelled 而不是执行', () => {
    const root = tempRoot()
    const rec = seed(root, 't1')
    // 直接改文件模拟「取消请求已写入但内核还没认领」
    writeJsonAtomic(taskPath('t1', root), { ...rec, cancelRequested: true })

    const claimed = claimNextTask('o', '2026-11-04T00:03:00.000Z', root)
    expect(claimed).toBeNull()
    expect(readTask('t1', root)?.stage).toBe('cancelled')
  })
})
