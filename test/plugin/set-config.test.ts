// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * set-config.test.ts —— 程序化改配置的契约测试。
 *
 * 0.2.0 起这个模块不再碰文件系统：只「算补丁」+「交给宿主写」。
 * 所以测试也分两层：
 *  1. planConfigPatch —— 纯校验与补丁构造（未知/只读/类型不符必须拒绝且说明原因）；
 *  2. writeConfigThroughHost —— 只在宿主给了 configEditor 时才写，写不进去要明说。
 *
 * 必须守住的底线：绝不静默丢弃字段、绝不假装写入成功。
 */

import { describe, expect, it } from 'vitest'
import {
  mergeConfigChanges,
  planConfigPatch,
  presentSetConfigResult,
  writeConfigThroughHost,
  type ConfigEditorLike,
} from '../../src/plugin/set-config.js'

describe('合法字段', () => {
  it('接受字符串字段并回显', () => {
    const plan = planConfigPatch({ 'review.model': 'deepseek-flash' })
    expect(plan.ok).toBe(true)
    expect(plan.applied).toContain('review.model')
    expect(plan.effective['review.model']).toBe('deepseek-flash')
    expect(plan.changes.review).toEqual({ model: 'deepseek-flash' })
  })

  it('接受布尔字段', () => {
    const plan = planConfigPatch({ 'report.writeJson': false })
    expect(plan.ok).toBe(true)
    expect(plan.effective['report.writeJson']).toBe(false)
  })

  it('字符串被 trim', () => {
    const plan = planConfigPatch({ 'review.endpoint': '  https://api.example.com  ' })
    expect(plan.effective['review.endpoint']).toBe('https://api.example.com')
  })

  it('数值越界被钳制而不是报错', () => {
    const plan = planConfigPatch({ 'execution.concurrency': 999 })
    expect(plan.ok).toBe(true)
    expect(plan.effective['execution.concurrency']).toBe(32)
  })

  it('负数被抬到下限', () => {
    const plan = planConfigPatch({ 'budget.maxAgentRounds': -5 })
    expect(plan.effective['budget.maxAgentRounds']).toBe(1)
  })

  it('枚举字段只接受合法值', () => {
    expect(planConfigPatch({ 'review.protocol': 'anthropic' }).ok).toBe(false)
    expect(planConfigPatch({ 'review.protocol': 'openai-chat-completions' }).ok).toBe(true)
  })
})

describe('拒绝与回显', () => {
  it('未知字段被拒绝并给出原因', () => {
    const plan = planConfigPatch({ 'review.nonexistent': 'x' })
    expect(plan.ok).toBe(false)
    expect(plan.rejected[0]!.field).toBe('review.nonexistent')
    expect(plan.rejected[0]!.reason).toContain('未知字段')
  })

  it('只读字段被拒绝', () => {
    const plan = planConfigPatch({ 'onboarding.firstRunCompleted': true })
    expect(plan.ok).toBe(false)
    expect(plan.rejected[0]!.reason).toContain('只读')
  })

  it('类型不符被拒绝', () => {
    const plan = planConfigPatch({ 'review.model': 123 })
    expect(plan.ok).toBe(false)
    expect(plan.rejected[0]!.reason).toContain('字符串')
  })

  it('缺 section 前缀的键被拒绝', () => {
    expect(planConfigPatch({ model: 'x' }).ok).toBe(false)
  })

  it('部分成功：合法字段进补丁，非法字段回显原因', () => {
    const plan = planConfigPatch({ 'review.model': 'ok', 'review.bogus': 1 })
    expect(plan.ok).toBe(true)
    expect(plan.applied).toEqual(['review.model'])
    expect(plan.rejected).toHaveLength(1)
    expect(plan.changes.review).toEqual({ model: 'ok' })
  })

  it('全部被拒时不给补丁', () => {
    const plan = planConfigPatch({ 'nope.nope': 1 })
    expect(plan.ok).toBe(false)
    expect(plan.error).toContain('没有任何字段被接受')
    expect(plan.changes).toEqual({})
  })

  it('空补丁给出明确说明', () => {
    const plan = planConfigPatch({})
    expect(plan.ok).toBe(false)
    expect(plan.error).toContain('补丁为空')
  })
})

describe('补丁合并', () => {
  it('只改目标路径，同区其他字段与未知顶层字段原样保留', () => {
    const current = {
      review: { model: 'old', endpoint: 'https://keep.me' },
      myCustomThing: { nested: true },
    }
    const next = mergeConfigChanges(current, { review: { model: 'new' } })
    expect((next.review as { model: string }).model).toBe('new')
    expect((next.review as { endpoint: string }).endpoint).toBe('https://keep.me')
    expect(next.myCustomThing).toEqual({ nested: true })
  })

  it('当前配置为 undefined 时只产出补丁内容', () => {
    const next = mergeConfigChanges(undefined, { budget: { maxChildren: 4 } })
    expect(next).toEqual({ budget: { maxChildren: 4 } })
  })

  it('不修改传入的当前配置（避免宿主快照被就地改坏）', () => {
    const current = { review: { model: 'old' } }
    mergeConfigChanges(current, { review: { model: 'new' } })
    expect(current.review.model).toBe('old')
  })
})

/** 造一个假的 configEditor，记录被写入了什么。 */
function fakeEditor(): { editor: ConfigEditorLike; written: unknown[] } {
  const written: unknown[] = []
  const editor: ConfigEditorLike = {
    documentPath: 'C:/fake/profile/cordis.yaml',
    entries: () => [{ options: { id: 'dsh-code-review' } }],
    async edit(_entry, change) {
      written.push(change({ review: { model: 'old' } }, undefined))
    },
  }
  return { editor, written }
}

describe('通过宿主写入', () => {
  it('把合并后的完整配置交给 configEditor', async () => {
    const { editor, written } = fakeEditor()
    const plan = planConfigPatch({ 'review.model': 'new' })
    const result = await writeConfigThroughHost(plan.changes, editor, 'dsh-code-review')
    expect(result.ok).toBe(true)
    expect(result.path).toContain('cordis')
    expect(written).toHaveLength(1)
    expect((written[0] as { review: { model: string } }).review.model).toBe('new')
  })

  it('找不到配置行时明确失败，不假装成功', async () => {
    const editor: ConfigEditorLike = {
      documentPath: 'C:/fake/profile/cordis.yaml',
      entries: () => [],
      async edit() { throw new Error('不该被调用') },
    }
    const plan = planConfigPatch({ 'review.model': 'x' })
    const result = await writeConfigThroughHost(plan.changes, editor, 'dsh-code-review')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('找不到配置行')
  })

  it('宿主拒绝写入时把原因带回', async () => {
    const editor: ConfigEditorLike = {
      documentPath: 'C:/fake/profile/cordis.yaml',
      entries: () => [{ options: { id: 'dsh-code-review' } }],
      async edit() { throw new Error('Configuration entry changed during reload') },
    }
    const plan = planConfigPatch({ 'review.model': 'x' })
    const result = await writeConfigThroughHost(plan.changes, editor, 'dsh-code-review')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('changed during reload')
  })
})

describe('文本回显', () => {
  it('成功时列出已应用字段', () => {
    const plan = planConfigPatch({ 'review.model': 'deepseek-flash' })
    const text = presentSetConfigResult(plan, { ok: true, path: 'C:/p/cordis.yaml', error: null })
    expect(text).toContain('已更新')
    expect(text).toContain('review.model')
  })

  it('失败时说明原因并保留被拒字段', () => {
    const plan = planConfigPatch({ 'review.model': 'ok', 'review.bogus': 1 })
    const text = presentSetConfigResult(plan, { ok: false, path: 'C:/p/cordis.yaml', error: '宿主拒绝' })
    expect(text).toContain('未更新')
    expect(text).toContain('被拒绝')
    expect(text).toContain('review.bogus')
  })
})
