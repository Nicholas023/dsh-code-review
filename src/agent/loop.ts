// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * loop.ts —— 单个 agent 的多轮循环。
 *
 * 循环长这样：
 *   准备消息 → 调模型 →
 *     有 finish 调用   → 解析结果，结束
 *     有 run_code 调用 → 跑子进程，把结果追加进对话，下一轮
 *     都没有           → 视为模型说完了，结束
 *
 * 停止条件（任一命中即停，且**记录原因**，因为「因为预算停的」和
 * 「因为看完了停的」在报告里的含义完全不同）：
 *   finish / 轮次上限 / token 预算 / 连续无进展 / 出错
 *
 * 一个刻意的设计：**没有工具调用时也结束**。
 * 如果模型只是回了一段文字而没调 finish，我们不会无限追问 ——
 * 那会让一次本该几毛钱的评审变成几十块。宁可返回空结果并在报告里标注。
 */

import { KernelError, toKernelError } from '../domain/errors.js'
import { callChatCompletion, type LlmClientOptions, type NormalizedUsage } from '../llm/client.js'
import type { ChatMessage, ToolCall, ToolDefinition } from '../llm/protocol.js'
import { runCodeProgram, type RunnerOptions } from '../ptc/runner-client.js'
import { parseResult, type ParsedResult } from './result-parser.js'

/** 循环选项。 */
export interface AgentLoopOptions {
  readonly llm: LlmClientOptions
  readonly model: string
  readonly system: string
  readonly task: string
  /** 仓库根（传给 runner）。 */
  readonly root: string
  /** 最大轮次。 */
  readonly maxRounds: number
  /** 输入 token 预算（0 = 不限）。 */
  readonly maxInputTokens: number
  /** 最大输出 token。 */
  readonly maxOutputTokens: number
  readonly runner: RunnerOptions
  /** 允许的工具（决定 SDK 能力）。 */
  readonly tools: readonly ('read' | 'glob' | 'grep')[]
  /** 进度回调（可选）。 */
  readonly onProgress?: (event: { round: number; kind: string; detail?: string }) => void
}

/** 停止原因。 */
export type StopReason = 'finished' | 'max-rounds' | 'budget' | 'no-progress' | 'error'

/** 循环结果。 */
export interface AgentLoopResult {
  readonly result: ParsedResult
  readonly rounds: number
  readonly stopReason: StopReason
  /** 累计用量（多次调用的求和；缺字段保持 null）。 */
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly requests: number
  }
  /** 出错时的结构化错误。 */
  readonly error: KernelError | null
}

/** finish 工具定义。 */
const FINISH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'finish',
    description: '提交本次评审结论。完成评审后必须调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        findings: { type: 'array', description: '发现的问题列表' },
        needsMoreContext: { type: 'array', description: '需要更多上下文才能判断的点' },
        childRequests: { type: 'array', description: '需要深入排查的子任务' },
      },
      required: ['findings'],
    },
  },
}

/** run_code 工具定义。 */
const RUN_CODE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_code',
    description: '在只读沙箱中执行一段 TypeScript 程序，程序内可用 tools.read / tools.glob / tools.grep。返回值会回到对话中。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: '程序体。可以直接 return 一个值，该值会被序列化后返回给你。' },
      },
      required: ['program'],
    },
  },
}

/** 把用量累加。 */
function addUsage(total: { inputTokens: number; outputTokens: number; cacheReadTokens: number; requests: number }, u: NormalizedUsage | null): void {
  if (!u) return
  if (u.inputTokens !== null) total.inputTokens += u.inputTokens
  if (u.outputTokens !== null) total.outputTokens += u.outputTokens
  if (u.cacheReadTokens !== null) total.cacheReadTokens += u.cacheReadTokens
}

/** 从工具调用里取 JSON 参数；解析失败给 null。 */
function parseArgs(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments)
  } catch {
    return null
  }
}

/**
 * 运行一个 agent 的完整循环。
 */
/**
 * 把「预算里的输出上限」翻译成请求里的 max_tokens。
 *
 * 为什么需要这个转换（实机踩到的）：
 *   配置里 budget.maxOutputTokens = 0 的语义是「不限」，但 OpenAI 兼容端点把
 *   max_tokens 当成「必须是 > 0 的正数」。原样透传 0 会得到
 *     400 Too small: expected number to be >0
 *   于是整个评审在第一次请求就失败，报告却显示「已完成 0 个问题」——
 *   用户完全看不出是被这个参数卡住的。
 *
 * 结论：**不限 = 不发送这个字段**，而不是发 0。
 * @param budget 配置里的输出预算；<= 0 表示不限
 * @returns 要发送的 max_tokens；不限时为 undefined（调用方据此省略字段）
 */
export function maxTokensFor(budget: number): number | undefined {
  if (!Number.isFinite(budget) || budget <= 0) return undefined
  return Math.floor(budget)
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.task },
  ]
  const tools: ToolDefinition[] = [FINISH_TOOL, RUN_CODE_TOOL]
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 }
  let rounds = 0
  let emptyRounds = 0

  while (rounds < opts.maxRounds) {
    rounds += 1
    opts.onProgress?.({ round: rounds, kind: 'llm-call' })

    // 预算检查：超过就停，且明确标记为 budget（不是 finished）
    if (opts.maxInputTokens > 0 && usage.inputTokens > opts.maxInputTokens) {
      return {
        result: { findings: [], needsMoreContext: [], childRequests: [], issues: ['已触及输入 token 预算，评审未完成'] },
        rounds,
        stopReason: 'budget',
        usage,
        error: null,
      }
    }

    let callResult
    try {
      // 不限（预算 0）时不发送 max_tokens：tsconfig 开了 exactOptionalPropertyTypes，
      // 显式传 undefined 反而不合法，用条件展开表达「这个字段不存在」。
      const maxTokens = maxTokensFor(opts.maxOutputTokens)
      callResult = await callChatCompletion(
        opts.llm,
        {
          model: opts.model,
          messages,
          tools,
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          // 评审必须可复现：同一份代码两次跑出不同结论，用户无从判断哪个可信。
          // 实测同一仓库、同一配置两次扫描，一次 12 条一次 0 条 —— 差别只来自采样温度。
          temperature: 0,
        },
      )
    } catch (error) {
      return {
        result: { findings: [], needsMoreContext: [], childRequests: [], issues: [] },
        rounds,
        stopReason: 'error',
        usage,
        error: toKernelError(error),
      }
    }

    usage.requests += 1
    addUsage(usage, callResult.usage)

    const choice = callResult.response.choices?.[0]
    const assistantMsg = choice?.message
    const toolCalls = assistantMsg?.tool_calls ?? []
    const finishReason = choice?.finish_reason ?? null

    // 模型没调工具：视为结束（避免无限追问）
    if (toolCalls.length === 0) {
      // finish_reason=length 是**确定性故障**，不是「模型没话说」。
      //
      // 这个模型会先生成 reasoning_content。实测（同一个端点、同一段代码）：
      //   max_tokens=200 → reasoning 698 字、completion_tokens=200、content 0 字
      //   max_tokens=400 → reasoning 1435 字、content 0 字
      //   max_tokens=800 → reasoning 2643 字、content 0 字
      // 也就是输出预算一旦不够，正文**必然**为空。
      //
      // 若走下面的「追问两次」路径，结局是 no-progress / max-rounds → 报告写「0 个问题」，
      // 用户看到的是「干净」而不是「没跑成」。所以这里直接报错，并告诉用户改哪个配置。
      if (finishReason === 'length') {
        return {
          result: { findings: [], needsMoreContext: [], childRequests: [], issues: [] },
          rounds,
          stopReason: 'error',
          usage,
          error: new KernelError(
            'MODEL_RESPONSE_INVALID',
            '模型输出被截断（finish_reason=length），正文为空：输出预算很可能被推理过程耗尽。' +
              '请把 budget.maxOutputTokens 设为 0（不限）或调大到能容纳推理 + 正文。',
          ),
        }
      }
      emptyRounds += 1
      messages.push({ role: 'assistant', content: assistantMsg?.content ?? '' })
      if (emptyRounds >= 2) {
        return {
          result: { findings: [], needsMoreContext: [], childRequests: [], issues: ['模型未调用 finish 就结束，结果为空'] },
          rounds,
          stopReason: 'no-progress',
          usage,
          error: null,
        }
      }
      // 再提醒一次，然后继续（给模型一次机会）
      messages.push({ role: 'user', content: '请调用 finish 工具提交评审结论。' })
      continue
    }

    emptyRounds = 0
    messages.push({
      role: 'assistant',
      content: assistantMsg?.content ?? null,
      tool_calls: toolCalls,
    })

    for (const call of toolCalls) {
      const args = parseArgs(call)

      if (call.function.name === 'finish') {
        const parsed = parseResult(args)
        return { result: parsed, rounds, stopReason: 'finished', usage, error: null }
      }

      if (call.function.name === 'run_code') {
        const program = typeof args === 'object' && args !== null && typeof (args as { program?: unknown }).program === 'string'
          ? (args as { program: string }).program
          : null
        if (program === null) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: { code: 'INPUT_INVALID_ARGUMENT', message: '缺少 program 参数' } }) })
          continue
        }
        opts.onProgress?.({ round: rounds, kind: 'run-code' })
        const r = await runCodeProgram(opts.runner, { program, root: opts.root, tools: [...opts.tools] })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(r.ok ? r.response : { ok: false, error: r.failure }),
        })
        continue
      }

      // 未知工具
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: { code: 'INPUT_INVALID_ARGUMENT', message: '未知工具：' + call.function.name } }),
      })
    }

    // 只剩 finish 和 run_code 两种；每轮都继续
    opts.onProgress?.({ round: rounds, kind: 'round-end' })
  }

  // 轮次用尽。这里**必须**再问一次模型，不能直接返回空结果。
  //
  // 为什么：评审结论只从 finish 工具里取。如果模型把轮次全花在读代码上、
  // 没来得及调用 finish，直接返回就是「0 个问题 + 已完成」——一次没跑完的评审
  // 会被当成干净结论。实机踩过：同一个仓库两次扫描，一次 12 条一次 0 条。
  //
  // 收尾请求只给 finish 一个工具：这轮不能再花预算去 run_code，否则就是
  // 又一轮「差一点」。失败也不改变 stopReason，仍是 max-rounds（状态仍是 partial），
  // 只是尽量把已有发现带出来。
  const salvaged = await salvageFindings(opts, messages, usage)
  if (salvaged !== null) {
    return {
      result: salvaged,
      rounds,
      stopReason: 'max-rounds',
      usage,
      error: null,
    }
  }

  return {
    result: { findings: [], needsMoreContext: [], childRequests: [], issues: ['达到最大轮次，评审未完成'] },
    rounds,
    stopReason: 'max-rounds',
    usage,
    error: null,
  }
}

/**
 * 轮次耗尽后的收尾请求：只要结论，不要调用代码。
 * @param opts     循环选项
 * @param messages 当前对话（会被追加一条收尾指令）
 * @param usage    用量累加器
 * @returns 解析出的结论；模型仍不调用 finish 时返回 null
 */
async function salvageFindings(
  opts: AgentLoopOptions,
  messages: ChatMessage[],
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; requests: number },
): Promise<ParsedResult | null> {
  messages.push({
    role: 'user',
    content: '轮次预算已用尽。请立刻调用 finish 提交你目前已经确认的发现（没有发现就提交空列表），不要再调用 run_code。',
  })
  const maxTokens = maxTokensFor(opts.maxOutputTokens)
  try {
    const res = await callChatCompletion(opts.llm, {
      model: opts.model,
      messages,
      tools: [FINISH_TOOL],
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      temperature: 0,
    })
    usage.requests += 1
    addUsage(usage, res.usage)
    const calls = res.response.choices?.[0]?.message?.tool_calls ?? []
    const finish = calls.find((c) => c.function.name === 'finish')
    if (finish === undefined) return null
    return parseResult(parseArgs(finish))
  } catch {
    // 收尾失败不影响主流程：仍然返回 max-rounds，只是没有额外发现
    return null
  }
}
