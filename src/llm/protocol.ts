// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * protocol.ts —— OpenAI 兼容 chat/completions 的线协议类型。
 *
 * 只实现 0.2.0 真正需要的最小面：messages、tools、max_tokens、temperature。
 * 刻意不实现 responses API / Anthropic 协议 / 多模态：它们可经 adapter 扩展，
 * 提前实现只会让第一版充满用不到的复杂度。
 */

/** 消息角色。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 一条消息。 */
export interface ChatMessage {
  readonly role: Role
  readonly content: string | null
  readonly tool_calls?: readonly ToolCall[]
  readonly tool_call_id?: string
}

/** 一次工具调用。 */
export interface ToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/** 工具定义。 */
export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

/** 请求体。 */
export interface ChatRequest {
  readonly model: string
  readonly messages: readonly ChatMessage[]
  readonly tools?: readonly ToolDefinition[]
  readonly max_tokens?: number
  readonly temperature?: number
  readonly extraBody?: Readonly<Record<string, unknown>>
}

/** provider 返回的原始用量（字段可能缺失）。 */
export interface RawUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly total_tokens?: number
  readonly prompt_cache_hit_tokens?: number
  readonly prompt_cache_miss_tokens?: number
}

/** 响应体（只取需要的字段）。 */
export interface ChatResponse {
  readonly id?: string
  readonly model?: string
  readonly choices?: ReadonlyArray<{
    readonly index?: number
    readonly message?: {
      readonly role?: string
      readonly content?: string | null
      readonly tool_calls?: readonly ToolCall[]
    }
    readonly finish_reason?: string | null
  }>
  readonly usage?: RawUsage
}

/** OpenAI 兼容端点的错误体。 */
export interface ApiErrorBody {
  readonly error?: {
    readonly message?: string
    readonly type?: string
    readonly code?: string | number | null
  }
}
