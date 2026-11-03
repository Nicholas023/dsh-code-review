// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * logic.test.ts —— 设置面板的纯逻辑测试。
 *
 * 组件本身需要 DOM 才能渲染（我们没有 jsdom），但**决定它行为的纯函数**
 * 是完全可以测的，而且它们才是出错会伤人的地方：
 *  - 控件派生：字段漏渲染 → 用户改不了；
 *  - 草稿 diff：多提交没改的字段 → 覆盖别人刚存的值；
 *  - 快照拉平：路径解析错 → 显示成空值。
 */

import { describe, expect, it } from 'vitest'
import { deriveControls, draftToPatch, snapshotToDraft } from '../../src/client/logic.js'

describe('控件派生', () => {
  it('派生出的控件都带路径、标签与说明', () => {
    for (const c of deriveControls()) {
      expect(c.path).toMatch(/^[a-z]+\.[A-Za-z]+$/)
      expect(c.label).toBeTruthy()
      expect(typeof c.hint).toBe('string')
    }
  })

  it('只渲染可编辑标量（跳过只读与复合字段）', () => {
    const paths = deriveControls().map((c) => c.path)
    // onboarding.firstRunCompleted 是只读展示项
    expect(paths).not.toContain('onboarding.firstRunCompleted')
    // review 分区本身是 object，不应作为控件
    expect(paths).not.toContain('review')
  })

  it('覆盖五个可编辑分区', () => {
    const sections = new Set(deriveControls().map((c) => c.section))
    expect([...sections].sort()).toEqual(['budget', 'execution', 'report', 'review', 'sizing'])
  })

  it('顺序稳定（同一进程内两次派生结果一致）', () => {
    expect(deriveControls().map((c) => c.path)).toEqual(deriveControls().map((c) => c.path))
  })

  it('关键字段都在（端点/凭据/模型）', () => {
    const paths = deriveControls().map((c) => c.path)
    expect(paths).toContain('review.endpoint')
    expect(paths).toContain('review.credentialRef')
    expect(paths).toContain('review.model')
  })

  it('数值字段带上下限（供控件钳制）', () => {
    const c = deriveControls().find((x) => x.path === 'execution.concurrency')!
    expect(c.min).toBe(1)
    expect(c.max).toBe(32)
  })

  it('枚举字段带 options', () => {
    const c = deriveControls().find((x) => x.path === 'review.protocol')!
    expect(c.options).toEqual(['openai-chat-completions'])
  })
})

describe('快照拉平', () => {
  const controls = deriveControls()

  it('把分区结构拉平成扁平路径', () => {
    const draft = snapshotToDraft({ review: { endpoint: 'https://x', model: 'm' } }, controls)
    expect(draft['review.endpoint']).toBe('https://x')
    expect(draft['review.model']).toBe('m')
  })

  it('缺失字段不出现在草稿里（不伪造空值）', () => {
    const draft = snapshotToDraft({ review: { model: 'm' } }, controls)
    expect('review.endpoint' in draft).toBe(false)
  })

  it('undefined 快照返回空草稿', () => {
    expect(snapshotToDraft(undefined, controls)).toEqual({})
  })
})

describe('草稿 diff', () => {
  it('只有变过的字段进入 patch', () => {
    const baseline = { review: { model: 'a', endpoint: 'https://keep' } }
    const draft = { 'review.model': 'b', 'review.endpoint': 'https://keep' }
    const patch = draftToPatch(draft, baseline)
    expect(patch.review).toEqual({ model: 'b' })
    // 没变的端点不能被提交（否则会覆盖别人刚写的值）
    expect(patch.review?.endpoint).toBeUndefined()
  })

  it('完全没变时返回空 patch', () => {
    const baseline = { review: { model: 'a' } }
    expect(draftToPatch({ 'review.model': 'a' }, baseline)).toEqual({})
  })

  it('跨分区改动分别归组', () => {
    const baseline = { review: { model: 'a' }, budget: { maxChildren: 8 } }
    const patch = draftToPatch({ 'review.model': 'b', 'budget.maxChildren': 3 }, baseline)
    expect(Object.keys(patch).sort()).toEqual(['budget', 'review'])
  })

  it('新增字段（基线里没有）也算变化', () => {
    const patch = draftToPatch({ 'review.endpoint': 'https://new' }, {})
    expect(patch.review).toEqual({ endpoint: 'https://new' })
  })
})
