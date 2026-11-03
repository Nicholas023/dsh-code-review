// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * set-config.test.ts —— 程序化改配置的契约测试。
 *
 * 三条必须守住：
 *  1. 未知/只读/类型不符的字段**必须被拒绝且说明原因**（不静默丢弃）；
 *  2. 只改被点名的路径，配置里其他内容（尤其未知字段）原样保留；
 *  3. 数值越界钳制而不是报错（保留用户「想更大」的意图）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyConfigPatch, currentEditableValues, presentSetConfigResult } from '../../src/plugin/set-config.js'
import { configFilePath } from '../../src/store/paths.js'

const roots: string[] = []
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-setcfg-'))
  roots.push(d)
  mkdirSync(join(d, 'dsh-code-review'), { recursive: true })
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('合法字段', () => {
  it('写入字符串字段并回显', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'review.model': 'deepseek-flash' }, root)
    expect(r.ok).toBe(true)
    expect(r.applied).toContain('review.model')
    expect(r.effective['review.model']).toBe('deepseek-flash')
  })

  it('写入布尔字段', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'report.writeJson': false }, root)
    expect(r.ok).toBe(true)
    expect(r.effective['report.writeJson']).toBe(false)
  })

  it('字符串被 trim', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'review.endpoint': '  https://api.example.com  ' }, root)
    expect(r.effective['review.endpoint']).toBe('https://api.example.com')
  })

  it('数值越界被钳制而不是报错', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'execution.concurrency': 999 }, root)
    expect(r.ok).toBe(true)
    expect(r.effective['execution.concurrency']).toBe(32)
  })

  it('负数被抬到下限', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'budget.maxAgentRounds': -5 }, root)
    expect(r.effective['budget.maxAgentRounds']).toBe(1)
  })

  it('枚举字段只接受合法值', () => {
    const root = tempRoot()
    expect(applyConfigPatch({ 'review.protocol': 'anthropic' }, root).ok).toBe(false)
    expect(applyConfigPatch({ 'review.protocol': 'openai-chat-completions' }, root).ok).toBe(true)
  })
})

describe('拒绝与回显', () => {
  it('未知字段被拒绝并给出原因', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'review.nonexistent': 'x' }, root)
    expect(r.ok).toBe(false)
    expect(r.rejected[0]!.field).toBe('review.nonexistent')
    expect(r.rejected[0]!.reason).toContain('未知字段')
  })

  it('只读字段被拒绝', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'onboarding.firstRunCompleted': true }, root)
    expect(r.ok).toBe(false)
    expect(r.rejected[0]!.reason).toContain('只读')
  })

  it('类型不符被拒绝', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'review.model': 123 }, root)
    expect(r.ok).toBe(false)
    expect(r.rejected[0]!.reason).toContain('字符串')
  })

  it('缺 section 前缀的键被拒绝', () => {
    const root = tempRoot()
    expect(applyConfigPatch({ model: 'x' }, root).ok).toBe(false)
  })

  it('部分成功：合法字段写入，非法字段回显原因', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'review.model': 'ok', 'review.bogus': 1 }, root)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual(['review.model'])
    expect(r.rejected).toHaveLength(1)
    const text = presentSetConfigResult(r)
    expect(text).toContain('review.model')
    expect(text).toContain('被拒绝')
  })

  it('全部被拒时不写文件', () => {
    const root = tempRoot()
    const r = applyConfigPatch({ 'nope.nope': 1 }, root)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有任何字段被接受')
  })
})

describe('写入保真', () => {
  it('只改目标路径，未知字段原样保留', () => {
    const root = tempRoot()
    const file = configFilePath(root)
    writeFileSync(file, JSON.stringify({
      version: 2,
      review: { model: 'old', endpoint: 'https://keep.me' },
      myCustomThing: { nested: true },
    }), 'utf8')

    applyConfigPatch({ 'review.model': 'new' }, root)

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect((written.review as { model: string }).model).toBe('new')
    // 同区其他字段不能被顺手清掉
    expect((written.review as { endpoint: string }).endpoint).toBe('https://keep.me')
    // 未知顶层字段必须还在
    expect(written.myCustomThing).toEqual({ nested: true })
  })

  it('写入后能读回有效值', () => {
    const root = tempRoot()
    applyConfigPatch({ 'budget.maxChildren': 4 }, root)
    const values = currentEditableValues(root)
    expect(values['budget.maxChildren']).toBe(4)
  })

  it('损坏的配置文件拒绝写入（不覆盖用户数据）', () => {
    const root = tempRoot()
    const file = configFilePath(root)
    const broken = '{ broken'
    writeFileSync(file, broken, 'utf8')
    const r = applyConfigPatch({ 'review.model': 'x' }, root)
    expect(r.ok).toBe(false)
    // 原文件必须原封不动
    expect(readFileSync(file, 'utf8')).toBe(broken)
  })
})
