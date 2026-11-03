// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * submit.test.ts —— 参数校验的契约测试。
 *
 * 这里是唯一入口，所以每条拒绝规则都必须有测试。
 * 尤其是 commit 缺 SHA 必须 fail-closed（issue #10 的不变量）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { submitReview } from '../../src/plugin/submit.js'
import { listTasks } from '../../src/store/task-store.js'
import { presentTask, presentTaskList, presentSubmitted } from '../../src/plugin/present.js'

const roots: string[] = []
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-submit-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

/** 造一个提交依赖。 */
function deps(root: string, cwdHint?: string) {
  let n = 0
  return {
    dshRoot: root,
    now: () => '2026-11-04T00:00:00.000Z',
    newId: () => 'task-' + String(++n),
    config: DEFAULT_CONFIG,
    requestor: null,
    ...(cwdHint === undefined ? {} : { cwdHint }),
  }
}

describe('repo_path 校验', () => {
  it('缺 repo_path 且无 cwd 时拒绝', () => {
    const r = submitReview({}, deps(tempRoot()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INPUT_REPO_PATH_REQUIRED')
  })

  it('相对路径被拒绝（内核没有当前目录概念）', () => {
    const r = submitReview({ repo_path: 'my-repo' }, deps(tempRoot()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INPUT_REPO_PATH_NOT_ABSOLUTE')
  })

  it('省略 repo_path 时用调用方 cwd 兜底', () => {
    const root = tempRoot()
    const r = submitReview({}, deps(root, 'D:/repo'))
    expect(r.ok).toBe(true)
  })
})

describe('模式与参数互斥', () => {
  it('未知 mode 被拒绝', () => {
    const r = submitReview({ repo_path: 'D:/r', mode: 'magic' }, deps(tempRoot()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INPUT_INVALID_ARGUMENT')
  })

  it('commit 模式缺 SHA 时 fail-closed（绝不退化成 workspace）', () => {
    const r = submitReview({ repo_path: 'D:/r', mode: 'commit' }, deps(tempRoot()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INPUT_MISSING_COMMIT_SHA')
  })

  it('空白 SHA 也被拒绝', () => {
    const r = submitReview({ repo_path: 'D:/r', mode: 'commit', commit: '   ' }, deps(tempRoot()))
    expect(r.ok).toBe(false)
  })

  it('非 commit 模式带 commit 参数被拒绝', () => {
    const r = submitReview({ repo_path: 'D:/r', mode: 'uncommitted', commit: 'abc123' }, deps(tempRoot()))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INPUT_MODE_CONFLICT')
  })

  it('scan 模式带 base_ref 被拒绝', () => {
    const r = submitReview({ repo_path: 'D:/r', mode: 'scan', base_ref: 'main' }, deps(tempRoot()))
    expect(r.ok).toBe(false)
  })
})

describe('正常提交', () => {
  it('创建 queued 任务卡并返回 id', () => {
    const root = tempRoot()
    const r = submitReview({ repo_path: 'D:/repo' }, deps(root))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.taskId).toBe('task-1')
    const tasks = listTasks(root)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.stage).toBe('queued')
    expect(tasks[0]!.scope.repoPath).toBe('D:/repo')
  })

  it('commit 模式把 SHA 写进 scope', () => {
    const root = tempRoot()
    const r = submitReview({ repo_path: 'D:/repo', mode: 'commit', commit: 'abc123' }, deps(root))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.commit).toBe('abc123')
    expect(r.scope.command).toBe('review')
  })

  it('scan 模式 command 为 scan 且 mode 为 null', () => {
    const root = tempRoot()
    const r = submitReview({ repo_path: 'D:/repo', mode: 'scan' }, deps(root))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.command).toBe('scan')
    expect(r.scope.mode).toBeNull()
  })

  it('配置被快照进任务卡（之后改设置不影响本次）', () => {
    const root = tempRoot()
    const r = submitReview({ repo_path: 'D:/repo' }, deps(root))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const task = listTasks(root)[0]!
    expect((task.config as { version?: number }).version).toBe(2)
  })

  it('数组参数被清洗（过滤非字符串与空串）', () => {
    const root = tempRoot()
    const r = submitReview(
      { repo_path: 'D:/r', exclude_paths: ['engine/**', '', 123, ' dist/** '] },
      deps(root),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scope.excludePaths).toEqual(['engine/**', 'dist/**'])
  })
})

describe('状态呈现', () => {
  const base = {
    id: 'task-x',
    schemaVersion: 2,
    revision: 0,
    stage: 'queued' as const,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    claimedAt: null,
    heartbeatAt: null,
    completedAt: null,
    owner: null,
    cancelRequested: false,
    failure: null,
    requestor: null,
    scope: {
      repoPath: 'D:/repo',
      command: 'review' as const,
      mode: 'uncommitted' as const,
      baseRef: null,
      headRef: null,
      commit: null,
      focus: null,
      excludePaths: [],
      pendingPaths: [],
    },
    config: {},
    summary: null,
  }

  it('列表为空时给出引导语', () => {
    expect(presentTaskList([])).toContain('任务簿为空')
  })

  it('单任务呈现包含仓库与状态', () => {
    const text = presentTask(base)
    expect(text).toContain('D:/repo')
    expect(text).toContain('排队中')
  })

  it('失败任务呈现错误码与建议', () => {
    const text = presentTask({
      ...base,
      stage: 'failed',
      failure: { code: 'CONFIG_CREDENTIAL_MISSING', message: '凭据缺失', retry: 'after-input-change', effectState: 'none', nextAction: '去设置里补', stage: 'preparing' },
    })
    expect(text).toContain('CONFIG_CREDENTIAL_MISSING')
    expect(text).toContain('去设置里补')
  })

  it('提交回执包含任务 id 与查询方式', () => {
    const text = presentSubmitted('task-1', 'queued')
    expect(text).toContain('task-1')
    expect(text).toContain('code_review_status')
  })
})
