// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * line-resolver.ts —— 把模型给出的行号收敛到「可信的位置」。
 *
 * 为什么需要这一层：模型报的行号经常不准（差一两行、指到函数头、
 * 或者干脆是猜的）。报告里如果直接把不准的行号当真相，
 * 用户点进去看到无关代码，整个工具的信任就没了。
 *
 * 收敛策略（逐级降级，每级都记录来源）：
 *   1. exact         —— 模型给的 line 确实落在新增/修改行上，直接采信
 *   2. diff-resolved —— 不在新增行，但 evidence 片段在 hunk 里唯一匹配到
 *   3. unresolved    —— 都不成立，明确标记「位置未定位」，绝不瞎猜
 *
 * 注意：**删除行不能作为最终评论位置**（那条代码已经不存在了）。
 */

import type { FileDiff, HunkLine } from '../git/diff-parser.js'
import type { LineSource } from '../domain/finding.js'

/** 定位结果。 */
export interface ResolvedLocation {
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly lineSource: LineSource
}

/** 收集某文件在新文件里「可评论」的行号集合（新增行 + 上下文行）。 */
function commentableLines(diff: FileDiff): Map<number, HunkLine> {
  const map = new Map<number, HunkLine>()
  for (const h of diff.hunks) {
    for (const line of h.lines) {
      if (line.newLine !== null) map.set(line.newLine, line)
    }
  }
  return map
}

/** 归一化文本用于匹配（去空白、统一大小写）。 */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 定位一条发现的位置。
 * @param diff   该文件的 diff（找不到时为 undefined）
 * @param line   模型给出的行号
 * @param evidence 证据片段
 */
export function resolveLocation(
  diff: FileDiff | undefined,
  line: number | null,
  evidence: string,
): ResolvedLocation {
  if (!diff || diff.hunks.length === 0) {
    return { lineStart: null, lineEnd: null, lineSource: 'unresolved' }
  }

  const commentable = commentableLines(diff)

  // ① 模型给的行号直接可信
  if (line !== null && commentable.has(line)) {
    return { lineStart: line, lineEnd: line, lineSource: 'exact' }
  }

  // ② 用证据片段在 hunk 里找唯一匹配
  const needle = normalize(evidence)
  if (needle.length >= 8) {
    const hits: number[] = []
    for (const [newLine, source] of commentable) {
      const hay = normalize(source.content)
      if (hay !== '' && (hay.includes(needle) || needle.includes(hay))) {
        hits.push(newLine)
      }
    }
    // 只有唯一命中才采信；多处命中说明证据不足以定位，宁可不猜
    if (hits.length === 1) {
      const only = hits[0]!
      return { lineStart: only, lineEnd: only, lineSource: 'diff-resolved' }
    }
  }

  // ③ 定位失败：明确标记，不瞎猜
  return { lineStart: null, lineEnd: null, lineSource: 'unresolved' }
}
