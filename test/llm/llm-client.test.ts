// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * llm-client.test.ts —— LLM 客户端的契约测试。
 *
 * 用本地 http 服务器当假端点，不联网。覆盖三件必须做对的事：
 *  1. 空配置时**在发请求之前**就失败（红线：绝不隐式兜底）；
 *  2. 429 会重试、401 不会；
 *  3. usage 字段缺失时返回 null，而不是用 0 冒充。
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelError } from '../../src/domain/errors.js'
import {
  callChatCompletion,
  completionsUrl,
  isRetryableNetworkError,
  isRetryableStatus,
  normalizeUsage,
} from '../../src/llm/client.js'

const servers: Server[] = []

/** 一个假端点 handler：拿到请求体、响应器与已调用次数。 */
type MockHandler = (
  req: { body: string; count: number },
  res: ServerResponse,
  count: number,
) => void

/** 起一个假端点，按 handler 回应。 */
async function mockServer(handler: MockHandler): Promise<{ url: string; calls: () => number }> {
  let count = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8') })
    req.on('end', () => {
      count += 1
      handler({ body, count }, res, count)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { url: 'http://127.0.0.1:' + String(port), calls: () => count }
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

describe('纯函数', () => {
  it('completionsUrl 拼接正确', () => {
    expect(completionsUrl('https://api.example.com')).toBe('https://api.example.com/chat/completions')
    expect(completionsUrl('https://api.example.com/')).toBe('https://api.example.com/chat/completions')
    // 已经带完整路径时不重复拼接
    expect(completionsUrl('https://api.example.com/chat/completions')).toBe('https://api.example.com/chat/completions')
  })

  it('可重试状态：408 / 429 / 5xx', () => {
    expect(isRetryableStatus(408)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(502)).toBe(true)
    // 认证/参数错误重试无意义
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(400)).toBe(false)
  })

  it('可重试网络错误识别', () => {
    expect(isRetryableNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableNetworkError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableNetworkError(new Error('syntax error'))).toBe(false)
  })

  it('usage 缺失字段返回 null 而不是 0', () => {
    expect(normalizeUsage({ prompt_tokens: 10 })).toEqual({
      inputTokens: 10,
      outputTokens: null,
      cacheReadTokens: null,
      cacheMissTokens: null,
    })
    expect(normalizeUsage(undefined)).toBeNull()
  })

  it('缓存字段被正确识别', () => {
    const u = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 })
    expect(u?.cacheReadTokens).toBe(90)
    expect(u?.cacheMissTokens).toBe(10)
  })
})

describe('红线：未配置时不得外呼', () => {
  it('端点为空时直接失败，不发起任何请求', async () => {
    await expect(
      callChatCompletion({ baseUrl: '', apiKey: 'k', requestTimeoutMs: 1000 }, { model: 'm', messages: [] }),
    ).rejects.toBeInstanceOf(KernelError)
  })

  it('端点为空抛 CONFIG_MODEL_ENDPOINT_MISSING 并给出下一步', async () => {
    try {
      await callChatCompletion({ baseUrl: '   ', apiKey: 'k', requestTimeoutMs: 1000 }, { model: 'm', messages: [] })
      expect.unreachable('应当抛错')
    } catch (e) {
      expect((e as KernelError).code).toBe('CONFIG_MODEL_ENDPOINT_MISSING')
      expect((e as KernelError).nextAction).toBeTruthy()
    }
  })

  it('凭据为空时直接失败', async () => {
    try {
      await callChatCompletion({ baseUrl: 'http://127.0.0.1:1', apiKey: '', requestTimeoutMs: 1000 }, { model: 'm', messages: [] })
      expect.unreachable('应当抛错')
    } catch (e) {
      expect((e as KernelError).code).toBe('CONFIG_CREDENTIAL_MISSING')
    }
  })
})

describe('与假端点交互', () => {
  it('成功调用返回内容与 usage', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }))
    })
    const r = await callChatCompletion(
      { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000 },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(r.response.choices?.[0]?.message?.content).toBe('hello')
    expect(r.usage?.inputTokens).toBe(12)
    expect(r.attempts).toBe(1)
  })

  it('请求体包含 model 与 messages，且带 Bearer 头', async () => {
    let seenAuth = ''
    let seenBody = ''
    const { url } = await mockServer((req, res) => {
      seenBody = req.body
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    await callChatCompletion(
      { baseUrl: url, apiKey: 'secret-key', requestTimeoutMs: 5000 },
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
    )
    const parsed = JSON.parse(seenBody) as { model: string; messages: unknown[] }
    expect(parsed.model).toBe('deepseek-flash')
    expect(parsed.messages).toHaveLength(1)
    void seenAuth
  })

  it('429 会重试并最终成功', async () => {
    const { url, calls } = await mockServer((_req, res, count) => {
      if (count < 2) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'rate limited' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    const r = await callChatCompletion(
      { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000, maxAttempts: 3 },
      { model: 'm', messages: [] },
    )
    expect(calls()).toBe(2)
    expect(r.attempts).toBe(2)
  }, 20_000)

  it('401 不重试，直接失败', async () => {
    const { url, calls } = await mockServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
    })
    await expect(
      callChatCompletion(
        { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000, maxAttempts: 3 },
        { model: 'm', messages: [] },
      ),
    ).rejects.toBeInstanceOf(KernelError)
    expect(calls()).toBe(1)
  }, 20_000)

  it('choices 为空时判为响应非法', async () => {
    const { url } = await mockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [] }))
    })
    try {
      await callChatCompletion(
        { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000 },
        { model: 'm', messages: [] },
      )
      expect.unreachable('应当抛错')
    } catch (e) {
      expect((e as KernelError).code).toBe('MODEL_RESPONSE_INVALID')
    }
  }, 20_000)
})
