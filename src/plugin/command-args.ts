// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * command-args.ts —— `/review` 的参数解析（纯函数，无 IO）。
 *
 * 背景：这个命令的提示写着 `repo_path [mode] [focus]`，但 handler 从来不解析它，
 * 永远拿会话 cwd 去评审 —— 等于提示在骗人。这里把语法落地。
 *
 * 支持的写法（位置参数 + key=value 混用）：
 *
 *   /review                              当前目录、uncommitted
 *   /review D:/repo                      指定仓库
 *   /review D:/repo scan                 指定仓库 + 全仓扫描
 *   /review scan 重点看并发              指定模式 + 重点
 *   /review D:/repo branch base=main head=dev
 *   /review commit=abc123                等价于 mode=commit + commit=abc123
 *   /review repo=D:/repo focus=鉴权问题  纯 key=value 写法
 *
 * 判定顺序（避免歧义）：
 *   1. `key=value` 先抽走（repo/base/head/commit/focus/mode）；
 *   2. 剩下的按位置取：第一个"看着像路径"的当 repo_path，第一个模式关键字当 mode；
 *   3. 其余全部拼成 focus（保持用户原文顺序，便于模型理解意图）。
 *
 * 为什么"看着像路径"要包含 existsSync：用户可能写相对路径 `.` 或 `../x`，
 * 那种既没有盘符也不含分隔符；存在性判断能把它认出来。为了可测，exists 可注入。
 */

import { existsSync } from 'node:fs'

/** 合法模式关键字。 */
export const REVIEW_MODES = ['uncommitted', 'branch', 'commit', 'scan'] as const

/** 解析结果：直接喂给 submitReview 的参数 + 给用户看的提示。 */
export interface ParsedReviewCommand {
  readonly args: {
    readonly repo_path?: string
    readonly mode?: string
    readonly base_ref?: string
    readonly head_ref?: string
    readonly commit?: string
    readonly focus?: string
  }
  /** 需要回显的告警（例如 key=value 值可疑）。 */
  readonly notes: readonly string[]
}

/** 解析依赖（测试可注入）。 */
export interface ParseDeps {
  /** 判断一个字符串是否指向已存在的路径。 */
  readonly exists?: (p: string) => boolean
}

/** 是否是模式关键字。 */
function asMode(token: string): string | null {
  const lower = token.toLowerCase()
  return (REVIEW_MODES as readonly string[]).includes(lower) ? lower : null
}

/** 是否看起来像路径（盘符、分隔符，或磁盘上确实存在）。 */
function looksLikePath(token: string, exists: (p: string) => boolean): boolean {
  if (/^[A-Za-z]:[\\/]/.test(token)) return true
  if (token.includes('/') || token.includes('\\')) return true
  if (token === '.' || token === '..' || token.startsWith('./') || token.startsWith('.\\')) return true
  try {
    return exists(token)
  } catch {
    return false
  }
}

/**
 * 解析 `/review` 后面的原始文本。
 * @param rawInput 用户输入的命令原文（不含 `/review` 本身）
 * @param deps     可注入的判定依赖
 */
export function parseReviewCommand(rawInput: string, deps: ParseDeps = {}): ParsedReviewCommand {
  const exists = deps.exists ?? ((p: string) => existsSync(p))
  const notes: string[] = []
  const tokens = rawInput.trim().split(/\s+/).filter((t) => t !== '')

  const pairs: Record<string, string> = {}
  const rest: string[] = []

  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq > 0) {
      const key = token.slice(0, eq).toLowerCase()
      const value = token.slice(eq + 1)
      if (['repo', 'repo_path', 'base', 'head', 'commit', 'focus', 'mode'].includes(key)) {
        if (value === '') {
          notes.push('参数 ' + key + '= 没有值，已忽略')
          continue
        }
        pairs[key] = value
        continue
      }
      // 不是我们认识的键：可能只是 focus 里带等号，原样保留
    }
    rest.push(token)
  }

  const args: {
    repo_path?: string
    mode?: string
    base_ref?: string
    head_ref?: string
    commit?: string
    focus?: string
  } = {}

  // ① key=value 优先
  const repoPair = pairs.repo ?? pairs.repo_path
  if (repoPair !== undefined) args.repo_path = repoPair
  if (pairs.base !== undefined) args.base_ref = pairs.base
  if (pairs.head !== undefined) args.head_ref = pairs.head
  if (pairs.commit !== undefined) args.commit = pairs.commit
  if (pairs.mode !== undefined) {
    const mode = asMode(pairs.mode)
    if (mode === null) notes.push('未知 mode "' + pairs.mode + '"，可用：' + REVIEW_MODES.join(' / '))
    else args.mode = mode
  }
  if (pairs.focus !== undefined) args.focus = pairs.focus

  // ② 位置参数
  const leftovers: string[] = []
  let modeTaken = args.mode !== undefined
  let repoTaken = args.repo_path !== undefined

  for (const token of rest) {
    if (!modeTaken) {
      const mode = asMode(token)
      if (mode !== null) {
        args.mode = mode
        modeTaken = true
        continue
      }
    }
    if (!repoTaken && looksLikePath(token, exists)) {
      args.repo_path = token
      repoTaken = true
      continue
    }
    leftovers.push(token)
  }

  // ③ 剩下的都是 focus
  if (leftovers.length > 0) {
    const text = leftovers.join(' ')
    args.focus = args.focus === undefined ? text : args.focus + ' ' + text
  }

  // ④ commit= 隐含 mode=commit（否则 submitReview 会以"模式冲突"拒绝）
  if (args.commit !== undefined && args.mode === undefined) args.mode = 'commit'

  return { args, notes }
}
