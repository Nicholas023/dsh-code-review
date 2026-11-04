// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * task.test.ts —— 任务状态机的契约测试。
 *
 * 覆盖四类风险：
 *  1. 正向链路（queued→…→completed）必须走得通；
 *  2. 非法迁移必须抛错（不能靠调用方自觉）；
 *  3. revision 单调递增（乐观并发的基石）；
 *  4. 心跳过期判定（崩溃恢复的判据）。
 */

import { describe, expect, it } from 'vitest'
import { KernelError } from '../../src/domain/errors.js'
import {
  assertTransition,
  canTransition,
  isHeartbeatStale,
  isTerminal,
  transition,
  type TaskRecord,
} from '../../src/domain/task.js'

/** 构造一个最小可用任务记录，供各用例复用。 */
function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    schemaVersion: 2,
    revision: 0,
    stage: 'queued',
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
      command: 'review',
      mode: 'uncommitted',
      baseRef: null,
      headRef: null,
      commit: null,
      focus: null,
      excludePaths: [],
      pendingPaths: [],
    },
    config: {},
    summary: null,
    ...overrides,
  }
}

describe('任务状态机：正向链路', () => {
  it('queued 一路走到 completed，revision 每步 +1', () => {
    let r = makeRecord()
    const path = ['claimed', 'preparing', 'reviewing', 'aggregating', 'reporting', 'completed'] as const
    let expectedRev = 0
    for (const stage of path) {
      expectedRev += 1
      r = transition(r, stage, '2026-11-04T00:01:00.000Z')
      expect(r.stage).toBe(stage)
      expect(r.revision).toBe(expectedRev)
    }
    expect(isTerminal(r)).toBe(true)
    expect(r.completedAt).not.toBeNull()
  })

  it('认领时间只在首次进入 claimed 时落定，不被后续覆盖', () => {
    let r = makeRecord()
    r = transition(r, 'claimed', '2026-11-04T00:01:00.000Z')
    const claimedAt = r.claimedAt
    expect(claimedAt).toBe('2026-11-04T00:01:00.000Z')
    r = transition(r, 'preparing', '2026-11-04T00:05:00.000Z')
    expect(r.claimedAt).toBe(claimedAt)
  })
})

describe('任务状态机：非法迁移', () => {
  it('终态 completed 不可再迁移', () => {
    expect(canTransition('completed', 'reviewing')).toBe(false)
    expect(() => assertTransition('completed', 'reviewing')).toThrow(KernelError)
  })

  it('不能跳过中间阶段直接 completed', () => {
    expect(canTransition('queued', 'completed')).toBe(false)
  })

  it('非法迁移抛 INTERNAL_INVARIANT_VIOLATED，错误里列出现行合法目标', () => {
    try {
      assertTransition('queued', 'completed')
      expect.unreachable('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      expect((error as KernelError).code).toBe('INTERNAL_INVARIANT_VIOLATED')
      expect((error as KernelError).message).toContain('claimed')
    }
  })

  it('failed 允许进入 recovering（恢复入口）', () => {
    expect(canTransition('failed', 'recovering')).toBe(true)
  })
})

describe('任务状态机：失败与取消', () => {
  it('进行中状态可转 failed，并携带分类失败信息', () => {
    let r = makeRecord()
    r = transition(r, 'claimed', '2026-11-04T00:01:00.000Z')
    r = transition(r, 'preparing', '2026-11-04T00:01:30.000Z')
    r = transition(r, 'reviewing', '2026-11-04T00:02:00.000Z')
    r = transition(r, 'failed', '2026-11-04T00:03:00.000Z', {
      failure: {
        code: 'RUNTIME_RUNNER_TIMEOUT',
        message: 'runner 执行超时',
        retry: 'safe',
        effectState: 'unknown',
        stage: 'reviewing',
      },
    })
    expect(r.stage).toBe('failed')
    expect(r.failure?.code).toBe('RUNTIME_RUNNER_TIMEOUT')
    expect(r.completedAt).not.toBeNull()
  })

  it('取消请求与实际取消是两个独立事实', () => {
    let r = makeRecord()
    r = transition(r, 'claimed', '2026-11-04T00:01:00.000Z')
    // 只标记「已请求」，阶段不变 —— 不能把请求当成已完成取消
    r = { ...r, cancelRequested: true, revision: r.revision + 1 }
    expect(r.stage).toBe('claimed')
    expect(r.cancelRequested).toBe(true)
    // 真正取消后才进入终态
    r = transition(r, 'cancelled', '2026-11-04T00:02:00.000Z')
    expect(r.stage).toBe('cancelled')
    expect(isTerminal(r)).toBe(true)
  })
})

describe('任务状态机：心跳判定', () => {
  const now = Date.parse('2026-11-04T02:00:00.000Z')

  it('从未心跳视为过期（防止僵尸任务永占位）', () => {
    expect(isHeartbeatStale(null, now, 60_000)).toBe(true)
  })

  it('未超过阈值不判过期', () => {
    expect(isHeartbeatStale('2026-11-04T01:59:30.000Z', now, 60_000)).toBe(false)
  })

  it('超过阈值判过期', () => {
    expect(isHeartbeatStale('2026-11-04T01:58:00.000Z', now, 60_000)).toBe(true)
  })

  it('时间戳无法解析时判过期（坏数据不能当活任务）', () => {
    expect(isHeartbeatStale('not-a-date', now, 60_000)).toBe(true)
  })
})
