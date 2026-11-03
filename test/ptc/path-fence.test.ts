// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * path-fence.test.ts —— 路径围栏的安全测试。
 *
 * 这是整个沙箱最关键的一层：它漏了，模型就能读到仓库外的任意文件。
 * 每一条攻击向量都必须有对应断言，不能只测正常路径。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRegularFile, isUnder, resolveInsideRoot } from '../../src/ptc/path-fence.js'

const dirs: string[] = []

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-fence-'))
  dirs.push(d)
  mkdirSync(join(d, 'src'), { recursive: true })
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1\n')
  return d
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('路径围栏：拒绝逃逸', () => {
  it('拒绝相对路径逃逸 ..', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, '../secret.txt').ok).toBe(false)
  })

  it('拒绝深层逃逸 ../../', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, 'src/../../outside.txt').ok).toBe(false)
  })

  it('拒绝 Windows 绝对路径', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, 'C:/Windows/system32/config/sam').ok).toBe(false)
  })

  it('拒绝 Unix 绝对路径', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, '/etc/passwd').ok).toBe(false)
  })

  it('拒绝 UNC 路径', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, '//server/share/x').ok).toBe(false)
  })

  it('拒绝空路径', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, '   ').ok).toBe(false)
  })
})

describe('路径围栏：放行合法路径', () => {
  it('普通相对路径通过', () => {
    const root = makeRoot()
    const r = resolveInsideRoot(root, 'src/a.ts')
    expect(r.ok).toBe(true)
  })

  it('反斜杠路径被归一后通过', () => {
    const root = makeRoot()
    const r = resolveInsideRoot(root, 'src\\a.ts')
    expect(r.ok).toBe(true)
  })

  it('根内不存在的路径仍返回 ok（由上层报未找到）', () => {
    const root = makeRoot()
    expect(resolveInsideRoot(root, 'src/nope.ts').ok).toBe(true)
  })
})

describe('isUnder 前缀边界', () => {
  it('相同路径视为在内部', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true)
  })

  it('子路径在内部', () => {
    expect(isUnder('/a/b', '/a/b/c')).toBe(true)
  })

  it('前缀相似但不是子目录时不误判', () => {
    expect(isUnder('/a/b', '/a/bc')).toBe(false)
  })
})

describe('普通文件校验', () => {
  it('普通文件通过', () => {
    const root = makeRoot()
    expect(assertRegularFile(join(root, 'src', 'a.ts'))).toBeNull()
  })

  it('目录被拒绝', () => {
    const root = makeRoot()
    expect(assertRegularFile(join(root, 'src'))).toBe('目标不是普通文件')
  })

  it('不存在的路径被拒绝', () => {
    const root = makeRoot()
    expect(assertRegularFile(join(root, 'nope.txt'))).not.toBeNull()
  })
})

describe('符号链接逃逸', () => {
  it('指向仓库外的符号链接被拒绝', () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dcr-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
    const link = join(root, 'escape')
    let linked = true
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      linked = false
    }
    if (!linked) return // 无权限创建链接时跳过（Windows 需要开发者模式）
    const r = resolveInsideRoot(root, 'escape/secret.txt')
    expect(r.ok).toBe(false)
  })
})
