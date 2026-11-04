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
import { deriveControls, draftToOps, draftToPatch, parseNumberDraft, snapshotToDraft } from '../../src/client/logic.js'

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

describe('提交给宿主的 op 数组', () => {
  it('变过的字段生成 set op，path 是分段数组', () => {
    const baseline = { review: { model: 'a', endpoint: 'https://keep' } }
    const draft = { 'review.model': 'b', 'review.endpoint': 'https://keep' }
    expect(draftToOps(draft, baseline)).toEqual([
      { op: 'set', path: ['review', 'model'], value: 'b' },
    ])
  })

  it('没变时为空数组（不会把没动的字段也写一遍）', () => {
    expect(draftToOps({ 'review.model': 'a' }, { review: { model: 'a' } })).toEqual([])
  })

  it('基线里没有的字段也算变化', () => {
    expect(draftToOps({ 'review.endpoint': 'https://new' }, {})).toEqual([
      { op: 'set', path: ['review', 'endpoint'], value: 'https://new' },
    ])
  })

  it('多个分区一次提交', () => {
    const ops = draftToOps(
      { 'review.model': 'b', 'budget.maxChildren': 3 },
      { review: { model: 'a' }, budget: { maxChildren: 8 } },
    )
    expect(ops).toHaveLength(2)
    expect(ops.map((o) => o.path.join('.'))).toEqual(['review.model', 'budget.maxChildren'])
  })

  it('没有点号的脏路径被跳过（不让宿主收到非法 path）', () => {
    expect(draftToOps({ review: 'oops' }, {})).toEqual([])
  })
})

describe('数字文本 → 数字（保存时解析）', () => {
  const controls = deriveControls()

  it('小数能完整保留（这是修 bug 的原因：编辑期不让转数字）', () => {
    const r = parseNumberDraft({ 'budget.cacheReadPricePerMTok': '0.02' }, controls)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values['budget.cacheReadPricePerMTok']).toBe(0.02)
  })

  it('尾随小数点（编辑中间态）能解析', () => {
    const r = parseNumberDraft({ 'budget.inputPricePerMTok': '0.' }, controls)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values['budget.inputPricePerMTok']).toBe(0)
  })

  it('空字符串视为 0（这些字段的 0 表示未配置/不限）', () => {
    const r = parseNumberDraft({ 'budget.maxCost': '' }, controls)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values['budget.maxCost']).toBe(0)
  })

  it('非法文本被明确拒绝，并指出是哪个字段', () => {
    const r = parseNumberDraft({ 'budget.maxCost': 'abc' }, controls)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.field).toBe('budget.maxCost')
      expect(r.raw).toBe('abc')
    }
  })

  it('非数字控件里的字符串原样保留（例如凭据引用名）', () => {
    const r = parseNumberDraft({ 'review.credentialRef': 'COMMANDCODE_API_KEY' }, controls)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values['review.credentialRef']).toBe('COMMANDCODE_API_KEY')
  })

  it('解析后的值与基线比较能正确判定「有没有改」', () => {
    // 用户把 0.02 改成 0.03：应产生一条 op
    const ops = draftToOps({ 'budget.cacheReadPricePerMTok': 0.03 }, { budget: { cacheReadPricePerMTok: 0.02 } })
    expect(ops).toHaveLength(1)
    expect(ops[0]!.value).toBe(0.03)
  })
})
