// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * present.test.ts —— 任务状态文案的契约测试。
 *
 * 这一层出错的后果不是「不好看」，而是**误导**：实机上出现过
 *   ✅ 任务 xxx — 已完成
 *   **结果**：0 个问题
 * 而报告里写着 status=partial、warnings=[达到最大轮次]。用户会以为代码干净。
 * 所以这里锁死三条：
 *  1. 评审没跑完时不许出现 ✅，必须显式说「未完整完成」；
 *  2. 告警必须原样带出；
 *  3. 老任务卡没有 status 字段时不能崩，也不能误报。
 */

import { describe, expect, it } from 'vitest'
import { presentTask } from '../../src/plugin/present.js'
import type { TaskRecord } from '../../src/domain/task.js'

/** 造一个最小可用的任务卡。 */
function card(overrides: Record<string, unknown> = {}): TaskRecord {
  return {
    id: 'task-1',
    stage: 'completed',
    createdAt: '2026-11-04T10:00:00.000Z',
    scope: {
      repoPath: 'D:/repo',
      command: 'scan',
      mode: null,
      baseRef: null,
      headRef: null,
      commit: null,
      focus: null,
      excludePaths: [],
    },
    summary: {
      reportPath: 'C:/r/a.md',
      reportJsonPath: 'C:/r/a.json',
      findingCount: 0,
      severityCounts: {},
      coverage: { reviewed: 2, total: 2 },
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, requests: 1 },
      elapsedSec: 1.2,
    },
    failure: null,
    ...overrides,
  } as unknown as TaskRecord
}

describe('任务呈现', () => {
  it('评审完整完成时显示 ✅', () => {
    const text = presentTask(card({ summary: { ...(card().summary as object), status: 'completed' } }))
    expect(text).toContain('✅')
    expect(text).not.toContain('未完整完成')
  })

  it('评审 partial 时不显示 ✅，并明确说是没跑完', () => {
    // 回归：这正是实机上「0 个问题」被误读成干净结论的场景
    const text = presentTask(card({
      summary: {
        ...(card().summary as object),
        status: 'partial',
        warnings: ['达到最大轮次，评审未完成'],
      },
    }))
    expect(text).not.toContain('✅')
    expect(text).toContain('⚠️')
    expect(text).toContain('未完整完成')
    expect(text).toContain('不代表全部')
  })

  it('告警逐条带出', () => {
    const text = presentTask(card({
      summary: {
        ...(card().summary as object),
        status: 'partial',
        warnings: ['达到最大轮次，评审未完成', '子 agent 数量达到上限 8'],
      },
    }))
    expect(text).toContain('**告警**')
    expect(text).toContain('达到最大轮次')
    expect(text).toContain('子 agent 数量达到上限')
  })

  it('老任务卡没有 status 字段时不崩、不误报', () => {
    // 0.2.0 之前写下的任务卡没有这两个字段
    const text = presentTask(card())
    expect(text).toContain('✅')
    expect(text).not.toContain('未完整完成')
  })

  it('失败任务照常显示失败原因', () => {
    const text = presentTask(card({
      stage: 'failed',
      summary: null,
      failure: { code: 'CONFIG_CREDENTIAL_MISSING', message: '凭据未配置', retry: 'after-input-change', effectState: 'none', stage: 'preparing' },
    }))
    expect(text).toContain('❌')
    expect(text).toContain('凭据未配置')
  })
})
