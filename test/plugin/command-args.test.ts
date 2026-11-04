// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * command-args.test.ts —— `/review` 参数解析的契约测试。
 *
 * 这个解析器的存在本身就是修复：此前命令的提示写着可传 repo/mode/focus，
 * 但 handler 完全不看 rawInput，永远用会话 cwd。测试锁住"提示与行为一致"。
 */

import { describe, expect, it } from 'vitest'
import { parseReviewCommand } from '../../src/plugin/command-args.js'

/** 什么都不存在的 exists（避免测试受本机文件影响）。 */
const none = { exists: () => false }

describe('空输入', () => {
  it('什么都不传时不给任何参数（交给 submitReview 用 cwd 兜底）', () => {
    expect(parseReviewCommand('', none).args).toEqual({})
    expect(parseReviewCommand('   ', none).args).toEqual({})
  })
})

describe('位置参数', () => {
  it('盘符路径被认成 repo_path', () => {
    expect(parseReviewCommand('D:/repo', none).args.repo_path).toBe('D:/repo')
  })

  it('模式关键字被认成 mode', () => {
    expect(parseReviewCommand('scan', none).args).toEqual({ mode: 'scan' })
  })

  it('路径 + 模式', () => {
    expect(parseReviewCommand('D:/repo scan', none).args).toEqual({ repo_path: 'D:/repo', mode: 'scan' })
  })

  it('模式 + 重点（重点保留原文顺序）', () => {
    expect(parseReviewCommand('scan 重点看并发与资源泄漏', none).args).toEqual({
      mode: 'scan',
      focus: '重点看并发与资源泄漏',
    })
  })

  it('路径 + 模式 + 重点', () => {
    expect(parseReviewCommand('D:/repo uncommitted 鉴权', none).args).toEqual({
      repo_path: 'D:/repo',
      mode: 'uncommitted',
      focus: '鉴权',
    })
  })

  it('存在的相对路径也能被认出来', () => {
    const r = parseReviewCommand('.', { exists: () => true })
    expect(r.args.repo_path).toBe('.')
  })

  it('模式关键字大小写不敏感', () => {
    expect(parseReviewCommand('SCAN', none).args.mode).toBe('scan')
  })
})

describe('key=value 写法', () => {
  it('repo= 覆盖路径', () => {
    expect(parseReviewCommand('repo=D:/x', none).args.repo_path).toBe('D:/x')
  })

  it('commit= 隐含 mode=commit', () => {
    expect(parseReviewCommand('commit=abc123', none).args).toEqual({ commit: 'abc123', mode: 'commit' })
  })

  it('branch 模式带 base/head', () => {
    expect(parseReviewCommand('D:/r branch base=main head=dev', none).args).toEqual({
      repo_path: 'D:/r',
      mode: 'branch',
      base_ref: 'main',
      head_ref: 'dev',
    })
  })

  it('focus= 与位置重点合并', () => {
    expect(parseReviewCommand('scan focus=并发 补充说明', none).args).toEqual({
      mode: 'scan',
      focus: '并发 补充说明',
    })
  })

  it('未知 mode 值给出提示且不设 mode', () => {
    const r = parseReviewCommand('mode=fast', none)
    expect(r.args.mode).toBeUndefined()
    expect(r.notes.join()).toContain('未知 mode')
  })

  it('空值给出提示', () => {
    const r = parseReviewCommand('base=', none)
    expect(r.notes.join()).toContain('没有值')
  })
})

describe('不误伤', () => {
  it('带等号的普通文字留在 focus 里', () => {
    const r = parseReviewCommand('检查 a=b 这种写法', none)
    expect(r.args.focus).toBe('检查 a=b 这种写法')
  })

  it('模式关键字只吃第一次，后面的当重点', () => {
    const r = parseReviewCommand('scan scan 两个字', none)
    expect(r.args.mode).toBe('scan')
    expect(r.args.focus).toBe('scan 两个字')
  })
})
