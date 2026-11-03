// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * sdk.test.ts —— 三个只读工具的契约测试。
 *
 * 重点不是「能读到」，而是「读到不该读的东西时必须明确拒绝或声明不完整」。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { globFiles } from '../../src/ptc/glob.js'
import { grepFiles } from '../../src/ptc/grep.js'
import { readFileRange } from '../../src/ptc/read.js'

const dirs: string[] = []

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-sdk-'))
  dirs.push(d)
  mkdirSync(join(d, 'src'), { recursive: true })
  writeFileSync(join(d, 'src', 'a.ts'), 'line1\nline2\nline3\nline4\nline5\n')
  writeFileSync(join(d, '.env'), 'SECRET=1\n')
  return d
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('read', () => {
  it('读取完整小文件返回 completed', () => {
    const root = makeRoot()
    const r = readFileRange(root, { path: 'src/a.ts' })
    expect(r.status).toBe('completed')
    if (r.status !== 'completed') return
    expect(r.data.lines).toHaveLength(5)
    expect(r.data.lines[0]).toEqual({ n: 1, text: 'line1' })
  })

  it('超过 limit 返回 partial 并给出续取偏移', () => {
    const root = makeRoot()
    const r = readFileRange(root, { path: 'src/a.ts', limit: 2 })
    expect(r.status).toBe('partial')
    if (r.status !== 'partial') return
    expect(r.data.lines).toHaveLength(2)
    expect(r.coverage.total).toBe(5)
    expect(r.continuation).toEqual({ kind: 'offset', offset: 3 })
  })

  it('offset 生效', () => {
    const root = makeRoot()
    const r = readFileRange(root, { path: 'src/a.ts', offset: 3, limit: 2 })
    if (r.status !== 'completed' && r.status !== 'partial') return
    expect(r.data.lines[0]!.n).toBe(3)
  })

  it('敏感文件被拒绝且不泄露内容', () => {
    const root = makeRoot()
    const r = readFileRange(root, { path: '.env' })
    expect(r.status).toBe('rejected')
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('路径逃逸被拒绝', () => {
    const root = makeRoot()
    const r = readFileRange(root, { path: '../../etc/passwd' })
    expect(r.status).toBe('rejected')
  })
})

describe('glob', () => {
  it('按模式匹配文件', () => {
    const root = makeRoot()
    const r = globFiles(root, { patterns: ['src/**/*.ts'] })
    expect(r.status).toBe('completed')
    if (r.status !== 'completed') return
    expect(r.data.files).toContain('src/a.ts')
  })

  it('敏感文件不出现在结果里', () => {
    const root = makeRoot()
    const r = globFiles(root, { patterns: ['**/*'] })
    if (r.status !== 'completed' && r.status !== 'partial') return
    expect(r.data.files).not.toContain('.env')
  })

  it('空模式被拒绝', () => {
    const root = makeRoot()
    expect(globFiles(root, { patterns: [] }).status).toBe('rejected')
  })

  it('结果稳定排序', () => {
    const root = makeRoot()
    const a = globFiles(root, { patterns: ['**/*'] })
    const b = globFiles(root, { patterns: ['**/*'] })
    // 只放行有数据的两种状态，其余（rejected/error）直接返回
    if (a.status !== 'completed' && a.status !== 'partial') return
    if (b.status !== 'completed' && b.status !== 'partial') return
    expect(a.data.files).toEqual(b.data.files)
  })
})

describe('grep', () => {
  it('找到匹配并给出行号', () => {
    const root = makeRoot()
    const r = grepFiles(root, ['src/a.ts'], { pattern: 'line3' })
    expect(r.status).toBe('completed')
    if (r.status !== 'completed') return
    expect(r.data.matches).toHaveLength(1)
    expect(r.data.matches[0]!.line).toBe(3)
  })

  it('非法正则在编译期被拒绝（不抛异常）', () => {
    const root = makeRoot()
    const r = grepFiles(root, ['src/a.ts'], { pattern: '(' })
    expect(r.status).toBe('rejected')
  })

  it('超长正则被拒绝（防 ReDoS 面扩大）', () => {
    const root = makeRoot()
    const r = grepFiles(root, ['src/a.ts'], { pattern: 'a'.repeat(600) })
    expect(r.status).toBe('rejected')
  })

  it('敏感文件不参与搜索', () => {
    const root = makeRoot()
    const r = grepFiles(root, ['.env'], { pattern: 'SECRET' })
    if (r.status !== 'completed' && r.status !== 'partial') return
    expect(r.data.matches).toHaveLength(0)
  })
})
