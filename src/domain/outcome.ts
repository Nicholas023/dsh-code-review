// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * outcome.ts —— 所有工具调用的统一结果契约（借 dsh-ops 的设计）。
 *
 * 为什么不能只返回数据：评测 agent 拿到的结果可能是**被预算截断的**。
 * 如果截断不显式声明，模型会把「我只看到前 64 行」当成「这个文件就 64 行」，
 * 进而得出「没有问题」的假结论 —— 在代码评审里这是最危险的错误类型。
 *
 * 因此每个调用都必须回答两个问题：
 *  1. 这份数据完整吗？（status + coverage）
 *  2. 不完整的话，怎么继续拿？（continuation）
 *
 * 六个状态的语义（对齐 dsh-ops 的 Outcome 约定）：
 *  - completed：请求被完整满足
 *  - partial  ：只满足了一部分，但**保留了可用数据**，并给出续取方式
 *  - rejected ：请求本身不被允许（越界路径、敏感文件、越权工具）
 *  - conflict ：与当前状态冲突（并发修改、版本不匹配）
 *  - error    ：执行过程中失败
 *  - unknown  ：无法判定是否成功（例如进程被强杀），必须由只读复查确认
 */

import type { EffectState, KernelError, RetryPolicy } from './errors.js'

/** 覆盖率描述：说清「处理了多少 / 总共多少 / 还差什么」。 */
export interface Coverage {
  /** 已完成的数量（按工具语义：行数、文件数、命中数）。 */
  readonly processed: number
  /** 总量；未知时不填（不要用 0 冒充未知）。 */
  readonly total?: number
  /** 未完成部分的人读说明，例如「文件后半段」「第 3 页之后」。 */
  readonly omitted?: string
}

/** 续取游标：下次调用怎样接着拿。 */
export type Continuation =
  /** 按行偏移继续（read 用）：从 offset 行起继续读。 */
  | { readonly kind: 'offset'; readonly offset: number }
  /** 按引用继续（结果已外置存储）：读取该 ref 取得完整数据。 */
  | { readonly kind: 'ref'; readonly ref: string }
  /** 按模式继续（glob/grep 用）：沿用原查询，从游标之后继续。 */
  | { readonly kind: 'cursor'; readonly cursor: string }

/** 失败类结果的统一错误形状（不含 stack、不含凭据）。 */
export interface OutcomeError {
  readonly code: KernelError['code']
  readonly message: string
  readonly retry: RetryPolicy
  readonly effectState: EffectState
  readonly nextAction?: string
}

/** 完整成功。 */
export interface CompletedOutcome<T> {
  readonly status: 'completed'
  readonly data: T
}

/** 部分成功：有数据、有缺口、有续取方式。 */
export interface PartialOutcome<T> {
  readonly status: 'partial'
  readonly data: T
  readonly coverage: Coverage
  readonly continuation: Continuation
}

/** 失败族：rejected / conflict / error / unknown 共用错误体。 */
export interface FailedOutcome {
  readonly status: 'rejected' | 'conflict' | 'error' | 'unknown'
  readonly error: OutcomeError
  /** 失败时可能仍保留部分数据（例如批量操作中一半成功）。 */
  readonly data?: unknown
}

/** 工具调用结果。 */
export type Outcome<T> = CompletedOutcome<T> | PartialOutcome<T> | FailedOutcome

/** 构造完整成功结果。 */
export function completed<T>(data: T): CompletedOutcome<T> {
  return { status: 'completed', data }
}

/**
 * 构造部分成功结果。
 * 注意：要求必须给 continuation —— 没有续取方式的 partial 等于死路，
 * 模型只能凭空猜完整内容，那正是我们要避免的。
 */
export function partial<T>(data: T, coverage: Coverage, continuation: Continuation): PartialOutcome<T> {
  return { status: 'partial', data, coverage, continuation }
}

/** 构造失败结果（从 KernelError 投影，避免调用方手抄字段）。 */
export function failed(
  status: FailedOutcome['status'],
  error: KernelError,
  data?: unknown,
): FailedOutcome {
  return {
    status,
    error: error.toJSON(),
    ...(data === undefined ? {} : { data }),
  }
}

/** 判断是否为成功族（completed/partial 有可用数据）。 */
export function hasData<T>(outcome: Outcome<T>): outcome is CompletedOutcome<T> | PartialOutcome<T> {
  return outcome.status === 'completed' || outcome.status === 'partial'
}
