// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * diff-parser.test.ts —— unified diff 解析的契约测试。
 *
 * 解析器错了，行号定位就全错，报告里每一行都会指错位置。
 * 所以逐格式覆盖：新增/删除/重命名/二进制/多 hunk/异常行。
 */

import { describe, expect, it } from 'vitest'
import { parseDiff, summarizeDiff } from '../../src/git/diff-parser.js'

describe('基础解析', () => {
  it('空输入返回空结果', () => {
    expect(parseDiff('').files).toEqual([])
  })

  it('解析单文件单 hunk，行号正确递增', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2-old',
      '+line2-new',
      '+line3-extra',
      ' line4',
    ].join('\n')
    const { files } = parseDiff(text)
    expect(files).toHaveLength(1)
    const f = files[0]!
    expect(f.newPath).toBe('src/a.ts')
    expect(f.hunks).toHaveLength(1)
    expect(f.additions).toBe(2)
    expect(f.deletions).toBe(1)

    const lines = f.hunks[0]!.lines
    expect(lines[0]).toMatchObject({ type: 'context', oldLine: 1, newLine: 1 })
    expect(lines[1]).toMatchObject({ type: 'del', oldLine: 2, newLine: null })
    expect(lines[2]).toMatchObject({ type: 'add', oldLine: null, newLine: 2 })
    expect(lines[3]).toMatchObject({ type: 'add', oldLine: null, newLine: 3 })
    expect(lines[4]).toMatchObject({ type: 'context', oldLine: 3, newLine: 4 })
  })

  it('识别新增文件', () => {
    const text = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
    ].join('\n')
    const f = parseDiff(text).files[0]!
    expect(f.status).toBe('added')
    expect(f.oldPath).toBeNull()
    expect(f.newPath).toBe('new.ts')
    expect(f.additions).toBe(2)
  })

  it('识别删除文件', () => {
    const text = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n')
    const f = parseDiff(text).files[0]!
    expect(f.status).toBe('deleted')
    expect(f.deletions).toBe(1)
  })

  it('识别重命名', () => {
    const text = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 95%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n')
    const f = parseDiff(text).files[0]!
    expect(f.status).toBe('renamed')
    expect(f.oldPath).toBe('old.ts')
    expect(f.newPath).toBe('new.ts')
  })

  it('识别二进制文件', () => {
    const text = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n')
    const f = parseDiff(text).files[0]!
    expect(f.status).toBe('binary')
    expect(f.hunks).toEqual([])
  })
})

describe('多文件与多 hunk', () => {
  it('解析多个文件', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n')
    const { files } = parseDiff(text)
    expect(files.map((f) => f.newPath)).toEqual(['a.ts', 'b.ts'])
  })

  it('同一文件多个 hunk', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '@@ -10 +10 @@',
      '-c',
      '+d',
    ].join('\n')
    const f = parseDiff(text).files[0]!
    expect(f.hunks).toHaveLength(2)
    expect(f.hunks[1]!.newStart).toBe(10)
  })
})

describe('边界与异常', () => {
  it('hunk 长度省略时按 1 处理', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -5 +7 @@',
      '-a',
      '+b',
    ].join('\n')
    const h = parseDiff(text).files[0]!.hunks[0]!
    expect(h.oldStart).toBe(5)
    expect(h.oldLines).toBe(1)
    expect(h.newStart).toBe(7)
  })

  it('无法识别的行进入 warnings 而不是被静默吞掉', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '??? unexpected',
    ].join('\n')
    const r = parseDiff(text)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('summarizeDiff 汇总状态与行数', () => {
    const files = parseDiff([
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      '-a',
      '+b',
      '+c',
    ].join('\n')).files
    const s = summarizeDiff(files)
    expect(s.fileCount).toBe(1)
    expect(s.additions).toBe(2)
    expect(s.deletions).toBe(1)
    expect(s.byStatus.modified).toBe(1)
  })
})
