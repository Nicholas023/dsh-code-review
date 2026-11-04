// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * contracts.test.ts —— errors / outcome / finding 三个数据契约的联合测试。
 *
 * 放在一起是因为它们回答同一个问题：一次失败或一条结论，
 * 传递出去时形状是否可靠、能否被下游无歧义消费。
 */

import { describe, expect, it } from 'vitest'
import { ERROR_CODES, KernelError, toKernelError } from '../../src/domain/errors.js'
import { completed, failed, hasData, partial } from '../../src/domain/outcome.js'
import { hasLocation, sortBySeverity, type Finding } from '../../src/domain/finding.js'

describe('错误码目录', () => {
  it('错误码唯一（不允许重复登记）', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })

  it('每个错误码都带分类与重试策略', () => {
    for (const code of ERROR_CODES) {
      const e = new KernelError(code, 'x')
      expect(e.category).toBeTruthy()
      expect(['never', 'safe', 'after-input-change']).toContain(e.retry)
      expect(['none', 'partial', 'unknown']).toContain(e.effectState)
    }
  })

  it('toJSON 不含 stack 与 cause（防止把内部细节写进任务卡）', () => {
    const underlying = new Error('底层原因')
    const e = new KernelError('REPO_READ_FAILED', '读取失败', { cause: underlying, nextAction: '检查权限' })
    const json = e.toJSON()
    expect(JSON.stringify(json)).not.toContain('底层原因')
    expect(json).not.toHaveProperty('stack')
    expect(json).not.toHaveProperty('cause')
    expect(json.nextAction).toBe('检查权限')
  })

  it('未知抛出物归一为 INTERNAL_UNEXPECTED', () => {
    expect(toKernelError('字符串').code).toBe('INTERNAL_UNEXPECTED')
    expect(toKernelError(new Error('x')).code).toBe('INTERNAL_UNEXPECTED')
  })

  it('已是 KernelError 时原样返回（不重复包装）', () => {
    const e = new KernelError('CONFIG_CREDENTIAL_MISSING', 'x')
    expect(toKernelError(e)).toBe(e)
  })
})

describe('Outcome 契约', () => {
  it('completed 携带数据且判定为有数据', () => {
    const o = completed({ value: 42 })
    expect(o.status).toBe('completed')
    expect(hasData(o)).toBe(true)
  })

  it('partial 必须同时有 coverage 与 continuation', () => {
    const o = partial({ lines: 64 }, { processed: 64, total: 200, omitted: '后半段' }, { kind: 'offset', offset: 65 })
    expect(o.status).toBe('partial')
    expect(o.coverage.processed).toBe(64)
    expect(o.continuation.kind).toBe('offset')
    expect(hasData(o)).toBe(true)
  })

  it('failed 从 KernelError 投影，字段完整', () => {
    const o = failed('error', new KernelError('RUNTIME_RUNNER_TIMEOUT', '超时'))
    expect(o.status).toBe('error')
    expect(o.error.code).toBe('RUNTIME_RUNNER_TIMEOUT')
    expect(hasData(o)).toBe(false)
  })

  it('failed 可保留部分数据（批量中一半成功）', () => {
    const o = failed('error', new KernelError('MODEL_HTTP_ERROR', 'x'), { done: 1 })
    expect(o.data).toEqual({ done: 1 })
  })
})

describe('Finding 契约', () => {
  function finding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: 'f1',
      path: 'src/a.ts',
      lineStart: 10,
      lineEnd: 12,
      lineSource: 'exact',
      category: 'bug',
      severity: 'medium',
      title: 't',
      evidence: 'e',
      explanation: 'x',
      recommendation: 'r',
      confidence: 0.8,
      sourceAgent: 'main',
    sources: ['main'],
      sourceTask: null,
      ruleIds: [],
      status: 'confirmed',
      suppressionReason: null,
      fingerprint: 'fp1',
      ...overrides,
    }
  }

  it('按严重度排序：critical 在最前', () => {
    const sorted = sortBySeverity([
      finding({ id: 'a', severity: 'low' }),
      finding({ id: 'b', severity: 'critical' }),
      finding({ id: 'c', severity: 'medium' }),
    ])
    expect(sorted.map((f) => f.severity)).toEqual(['critical', 'medium', 'low'])
  })

  it('unresolved 不算有位置（不能伪装成可跳转）', () => {
    expect(hasLocation(finding({ lineSource: 'unresolved', lineStart: null, lineEnd: null }))).toBe(false)
  })

  it('diff-resolved 算有位置', () => {
    expect(hasLocation(finding({ lineSource: 'diff-resolved' }))).toBe(true)
  })
})
