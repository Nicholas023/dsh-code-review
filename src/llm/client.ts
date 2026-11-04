// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * client.ts —— OpenAI 兼容端点的 HTTP 调用层。
 *
 * 三个必须做对的点：
 *  1. **超时与任务超时解耦**：单请求有自己的截止时间（防端点悬挂），
 *     任务整体另有兜底。一个卡住的请求不能拖垮整次评审。
 *  2. **只重试该重试的**：连接失败 / 408 / 429 / 5xx 才重试；
 *     401/403/400 重试只会浪费时间和配额，直接失败并给配置指引。
 *  3. **错误归一**：上层只认 code，不解析英文文本。
 *
 * 红线：本模块**不做任何端点兜底**。没有配置端点时调用方就不该调到这里；
 * 这里若收到空 URL 会明确失败，绝不自己编一个默认端点。
 */

import { KernelError } from '../domain/errors.js'
import type { ChatRequest, ChatResponse, RawUsage } from './protocol.js'

/** 一次调用的结果。 */
export interface LlmCallResult {
  readonly response: ChatResponse
  /** 归一化后的用量；provider 未返回时为 null。 */
  readonly usage: NormalizedUsage | null
  /** 实际发出请求次数（含重试）。 */
  readonly attempts: number
  /** 本次调用耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 归一化用量（缺字段一律 null，不用 0 冒充）。 */
export interface NormalizedUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  /** 缓存命中的输入 token 数（provider 提供时）。 */
  readonly cacheReadTokens: number | null
  /** 缓存未命中的输入 token 数（provider 提供时）。 */
  readonly cacheMissTokens: number | null
}

/** 客户端选项。 */
export interface LlmClientOptions {
  /** 端点基址（如 https://api.deepseek.com）。必须非空。 */
  readonly baseUrl: string
  /** 凭据引用解析出的明文 key（只在内存中，不落盘）。 */
  readonly apiKey: string
  /** 单请求超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** 最大尝试次数（含首次；默认 3）。 */
  readonly maxAttempts?: number
}

/** 从原始 usage 归一。 */
export function normalizeUsage(raw: RawUsage | undefined): NormalizedUsage | null {
  if (!raw) return null
  const pick = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  /** 按顺序取第一个存在的数值（各家字段名不同，见 RawUsage 的说明）。 */
  const pickFirst = (...candidates: readonly unknown[]): number | null => {
    for (const c of candidates) {
      const v = pick(c)
      if (v !== null) return v
    }
    return null
  }
  return {
    inputTokens: pick(raw.prompt_tokens),
    outputTokens: pick(raw.completion_tokens),
    cacheReadTokens: pickFirst(
      raw.prompt_cache_hit_tokens,
      raw.prompt_tokens_details?.cached_tokens,
      raw.cached_tokens,
    ),
    cacheMissTokens: pick(raw.prompt_cache_miss_tokens),
  }
}

/** 拼接 chat/completions 路径（容忍 baseUrl 末尾斜杠与已带 /v1）。 */
export function completionsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '')
  if (b.endsWith('/chat/completions')) return b
  return b + '/chat/completions'
}

/** 判断是否值得重试的 HTTP 状态。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504)
}

/** 判断错误是否属于可重试的网络类。 */
export function isRetryableNetworkError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (typeof code === 'string') {
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) return true
  }
  const msg = error instanceof Error ? error.message : String(error)
  return /socket hang up|fetch failed|network error|undici/i.test(msg)
}

/** 睡眠（重试退避用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从错误响应体里提取可读消息。 */
function apiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    const msg = parsed.error?.message
    if (typeof msg === 'string' && msg.trim() !== '') return msg.trim()
  } catch {
    // 非 JSON 响应体，退回原文截断
  }
  return body.slice(0, 300)
}

/**
 * 调用一次 chat/completions（含重试）。
 * @throws KernelError 所有尝试均失败时
 */
export async function callChatCompletion(
  opts: LlmClientOptions,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  if (typeof opts.baseUrl !== 'string' || opts.baseUrl.trim() === '') {
    // 红线：绝不隐式兜底到任何默认端点
    throw new KernelError('CONFIG_MODEL_ENDPOINT_MISSING', '评审模型端点未配置，请先在设置中填写 endpoint', {
      nextAction: '打开插件设置，填写「评审模型 → 端点」与「凭据引用」',
    })
  }
  if (typeof opts.apiKey !== 'string' || opts.apiKey.trim() === '') {
    throw new KernelError('CONFIG_CREDENTIAL_MISSING', '评审模型凭据未找到，请检查凭据引用与环境变量', {
      nextAction: '确认设置里的「凭据引用」指向一个已配置的环境变量或凭据条目',
    })
  }

  const url = completionsUrl(opts.baseUrl)
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const startedAt = Date.now()
  let attempt = 0
  let lastError: KernelError | null = null

  while (attempt < maxAttempts) {
    attempt += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.requestTimeoutMs)
    // 外部取消也要传播进来
    const onAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const body = {
        model: request.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.extraBody ?? {}),
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + opts.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const message = apiErrorMessage(text)
        if (isRetryableStatus(res.status) && attempt < maxAttempts) {
          // 尊重 Retry-After（有则用，无则指数退避）
          const retryAfter = Number(res.headers.get('retry-after'))
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * Math.pow(2, attempt - 1)
          lastError = new KernelError(
            res.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_HTTP_ERROR',
            '端点返回 ' + String(res.status) + '：' + message,
          )
          await sleep(Math.min(waitMs, 30_000))
          continue
        }
        throw new KernelError(
          res.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_HTTP_ERROR',
          '端点返回 ' + String(res.status) + '：' + message,
          // exactOptionalPropertyTypes 下不能传 undefined，按需展开
          res.status === 401 || res.status === 403
            ? { nextAction: '检查凭据是否有效，或端点是否需要不同协议' }
            : {},
        )
      }

      const parsed = (await res.json()) as ChatResponse
      if (!parsed.choices || parsed.choices.length === 0) {
        throw new KernelError('MODEL_RESPONSE_INVALID', '端点返回的 choices 为空')
      }
      return {
        response: parsed,
        usage: normalizeUsage(parsed.usage),
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (error) {
      if (error instanceof KernelError) throw error
      // 超时（AbortController 触发）
      if (error instanceof Error && error.name === 'AbortError') {
        lastError = new KernelError('MODEL_TIMEOUT', '请求超过 ' + String(opts.requestTimeoutMs) + 'ms 未返回')
        // 超时不重试：端点已经明显异常，重试只会再等一遍
        throw lastError
      }
      if (isRetryableNetworkError(error) && attempt < maxAttempts) {
        lastError = new KernelError('MODEL_HTTP_ERROR', error instanceof Error ? error.message : String(error))
        await sleep(500 * Math.pow(2, attempt - 1))
        continue
      }
      throw new KernelError('MODEL_HTTP_ERROR', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  throw lastError ?? new KernelError('MODEL_HTTP_ERROR', '调用失败（未记录具体原因）')
}
