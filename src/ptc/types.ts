// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * types.ts —— PTC SDK 的参数与结果类型（唯一真源）。
 *
 * 这些类型同时用于三处，必须保持一份：
 *  1. 生成给模型看的 TypeScript SDK 声明；
 *  2. runner 子进程里的运行时校验；
 *  3. 内核侧的调用与测试。
 * 任何一处单独改字段都会导致模型按旧签名调用，所以只在这里定义。
 */

import type { Continuation, Coverage } from '../domain/outcome.js'

/** 统一的结果外壳（与 domain/outcome 对齐，但这里是纯数据）。 */
export interface ToolOk<T> {
  readonly status: 'completed'
  readonly data: T
}

export interface ToolPartial<T> {
  readonly status: 'partial'
  readonly data: T
  readonly coverage: Coverage
  readonly continuation: Continuation
}

export interface ToolFailed {
  readonly status: 'rejected' | 'error'
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retry: 'never' | 'safe' | 'after-input-change'
    readonly effectState: 'none' | 'partial' | 'unknown'
    readonly nextAction?: string
  }
}

export type ToolResult<T> = ToolOk<T> | ToolPartial<T> | ToolFailed

// ─────────────────────────── read ───────────────────────────

/** read 的参数。 */
export interface ReadArgs {
  /** 仓库相对路径（正斜杠）。 */
  readonly path: string
  /** 起始行（1 基，默认 1）。 */
  readonly offset?: number
  /** 最多读多少行（默认 64，上限 512）。 */
  readonly limit?: number
}

/** read 返回的一行。 */
export interface ReadLine {
  readonly n: number
  readonly text: string
}

/** read 的数据体。 */
export interface ReadData {
  readonly path: string
  readonly lines: readonly ReadLine[]
  /** 文件总行数（用于计算 coverage）。 */
  readonly totalLines: number
}

// ─────────────────────────── glob ───────────────────────────

/** glob 的参数。 */
export interface GlobArgs {
  /** 包含模式（glob，支持 * ** ?）。 */
  readonly patterns: readonly string[]
  /** 排除模式。 */
  readonly exclude?: readonly string[]
  /** 最多返回多少个文件（默认 200，上限 1000）。 */
  readonly maxResults?: number
}

/** glob 的数据体。 */
export interface GlobData {
  readonly files: readonly string[]
  /** 扫描过程中遍历的文件总数（用于说明是否被截断）。 */
  readonly scanned: number
}

// ─────────────────────────── grep ───────────────────────────

/** grep 的参数。 */
export interface GrepArgs {
  /** 正则表达式（JS 语法）。 */
  readonly pattern: string
  /** 只在匹配这些 glob 的文件里搜（默认全部）。 */
  readonly glob?: readonly string[]
  /** 忽略大小写。 */
  readonly ignoreCase?: boolean
  /** 最多返回多少条命中（默认 100，上限 500）。 */
  readonly maxResults?: number
  /** 每条命中返回的上下文行数（默认 0，上限 3）。 */
  readonly contextLines?: number
}

/** grep 的一条命中。 */
export interface GrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

/** grep 的数据体。 */
export interface GrepData {
  readonly matches: readonly GrepMatch[]
  /** 实际搜索过的文件数。 */
  readonly searched: number
}

// ─────────────────────────── 预算 ───────────────────────────

/** read 的预算。 */
export const READ_LIMIT_DEFAULT = 64
export const READ_LIMIT_MAX = 512
export const READ_BYTES_DEFAULT = 16 * 1024
export const READ_BYTES_MAX = 64 * 1024

/** glob 的预算。 */
export const GLOB_RESULTS_DEFAULT = 200
export const GLOB_RESULTS_MAX = 1000

/** grep 的预算。 */
export const GREP_RESULTS_DEFAULT = 100
export const GREP_RESULTS_MAX = 500
export const GREP_CONTEXT_MAX = 3
export const GREP_PATTERN_MAX_LENGTH = 500

/** 程序 return 给模型的字节上限。 */
export const RETURN_BYTES_DEFAULT = 8 * 1024
export const RETURN_BYTES_MAX = 16 * 1024
