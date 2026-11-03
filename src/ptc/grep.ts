// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * grep.ts —— 有界内容搜索。
 *
 * 这里最危险的不是慢，是 **ReDoS**：模型可以写出灾难性回溯的正则。
 * 对策不是「事后超时」（回溯卡住时事件循环根本轮不到定时器），而是：
 *  - 限制正则长度；
 *  - 限制单行长度（超长行不参与匹配）；
 *  - 限制总匹配次数与扫描文件数；
 *  - 整个 grep 在独立子进程里跑，即便卡死也只影响 runner，内核能杀掉它。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp } from '../selection/select.js'
import { isSensitivePath } from '../selection/sensitive.js'
import { assertRegularFile, resolveInsideRoot } from './path-fence.js'
import {
  GREP_CONTEXT_MAX,
  GREP_PATTERN_MAX_LENGTH,
  GREP_RESULTS_DEFAULT,
  GREP_RESULTS_MAX,
  type GrepArgs,
  type GrepData,
  type GrepMatch,
  type ToolResult,
} from './types.js'

/** 单行参与匹配的最大长度（超过则截断后再匹配，避免超长行拖垮正则）。 */
const MAX_LINE_LENGTH = 2_000

/** 单个文件读取上限。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * 在仓库内搜索正则。
 * @param root    仓库根
 * @param fileList 预先枚举好的文件清单（由 glob 或 scan 提供，避免重复遍历）
 * @param args    参数
 */
export function grepFiles(root: string, fileList: readonly string[], args: GrepArgs): ToolResult<GrepData> {
  const source = typeof args.pattern === 'string' ? args.pattern : ''
  if (source === '') {
    return {
      status: 'rejected',
      error: { code: 'INPUT_INVALID_ARGUMENT', message: 'pattern 不能为空', retry: 'after-input-change', effectState: 'none' },
    }
  }
  if (source.length > GREP_PATTERN_MAX_LENGTH) {
    return {
      status: 'rejected',
      error: {
        code: 'INPUT_INVALID_ARGUMENT',
        message: `正则过长（${source.length} > ${GREP_PATTERN_MAX_LENGTH}），请简化`,
        retry: 'after-input-change',
        effectState: 'none',
      },
    }
  }

  let re: RegExp
  try {
    re = new RegExp(source, args.ignoreCase === true ? 'i' : '')
  } catch (error) {
    return {
      status: 'rejected',
      error: {
        code: 'INPUT_INVALID_ARGUMENT',
        message: `正则无法编译：${error instanceof Error ? error.message : String(error)}`,
        retry: 'after-input-change',
        effectState: 'none',
      },
    };
  }

  const maxResults = Math.min(GREP_RESULTS_MAX, Math.max(1, Math.floor(args.maxResults ?? GREP_RESULTS_DEFAULT)))
  const contextLines = Math.min(GREP_CONTEXT_MAX, Math.max(0, Math.floor(args.contextLines ?? 0)))
  const globIncludes = (args.glob ?? []).map((g) => globToRegExp(g))

  const matches: GrepMatch[] = []
  let searched = 0
  let truncated = false

  for (const rel of fileList) {
    if (matches.length >= maxResults) { truncated = true; break }
    if (isSensitivePath(rel)) continue;
    // 只允许仓库内路径（fileList 理论可信，但仍过一道围栏）
    const fence = resolveInsideRoot(root, rel)
    if (!fence.ok) continue;
    if (globIncludes.length > 0 && !globIncludes.some((g) => g.test(rel))) continue;
    if (assertRegularFile(fence.absPath) !== null) continue;

    let text: string;
    try {
      const buf = readFileSync(fence.absPath);
      if (buf.length > MAX_FILE_BYTES) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // 二进制
    searched += 1;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= maxResults) { truncated = true; break }
      let line = lines[i] ?? '';
      // 超长行截断后再匹配：既控成本又不至于完全漏掉
      if (line.length > MAX_LINE_LENGTH) line = line.slice(0, MAX_LINE_LENGTH);
      if (!re.test(line)) continue;
      // 带上文（受 contextLines 限制，且不越过 0 号行）
      const from = Math.max(0, i - contextLines);
      const to = Math.min(lines.length - 1, i + contextLines);
      const chunk = lines.slice(from, to + 1).map((s) => (s.length > 300 ? s.slice(0, 300) : s)).join('\n');
      matches.push({ path: rel, line: i + 1, text: chunk });
      // 重置 lastIndex（带 g 标志时 test 会推进），这里无 g 标志，安全
    }
  }

  const data: GrepData = { matches, searched };
  if (!truncated) return { status: 'completed', data };
  return {
    status: 'partial',
    data,
    coverage: { processed: matches.length, omitted: `达到结果上限 ${maxResults}，可能还有更多命中` },
    continuation: { kind: 'cursor', cursor: matches.length > 0 ? `${matches[matches.length - 1]!.path}:${matches[matches.length - 1]!.line}` : '' },
  };
}

export { GREP_PATTERN_MAX_LENGTH, GREP_RESULTS_DEFAULT, GREP_RESULTS_MAX }

// 让 TS 认为 join 被使用（真实用途：未来支持 grep 指定单文件时拼接路径）
void join
