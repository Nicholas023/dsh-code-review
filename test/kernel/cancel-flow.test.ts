// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * cancel-flow.test.ts —— 取消的端到端行为。
 *
 * 「取消」最容易做错的地方是把**请求**当成**结果**：
 * 标记一置就叫用户「已取消」，实际内核还在跑、还在烧 token。
 * 这里逐层验证：
 *   - 排队中的取消 = 立即生效（内核还没碰）；
 *   - 执行中的取消 = 只打标记（不能假装已停）；
 *   - 内核在认领前、执行前都会看这个标记；
 *   - 已结束的任务不能取消。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelError } from '../../src/domain/errors.js'
import type { TaskScope } from '../../src/domain/task.js'
import { claimNextTask, runClaimedTask, serve } from '../../src/kernel/serve.js'
import { createTask, readTask, requestCancellation, updateTask } from '../../src/store/task-store.js'
import { transition } from '../../src/domain/task.js'

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

const scope: TaskScope = {
  repoPath: 'D:/repo',
  command: 'review',
  mode: 'uncommitted',
  baseRef: null,
  headRef: null,
  commit: null,
  focus: null,
  excludePaths: [],
  pendingPaths: [],
}

function seed(root: string, id = 't1', now = '2026-11-04T00:00:00.000Z') {
  return createTask({ id, scope, config: {}, requestor: null, now }, root)
}

/** 永远不会被真正调用的 deps（取消应当发生在执行之前）。 */
function neverCalledDeps() {
  return {
    resolveCredential: () => {
      throw new Error('不应该走到执行阶段')
    },
    nodePath: process.execPath,
    runnerEntry: 'unused',
    now: () => '2026-11-04T00:05:00.000Z',
  }
}

describe('取消语义', () => {
  it('排队中：立即转 cancelled', () => {
    const root = tempRoot()
    seed(root)
    const after = requestCancellation('t1', '2026-11-04T00:01:00.000Z', root)
    expect(after.stage).toBe('cancelled')
    expect(after.cancelRequested).toBe(true)
  })

  it('执行中：只打标记，阶段不变（不能假装已停）', () => {
    const root = tempRoot()
    seed(root)
    // 手动推进到 reviewing
    updateTask('t1', (cur) => transition(cur, 'claimed', '2026-11-04T00:00:10.000Z'), root)
    updateTask('t1', (cur) => transition(cur, 'preparing', '2026-11-04T00:00:20.000Z'), root)
    updateTask('t1', (cur) => transition(cur, 'reviewing', '2026-11-04T00:00:30.000Z'), root)

    const after = requestCancellation('t1', '2026-11-04T00:01:00.000Z', root)
    expect(after.stage).toBe('reviewing')
    expect(after.cancelRequested).toBe(true)
  })

  it('已结束的任务拒绝取消', () => {
    const root = tempRoot()
    seed(root)
    requestCancellation('t1', '2026-11-04T00:01:00.000Z', root)
    expect(() => requestCancellation('t1', '2026-11-04T00:02:00.000Z', root)).toThrow(KernelError)
  })
})

describe('内核响应取消', () => {
  it('认领时跳过已取消的排队任务，并把它落成 cancelled', () => {
    const root = tempRoot()
    seed(root)
    requestCancellation('t1', '2026-11-04T00:01:00.000Z', root)

    const claimed = claimNextTask('owner', '2026-11-04T00:02:00.000Z', root)
    expect(claimed).toBeNull()
    expect(readTask('t1', root)?.stage).toBe('cancelled')
  })

  it('认领后执行前发现取消，直接落成 cancelled（不白白跑一次）', async () => {
    const root = tempRoot()
    seed(root)
    // 先认领
    const claimed = claimNextTask('owner', '2026-11-04T00:01:00.000Z', root)!
    expect(claimed.stage).toBe('claimed')
    // 认领之后、执行之前用户取消
    requestCancellation('t1', '2026-11-04T00:01:30.000Z', root)

    // deps 一旦被调用就会抛错 —— 证明执行确实没发生
    const done = await runClaimedTask(claimed, neverCalledDeps() as never, root)
    expect(done.stage).toBe('cancelled')
  })

  it('serve 一轮里不会认领已取消的任务', async () => {
    const root = tempRoot()
    seed(root)
    requestCancellation('t1', '2026-11-04T00:01:00.000Z', root)

    const result = await serve({ dshRoot: root, once: true, deps: neverCalledDeps() as never, log: () => {} })
    expect(result.processed).toBe(0)
    expect(readTask('t1', root)?.stage).toBe('cancelled')
  })
})
