// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * validate.test.ts —— 运行时校验的契约测试。
 *
 * 锁住三件事：
 *  1. 合法数据原样通过；
 *  2. 非法数据必须抛 SchemaValidationError，且错误里带得出路径；
 *  3. 缺少必填字段不能被当成 undefined 静默放过。
 */

import { describe, expect, it } from 'vitest'
import { SchemaValidationError, validateWith } from '../../src/domain/validate.js'

const taskSchema = {
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] },
  },
  additionalProperties: true,
}

describe('JSON Schema 运行时校验', () => {
  it('合法任务卡原样通过', () => {
    const task = { id: 't-1', status: 'queued', extra: 'unknown-but-allowed' }
    expect(validateWith('task', taskSchema, task)).toBe(task)
  })

  it('缺少必填字段时抛出 SchemaValidationError', () => {
    expect(() => validateWith('task', taskSchema, { status: 'queued' })).toThrow(SchemaValidationError)
  })

  it('枚举外的状态必须被拒绝', () => {
    expect(() => validateWith('task', taskSchema, { id: 't-1', status: 'bogus' })).toThrow(/status/)
  })

  it('错误信息带出失败路径，便于定位磁盘上的坏数据', () => {
    try {
      validateWith('task', taskSchema, { id: '', status: 'queued' })
      expect.unreachable('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError)
      expect((error as SchemaValidationError).path).toBe('/id')
    }
  })

  it('additionalProperties 为 true 时未知字段不被剔除（降级保真的基础）', () => {
    const value = { id: 't-2', status: 'done', futureField: { a: 1 } }
    const out = validateWith<any>('task', taskSchema, value)
    expect(out.futureField).toEqual({ a: 1 })
  })
})
