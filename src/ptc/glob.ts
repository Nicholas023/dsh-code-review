// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * glob.ts —— 有界文件匹配。
 *
 * 与 read 同样的思路：先由模型给出模式，再由我们做**有界遍历**。
 * 三个必须处理的现实问题：
 *  1. 大仓库遍历成本 —— 设扫描上限，超了就返回 partial 而不是无响应；
 *  2. 默认排除目录 —— node_modules / .git / dist 永远不该进结果；
 *  3. 结果排序 —— 不稳定排序会让同一查询两次返回不同顺序，破坏缓存前缀。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp } from '../selection/select.js'
import { isSensitivePath } from '../selection/sensitive.js'
import {
  GLOB_RESULTS_DEFAULT,
  GLOB_RESULTS_MAX,
  type GlobArgs,
  type GlobData,
  type ToolResult,
} from './types.js'

/** 遍历时永远跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '__pycache__', '.venv']);

/** 遍历上限：防止在超大仓库上把 CPU 与时间耗光。 */
const MAX_SCAN_ENTRIES = 50_000

/**
 * 在仓库内按模式匹配文件。
 * @param root 仓库根绝对路径
 * @param args 参数
 */
export function globFiles(root: string, args: GlobArgs): ToolResult<GlobData> {
  const patterns = (args.patterns ?? []).filter((p) => typeof p === 'string' && p.trim() !== '')
  if (patterns.length === 0) {
    return {
      status: 'rejected',
      error: { code: 'INPUT_INVALID_ARGUMENT', message: 'patterns 不能为空', retry: 'after-input-change', effectState: 'none' },
    }
  }
  const includes = patterns.map((p) => globToRegExp(p))
  const excludes = (args.exclude ?? []).map((p) => globToRegExp(p))
  const maxResults = Math.min(GLOB_RESULTS_MAX, Math.max(1, Math.floor(args.maxResults ?? GLOB_RESULTS_DEFAULT)))

  const files: string[] = []
  let scanned = 0
  let hitScanLimit = false
  let hitResultLimit = false

  /** 深度优先遍历（迭代实现，避免深目录爆栈）。 */
  const stack: string[] = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === '' ? root : join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) { hitScanLimit = true; break }
      // 敏感文件不进入结果（连文件名都不给模型，避免它去 read 被拒后反复尝试）
      if (isSensitivePath(childRel)) continue;
      if (excludes.some((re) => re.test(childRel))) continue;
      if (!includes.some((re) => re.test(childRel))) continue;
      files.push(childRel);
      if (files.length >= maxResults) { hitResultLimit = true; break }
    }
    if (hitScanLimit || hitResultLimit) break;
  }

  // 稳定排序：同一查询必须给出同一顺序
  files.sort();

  const data: GlobData = { files, scanned };
  if (!hitScanLimit && !hitResultLimit) {
    return { status: 'completed', data };
  }
  return {
    status: 'partial',
    data,
    coverage: {
      processed: files.length,
      omitted: hitResultLimit ? `达到结果上限 ${maxResults}，可能还有更多匹配` : `遍历达到上限 ${MAX_SCAN_ENTRIES} 个条目`,
    },
    continuation: { kind: 'cursor', cursor: files.length > 0 ? files[files.length - 1]! : '' },
  };
}

/** 供测试与 SDK 声明复用。 */
export { GLOB_RESULTS_DEFAULT, GLOB_RESULTS_MAX }
