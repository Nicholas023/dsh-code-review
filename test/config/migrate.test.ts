// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * migrate.test.ts —— 配置迁移契约测试。
 *
 * 这是「升级不丢设置」的第一道证据：
 *  - 已知字段必须正确搬运（含语义反转的 first_run）；
 *  - 删除字段必须登记原因（engine_bin）；
 *  - 未知字段必须原样保留。
 */

import { describe, expect, it } from 'vitest'
import { migrate, migrateV1toV2 } from '../../src/config/migrate.js'

describe('v1 → v2 迁移', () => {
  it('搬运已知字段到新分区', () => {
    const r = migrateV1toV2({
      review_model: 'glm-5.1',
      report_dir: 'D:/reports',
      review_timeout_ms: 3_600_000,
      concurrency_enabled: true,
      concurrency: 12,
      first_run: false,
    })
    const cfg = r.config as any
    expect(cfg.review.model).toBe('glm-5.1')
    expect(cfg.report.directory).toBe('D:/reports')
    expect(cfg.review.taskTimeoutMs).toBe(3_600_000)
    expect(cfg.execution.concurrencyEnabled).toBe(true)
    expect(cfg.execution.concurrency).toBe(12)
    expect(cfg.onboarding.firstRunCompleted).toBe(true)
    expect(cfg.version).toBe(2)
  })

  it('first_run 语义反转：true 表示尚未引导 → firstRunCompleted=false', () => {
    const r = migrateV1toV2({ first_run: true })
    expect((r.config as any).onboarding.firstRunCompleted).toBe(false)
  })

  it('engine_bin 被删除，且登记了原因', () => {
    const r = migrateV1toV2({ engine_bin: 'C:/bin/codecheck.exe' })
    expect((r.config as any).engine_bin).toBeUndefined()
    expect((r.config as any).review.engineBin).toBeUndefined()
    const removed = r.removedFields.find((f) => f.key === 'engine_bin')
    expect(removed).toBeDefined()
    expect(removed?.reason).toContain('0.2.0')
  })

  it('未出现 engine_bin 时不产生删除记录（不制造虚假变更）', () => {
    const r = migrateV1toV2({ review_model: 'session' })
    expect(r.removedFields).toHaveLength(0)
  })

  it('concurrency 数值保留并记录语义变化', () => {
    const r = migrateV1toV2({ concurrency: 4 })
    expect((r.config as any).execution.concurrency).toBe(4)
    expect(r.notes.join()).toContain('语义')
  })

  it('未知字段原样保留到顶层（核心：不丢用户配置）', () => {
    const r = migrateV1toV2({
      review_model: 'session',
      my_custom_thing: { nested: [1, 2, 3] },
      future_flag: 'keep-me',
    })
    const cfg = r.config as any
    expect(cfg.my_custom_thing).toEqual({ nested: [1, 2, 3] })
    expect(cfg.future_flag).toBe('keep-me')
    expect([...r.preservedUnknownKeys].sort()).toEqual(['future_flag', 'my_custom_thing'])
  })

  it('空对象也能安全迁移', () => {
    const r = migrateV1toV2({})
    expect((r.config as any).version).toBe(2)
    expect((r.config as any).review.model).toBe('session')
  })

  it('非法类型回退默认而不是崩溃', () => {
    const r = migrateV1toV2({ review_model: 123, concurrency: 'many', first_run: 'yes' })
    const cfg = r.config as any
    expect(cfg.review.model).toBe('session')
    expect(typeof cfg.execution.concurrency).toBe('number')
    expect(cfg.onboarding.firstRunCompleted).toBe(false)
  })
})

describe('迁移入口的版本路由', () => {
  it('v2 文件不再迁移', () => {
    expect(migrate({ version: 2 })).toBeNull()
  })

  it('无 version 字段视作 v1', () => {
    const r = migrate({ review_model: 'x' })
    expect(r?.fromVersion).toBe(1)
  })

  it('版本高于支持必须显式失败（拒绝静默降级）', () => {
    expect(() => migrate({ version: 99 })).toThrow(/版本/)
  })
})
