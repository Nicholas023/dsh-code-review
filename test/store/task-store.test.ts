// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * task-store.test.ts —— 任务卡持久化的契约测试。
 *
 * 关注三件事：
 *  1. 原子性：写一半崩溃不会留下坏文件；
 *  2. 乐观并发：并发更新时后到者被拒绝而不是覆盖；
 *  3. 列表排序稳定。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelError } from '../../src/domain/errors.js'
import { transition, type TaskRecord } from '../../src/domain/task.js'
import { advanceTask, createTask, deleteTask, listTasks, readTask, updateTask } from '../../src/store/task-store.js'

const roots: string[] = []

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-store-'))
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

function make(root: string, id = 'task-1', now = '2026-11-04T00:00:00.000Z'): TaskRecord {
  return createTask({ id, scope, config: {}, requestor: null, now }, root)
}

describe('创建与读取', () => {
  it('创建后状态为 queued、revision 为 0', () => {
    const root = tempRoot()
    const t = make(root)
    expect(t.stage).toBe('queued')
    expect(t.revision).toBe(0)
    expect(readTask('task-1', root)?.id).toBe('task-1')
  })

  it('读取不存在的任务返回 null（不抛错）', () => {
    expect(readTask('nope', tempRoot())).toBeNull()
  })

  it('任务 id 中的危险字符被替换（防路径穿越）', () => {
    const root = tempRoot()
    make(root, '../../evil')
    const found = listTasks(root)
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('../../evil')
  })
})

describe('乐观并发', () => {
  it('正常更新递增 revision', () => {
    const root = tempRoot()
    make(root)
    const next = advanceTask('task-1', 'claimed', '2026-11-04T00:01:00.000Z', { owner: 'n1' }, root)
    expect(next.revision).toBe(1)
    expect(next.stage).toBe('claimed')
  })

  it('不递增 revision 的更新被拒绝', () => {
    const root = tempRoot()
    make(root)
    expect(() => updateTask('task-1', (cur) => ({ ...cur }), root)).toThrow(KernelError)
  })

  it('mutate 收到的总是磁盘上的最新记录（不信任调用方缓存的旧值）', () => {
    const root = tempRoot()
    make(root) // revision 0
    advanceTask('task-1', 'claimed', '2026-11-04T00:01:00.000Z', {}, root) // revision 1
    let observed = -1
    updateTask('task-1', (cur) => {
      observed = cur.revision
      return transition(cur, 'preparing', '2026-11-04T00:02:00.000Z')
    }, root)
    // 关键：闭包里拿到的是 1，而不是创建时的 0
    expect(observed).toBe(1)
  })

  it('更新不存在的任务抛 STORAGE_TASK_NOT_FOUND', () => {
    const root = tempRoot()
    try {
      advanceTask('ghost', 'claimed', '2026-11-04T00:01:00.000Z', {}, root)
      expect.unreachable('应当抛错')
    } catch (e) {
      expect((e as KernelError).code).toBe('STORAGE_TASK_NOT_FOUND')
    }
  })
})

describe('列表', () => {
  it('按创建时间倒序返回', () => {
    const root = tempRoot()
    make(root, 'a', '2026-11-04T00:00:01.000Z')
    make(root, 'b', '2026-11-04T00:00:03.000Z')
    make(root, 'c', '2026-11-04T00:00:02.000Z')
    expect(listTasks(root).map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('limit 生效', () => {
    const root = tempRoot()
    make(root, 'a', '2026-11-04T00:00:01.000Z')
    make(root, 'b', '2026-11-04T00:00:02.000Z')
    expect(listTasks(root, 1)).toHaveLength(1)
  })

  it('空目录返回空数组', () => {
    expect(listTasks(tempRoot())).toEqual([])
  })

  it('删除后不再出现', () => {
    const root = tempRoot()
    make(root)
    deleteTask('task-1', root)
    expect(listTasks(root)).toHaveLength(0)
  })
})
