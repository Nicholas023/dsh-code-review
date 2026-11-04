// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * git-integration.test.ts —— 用真实临时仓库验证 diff 采集。
 *
 * 单元测试可以用假 diff 文本，但 Git 语义（merge-base、未跟踪文件、
 * fail-closed）必须对着真 git 跑一遍，否则上线才发现语义对不上。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInsideRoot, resolveRepoRoot, runGit } from '../../src/git/command.js'
import { collectReviewDiff, listScanFiles } from '../../src/git/diff.js'

const dirs: string[] = []

/** 建一个临时 git 仓库。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcr-git-'))
  dirs.push(dir)
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  // 关闭自动换行转换，避免 Windows 上 diff 内容被改写影响断言
  git(['config', 'core.autocrlf', 'false'])
  return dir
}

function commit(repo: string, message: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['add', '-A'])
  git(['commit', '-q', '-m', message])
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('仓库识别', () => {
  it('识别真实仓库根', async () => {
    const repo = makeRepo()
    const root = await resolveRepoRoot(repo)
    expect(root).not.toBeNull()
  })

  it('非仓库返回 null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcr-nogit-'))
    dirs.push(dir)
    expect(await resolveRepoRoot(dir)).toBeNull()
  })

  it('isInsideRoot 正确判断前缀边界', () => {
    expect(isInsideRoot('/a/b', '/a/b/c')).toBe(true)
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true)
    // /a/bc 不在 /a/b 之内（前缀相似但不是子路径）
    expect(isInsideRoot('/a/b', '/a/bc')).toBe(false)
  })
})

describe('workspace 模式', () => {
  it('采集已跟踪文件的改动', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'const a = 1\n')
    commit(repo, 'init')
    writeFileSync(join(repo, 'a.ts'), 'const a = 2\n');
    const r = await collectReviewDiff(repo, {
      repoPath: repo, command: 'review', mode: 'uncommitted',
      baseRef: null, headRef: null, commit: null, focus: null, excludePaths: [],
    })
    expect(r.parsed.files.length).toBe(1)
    expect(r.parsed.files[0]!.newPath).toBe('a.ts')
    expect(r.parsed.files[0]!.additions).toBe(1)
  })

  it('未跟踪文件被合成为新增文件（不漏审新文件）', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    commit(repo, 'init')
    writeFileSync(join(repo, 'brand-new.ts'), 'export const n = 1\n')
    const r = await collectReviewDiff(repo, {
      repoPath: repo, command: 'review', mode: 'uncommitted',
      baseRef: null, headRef: null, commit: null, focus: null, excludePaths: [],
    })
    const names = r.parsed.files.map((f) => f.newPath)
    expect(names).toContain('brand-new.ts')
    const created = r.parsed.files.find((f) => f.newPath === 'brand-new.ts')!
    expect(created.status).toBe('added')
    expect(created.additions).toBe(1)
  })
})

describe('commit 模式', () => {
  it('缺 SHA 时 fail-closed（绝不退化成 workspace）', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    commit(repo, 'init')
    writeFileSync(join(repo, 'a.ts'), 'y\n')
    const r = await collectReviewDiff(repo, {
      repoPath: repo, command: 'review', mode: 'commit',
      baseRef: null, headRef: null, commit: '   ', focus: null, excludePaths: [],
    })
    expect(r.parsed.files).toHaveLength(0)
    expect(r.warnings.join()).toContain('提交号')
  })
})

describe('scan 文件枚举', () => {
  it('列出跟踪文件并排除忽略项', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    commit(repo, 'init')
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'dep.js'), 'x\n')
    const r = await listScanFiles(repo)
    expect(r.files).toContain('a.ts')
    expect(r.files).not.toContain('node_modules/dep.js')
  })
})

describe('runGit 安全边界', () => {
  it('参数不会被 shell 解释（路径带分号也安全）', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    commit(repo, 'init')
    // 分号在 shell 里是命令分隔符；参数数组传参时必须被当作字面量路径。
    // 若被解释，git 会报 unknown revision 之类的错误而不是正常退出。
    const r = await runGit(repo, ['log', '--oneline', '-1', '--', 'weird;name.ts'])
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })
})
