// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * diff.ts —— 按评审范围采集 diff（review 三模式 + scan 文件枚举）。
 *
 * 三种 review 模式的 Git 语义（与 0.1.3 保持一致，不得擅自更改）：
 *  - workspace：`git diff HEAD` 取得已跟踪文件的改动，再**合成未跟踪文件**
 *    （未跟踪文件在 git diff 里根本不存在，不合成就会漏审新文件）；
 *  - range：用 `git merge-base(from, to)` 得到共同祖先，再 diff `base..to`。
 *    裸 `from..to` 会把基线分支上的无关提交也算进来，评审结果对不上「这个分支改了什么」；
 *  - commit：`git show --diff-merges=first-parent`，只取该提交相对第一父提交的改动。
 *
 * scan 与 review 的区别：scan 审整个文件内容而非 diff，所以只枚举文件，不取 diff。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewScope } from '../domain/review.js'
import { runGit } from './command.js'
import { parseDiff, type DiffHunk, type FileDiff, type ParsedDiff } from './diff-parser.js'

/** 未跟踪文件参与评审时的大小上限（超过则跳过并给出警告，避免把巨型产物读进来）。 */
export const UNTRACKED_MAX_BYTES = 1_000_000

/** 采集结果：解析后的 diff + 采集过程中的警告。 */
export interface CollectResult {
  readonly parsed: ParsedDiff
  readonly warnings: readonly string[]
}

/** 把文本按行切分（统一 LF，去掉末尾空行）。 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  // 末尾换行会产生一个空元素，去掉它（否则会多出一条空的新增行）
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 把一个整文件合成为「整文件都是新增」的 FileDiff。
 *
 * 两个地方在用：
 *  - 工作区模式：未跟踪的新文件（本来是完整内容，只是还没进 git）；
 *  - 全仓扫描：scan 没有 diff，必须靠它把文件变成「有体积、有内容」的条目。
 *    否则下游的规模估算、超大文件过滤、提示词内容全是 0，模型等于盲审。
 * 这样模型看到的形状与新增文件完全一致，下游不需要任何特殊分支。
 */
export function synthesizeWholeFile(repoPath: string, relPath: string): { diff: FileDiff | null; warning: string | null } {
  const abs = join(repoPath, relPath)
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { diff: null, warning: `跳过非普通文件：${relPath}` }
    if (st.size > UNTRACKED_MAX_BYTES) {
      return { diff: null, warning: `跳过超大未跟踪文件（${st.size} 字节）：${relPath}` }
    }
    const content = readFileSync(abs, 'utf8')
    // 含 NUL 字节视作二进制，不送审
    if (content.includes('\u0000')) {
      return {
        diff: { oldPath: null, newPath: relPath, status: 'binary', hunks: [], additions: 0, deletions: 0 },
        warning: null,
      }
    }
    const lines = splitLines(content)
    const hunk: DiffHunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      header: '',
      lines: lines.map((text, i) => ({ type: 'add' as const, content: text, oldLine: null, newLine: i + 1 })),
    }
    return {
      diff: {
        oldPath: null,
        newPath: relPath,
        status: 'added',
        hunks: [hunk],
        additions: lines.length,
        deletions: 0,
      },
      warning: null,
    }
  } catch (error) {
    return { diff: null, warning: `读取未跟踪文件失败：${relPath}（${error instanceof Error ? error.message : String(error)}）` }
  }
}

/** 通用的 diff 文本采集：跑 git 命令 → 解析 → 记录失败。 */
async function collectFromGit(repoPath: string, args: readonly string[]): Promise<CollectResult> {
  const r = await runGit(repoPath, args)
  if (!r.ok) {
    const reason = r.timedOut ? 'git 超时' : r.truncated ? 'git 输出超限' : `git 退出码 ${r.code}`
    return {
      parsed: { files: [], warnings: [`${reason}：${r.stderr.trim().slice(0, 500)}`] },
      warnings: [],
    }
  }
  const parsed = parseDiff(r.stdout)
  return { parsed, warnings: parsed.warnings }
}

/**
 * 采集一次 review 的 diff。
 * @param repoPath 仓库根（绝对路径）
 * @param scope    评审范围
 */
export async function collectReviewDiff(repoPath: string, scope: ReviewScope): Promise<CollectResult> {
  const warnings: string[] = []

  // 公共参数：统一格式，禁止外部 diff 工具干扰（否则解析器会收到非标准输出）
  const common = ['--no-color', '--no-ext-diff', '-U3']

  if (scope.mode === 'branch') {
    const base = scope.baseRef ?? 'main'
    const head = scope.headRef ?? 'HEAD'
    // 关键：先用 merge-base 求共同祖先，再 diff 祖先..head
    const mb = await runGit(repoPath, ['merge-base', base, head], { okCodes: [0] })
    if (!mb.ok || mb.stdout.trim() === '') {
      return {
        parsed: { files: [], warnings: [] },
        warnings: [`无法计算 merge-base（${base} vs ${head}）：${mb.stderr.trim().slice(0, 300) || '无共同祖先'}`],
      }
    }
    const ancestor = mb.stdout.trim()
    const res = await collectFromGit(repoPath, ['diff', ...common, `${ancestor}..${head}`])
    return { parsed: res.parsed, warnings: [...warnings, ...res.warnings] }
  }

  if (scope.mode === 'commit') {
    const sha = (scope.commit ?? '').trim()
    // fail-closed：缺 SHA 直接失败，绝不静默退化成 workspace（issue #10 的不变量）
    if (sha === '') {
      return {
        parsed: { files: [], warnings: [] },
        warnings: ['commit 模式缺少提交号：请提供 commit SHA'],
      }
    }
    const res = await collectFromGit(repoPath, ['show', ...common, '--diff-merges=first-parent', '--format=', sha])
    return { parsed: res.parsed, warnings: [...warnings, ...res.warnings] }
  }

  // workspace（默认）：已跟踪改动 + 未跟踪文件合成
  const tracked = await collectFromGit(repoPath, ['diff', ...common, 'HEAD'])
  const files: FileDiff[] = [...tracked.parsed.files]
  warnings.push(...tracked.warnings)

  const untracked = await runGit(repoPath, ['ls-files', '--others', '--exclude-standard'])
  if (!untracked.ok) {
    warnings.push(`枚举未跟踪文件失败：${untracked.stderr.trim().slice(0, 300)}`)
  } else {
    const existing = new Set(files.map((f) => f.newPath))
    for (const raw of untracked.stdout.split(/\r?\n/)) {
      const rel = raw.trim()
      if (rel === '' || existing.has(rel)) continue
      const made = synthesizeWholeFile(repoPath, rel)
      if (made.warning) warnings.push(made.warning)
      if (made.diff) files.push(made.diff)
    }
  }

  return { parsed: { files, warnings: tracked.parsed.warnings }, warnings }
}

/**
 * 枚举全仓评审的文件（scan 模式）。
 * 只返回 git 跟踪的文件 + 未被忽略的未跟踪文件，天然排除构建产物与依赖目录。
 */
export async function listScanFiles(repoPath: string): Promise<{ files: readonly string[]; warnings: readonly string[] }> {
  const warnings: string[] = []
  const tracked = await runGit(repoPath, ['ls-files'])
  if (!tracked.ok) {
    return { files: [], warnings: [`枚举文件失败：${tracked.stderr.trim().slice(0, 300)}`] }
  }
  const set = new Set<string>()
  for (const line of tracked.stdout.split(/\r?\n/)) {
    const p = line.trim()
    if (p !== '') set.add(p)
  }
  const untracked = await runGit(repoPath, ['ls-files', '--others', '--exclude-standard'])
  if (untracked.ok) {
    for (const line of untracked.stdout.split(/\r?\n/)) {
      const p = line.trim()
      if (p !== '') set.add(p)
    }
  } else {
    warnings.push(`枚举未跟踪文件失败：${untracked.stderr.trim().slice(0, 300)}`)
  }
  return { files: [...set].sort(), warnings }
}
