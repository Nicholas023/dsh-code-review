// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * select.test.ts —— 文件筛选流水线的契约测试。
 *
 * 核心断言：每个被排除的文件都有 reason code（不允许静默排除），
 * 且筛选顺序不可被绕过（敏感路径不能靠 include 捞回来）。
 */

import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../../src/git/diff-parser.js'
import { estimateFileTokens, globToRegExp, matchesAny, selectFiles } from '../../src/selection/select.js'

/** 构造一个简单的修改文件 diff。 */
function file(path: string, opts: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '', lines: [{ type: 'add', content: 'x', oldLine: null, newLine: 1 }] }],
    additions: 1,
    deletions: 0,
    ...opts,
  }
}

const baseOpts = { excludePaths: [], maxFileTokens: 10000 }

describe('筛选：排除原因', () => {
  it('删除的文件被排除并标注原因', () => {
    const r = selectFiles([file('a.ts', { status: 'deleted' })], baseOpts)
    expect(r.selected).toHaveLength(0)
    expect(r.excluded[0]!.reason).toBe('deleted')
  })

  it('二进制文件被排除', () => {
    const r = selectFiles([file('logo.png', { status: 'binary' })], baseOpts)
    expect(r.excluded[0]!.reason).toBe('binary')
  })

  it('敏感路径被排除，但进入 sensitive 点名清单', () => {
    const r = selectFiles([file('.env')], baseOpts)
    expect(r.selected).toHaveLength(0)
    expect(r.excluded[0]!.reason).toBe('sensitive')
    expect(r.sensitive).toEqual(['.env'])
  })

  it('敏感路径无法被 include 白名单捞回（安全不可绕过）', () => {
    const r = selectFiles([file('.env')], { ...baseOpts, includePaths: ['**/*'] })
    expect(r.selected).toHaveLength(0)
  })

  it('用户 exclude 命中', () => {
    const r = selectFiles([file('engine/a.go')], { ...baseOpts, excludePaths: ['engine/**'] })
    expect(r.excluded[0]!.reason).toBe('user-excluded')
  })

  it('默认排除目录命中', () => {
    const r = selectFiles([file('node_modules/x/index.js')], baseOpts)
    expect(r.excluded[0]!.reason).toBe('default-excluded-dir')
  })

  it('不支持的语言被排除', () => {
    const r = selectFiles([file('a.xyz')], { ...baseOpts, supportedExtensions: ['.ts'] })
    expect(r.excluded[0]!.reason).toBe('unsupported-language')
  })

  it('include 白名单可把不支持语言拉回', () => {
    const r = selectFiles([file('a.xyz')], { ...baseOpts, supportedExtensions: ['.ts'], includePaths: ['a.xyz'] })
    expect(r.selected).toHaveLength(1)
  })

  it('超出单文件预算的被排除并说明实际大小', () => {
    const big = file('big.ts', {
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '', lines: [{ type: 'add', content: 'y'.repeat(9000), oldLine: null, newLine: 1 }] }],
    })
    const r = selectFiles([big], { ...baseOpts, maxFileTokens: 100 })
    expect(r.excluded[0]!.reason).toBe('too-large')
    expect(r.excluded[0]!.detail).toContain('100')
  })
})

describe('glob 匹配', () => {
  it('** 匹配任意层级', () => {
    expect(globToRegExp('engine/**').test('engine/internal/agent/agent.go')).toBe(true)
  })

  it('* 不跨目录', () => {
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
  })

  it('matchesAny 对空数组返回 false', () => {
    expect(matchesAny('a.ts', [])).toBe(false)
  })
})

describe('token 粗估', () => {
  it('按内容字符数估算', () => {
    const f = file('a.ts', {
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '', lines: [{ type: 'add', content: 'x'.repeat(300), oldLine: null, newLine: 1 }] }],
    })
    expect(estimateFileTokens(f)).toBeGreaterThan(50)
  })
})
