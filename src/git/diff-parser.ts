// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * diff-parser.ts —— unified diff 的结构化解析。
 *
 * 为什么必须自己解析而不是把 diff 文本整块丢给模型：
 *  - 行号定位需要「这一行在旧文件第几行、在新文件第几行」的精确映射，
 *    纯文本里没有这层结构，模型只能靠数行，数错就挂错位置；
 *  - 文件级筛选（二进制/删除/重命名）需要确定性判断，不能靠模型猜；
 *  - 新增/删除行数要当作规模量纲（决定要不要派子 agent）。
 *
 * 解析策略：逐行状态机。遇到 `diff --git` 开新文件，遇到 `@@` 开新 hunk，
 * 其余按行首字符归类。任何不明行都不静默吞掉 —— 记进 warnings，
 * 由调用方决定是拒绝整次评审还是降级。
 */

/** 单行类型。 */
export type HunkLineType = 'context' | 'add' | 'del' | 'no-newline'

/** hunk 内的一行。 */
export interface HunkLine {
  readonly type: HunkLineType
  /** 行内容（不含行首的 +/-/空格标记）。 */
  readonly content: string
  /** 在旧文件中的行号（add 行为 null）。 */
  readonly oldLine: number | null
  /** 在新文件中的行号（del 行为 null）。 */
  readonly newLine: number | null
}

/** 一个 hunk（连续的改动块）。 */
export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** 原始 hunk 头（含函数上下文，便于模型理解位置）。 */
  readonly header: string
  readonly lines: readonly HunkLine[]
}

/** 文件改动状态。 */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'

/** 单个文件的 diff。 */
export interface FileDiff {
  /** 旧路径（新增文件为 null）。 */
  readonly oldPath: string | null
  /** 新路径（删除文件仍保留最后路径）。 */
  readonly newPath: string
  /** 改动状态。 */
  readonly status: FileChangeStatus
  /** hunk 列表（二进制/无内容改动时为空）。 */
  readonly hunks: readonly DiffHunk[]
  /** 新增行数。 */
  readonly additions: number
  /** 删除行数。 */
  readonly deletions: number
}

/** 解析结果。 */
export interface ParsedDiff {
  readonly files: readonly FileDiff[]
  /** 解析过程中遇到的异常行（不静默丢弃）。 */
  readonly warnings: readonly string[]
}

/** 从 `diff --git a/x b/y` 中提取两个路径。 */
function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  // 形如：diff --git a/src/a.ts b/src/b.ts
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  if (!m) return null
  return { oldPath: m[1]!, newPath: m[2]! }
}

/** 从 `@@ -1,2 +3,4 @@ ctx` 中提取范围。 */
function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
  if (!m) return null
  return {
    oldStart: Number(m[1]),
    // 省略长度时默认 1（git 的简写约定）
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    header: m[5] ?? '',
  }
}

/**
 * 解析 unified diff 文本。
 * @param text git diff 的输出（可为空串）
 */
export function parseDiff(text: string): ParsedDiff {
  const files: FileDiff[] = []
  const warnings: string[] = []

  if (text.trim() === '') return { files, warnings }

  const lines = text.split(/\r?\n/)

  /** 当前正在构建的文件。 */
  let cur: {
    oldPath: string | null
    newPath: string
    status: FileChangeStatus
    hunks: DiffHunk[]
    additions: number
    deletions: number
  } | null = null

  /** 当前 hunk 的构建状态。 */
  let hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: HunkLine[] } | null = null
  /** hunk 内的游标（旧/新文件行号）。 */
  let oldCursor = 0
  let newCursor = 0

  /** 收尾当前 hunk。 */
  const flushHunk = () => {
    if (!hunk) return
    cur?.hunks.push({ ...hunk, lines: hunk.lines })
    hunk = null
  }

  /** 收尾当前文件。 */
  const flushFile = () => {
    flushHunk()
    if (!cur) return
    files.push({
      oldPath: cur.oldPath,
      newPath: cur.newPath,
      status: cur.status,
      hunks: cur.hunks,
      additions: cur.additions,
      deletions: cur.deletions,
    })
    cur = null
  }

  for (const line of lines) {
    // —— 新文件 ——
    if (line.startsWith('diff --git ')) {
      flushFile()
      const paths = parseDiffGitLine(line)
      if (!paths) {
        warnings.push(`无法解析 diff --git 行：${line.slice(0, 120)}`)
        continue
      }
      cur = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        status: 'modified',
        hunks: [],
        additions: 0,
        deletions: 0,
      }
      continue
    }

    if (!cur) {
      // 文件头之前的行（如 index 行）合法，忽略即可；但非空未知行要记录
      if (line.trim() !== '' && !line.startsWith('index ')) {
        warnings.push(`文件头之外的行：${line.slice(0, 120)}`)
      }
      continue
    }

    // —— 文件级元数据 ——
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue }
    if (line.startsWith('rename from ')) { cur.oldPath = line.slice('rename from '.length); cur.status = 'renamed'; continue }
    if (line.startsWith('rename to ')) { cur.newPath = line.slice('rename to '.length); cur.status = 'renamed'; continue }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') { cur.status = 'binary'; continue }
    if (line.startsWith('index ') || line.startsWith('similarity index') || line.startsWith('dissimilarity index')) continue
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim()
      // /dev/null 表示新增文件
      cur.oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      if (p !== '/dev/null') cur.newPath = p.replace(/^b\//, '')
      continue
    }

    // —— hunk 头 ——
    if (line.startsWith('@@')) {
      flushHunk()
      const h = parseHunkHeader(line)
      if (!h) {
        warnings.push(`无法解析 hunk 头：${line.slice(0, 120)}`)
        continue
      }
      hunk = { ...h, lines: [] }
      oldCursor = h.oldStart
      newCursor = h.newStart
      continue
    }

    // —— hunk 内容 ——
    if (hunk) {
      const marker = line[0]
      if (marker === '\\') {
        // \ No newline at end of file
        hunk.lines.push({ type: 'no-newline', content: line.slice(1).trim(), oldLine: null, newLine: null })
        continue
      }
      if (marker === '+') {
        hunk.lines.push({ type: 'add', content: line.slice(1), oldLine: null, newLine: newCursor })
        cur.additions += 1
        newCursor += 1
        continue
      }
      if (marker === '-') {
        hunk.lines.push({ type: 'del', content: line.slice(1), oldLine: oldCursor, newLine: null })
        cur.deletions += 1
        oldCursor += 1
        continue
      }
      // 上下文行：以空格开头（某些工具会省略空格，空行也视作上下文）
      if (marker === ' ' || line === '') {
        hunk.lines.push({ type: 'context', content: line.slice(1), oldLine: oldCursor, newLine: newCursor })
        oldCursor += 1
        newCursor += 1
        continue
      }
      // 落在 hunk 内却无法识别：记录但不中断（可能是扩展格式）
      warnings.push(`hunk 内无法识别的行：${line.slice(0, 120)}`)
      continue
    }
  }

  flushFile()
  return { files, warnings }
}

/** 汇总规模：文件数、改动行数、各状态计数。 */
export interface DiffSummary {
  readonly fileCount: number
  readonly additions: number
  readonly deletions: number
  readonly byStatus: Readonly<Record<FileChangeStatus, number>>
}

/** 计算 diff 汇总。 */
export function summarizeDiff(files: readonly FileDiff[]): DiffSummary {
  const byStatus: Record<FileChangeStatus, number> = { added: 0, modified: 0, deleted: 0, renamed: 0, binary: 0 }
  let additions = 0
  let deletions = 0
  for (const f of files) {
    byStatus[f.status] += 1
    additions += f.additions
    deletions += f.deletions
  }
  return { fileCount: files.length, additions, deletions, byStatus }
}
