// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * loop.test.ts —— 单 agent 循环的停止条件测试。
 *
 * 用本地假端点模拟模型行为，不联网。重点验证「什么时候停」，
 * 因为这里错了不是质量差，而是账单失控。
 */

import { createServer, type Server } from 'node:http'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maxTokensFor, runAgentLoop } from '../../src/agent/loop.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const servers: Server[] = []

/** 一个按脚本回应的假端点：每次请求消费下一条脚本。 */
async function scriptedServer(
  responses: ReadonlyArray<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }>; usage?: Record<string, number> }>,
): Promise<{ url: string; calls: () => number; bodies: () => string[] }> {
  let idx = 0
  // 记录每次请求的原始 body：有些参数错误只有在「发出去的报文」里才看得见
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      const step = responses[Math.min(idx, responses.length - 1)]!
      idx += 1
      const toolCalls = (step.toolCalls ?? []).map((c, i) => ({
        id: 'call_' + String(idx) + '_' + String(i),
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: step.content ?? null, tool_calls: toolCalls.length > 0 ? toolCalls : undefined } }],
        usage: step.usage ?? { prompt_tokens: 100, completion_tokens: 20 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { url: 'http://127.0.0.1:' + String(port), calls: () => idx, bodies: () => bodies }
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

beforeAll(() => {
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' })
}, 120_000)

/** 基础选项。 */
function baseOpts(url: string, overrides: Record<string, unknown> = {}) {
  return {
    llm: { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000 },
    model: 'm',
    system: 'SYS',
    task: 'TASK',
    root: ROOT,
    maxRounds: 5,
    maxInputTokens: 0,
    maxOutputTokens: 1000,
    runner: { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 10_000, memoryMb: 256 },
    tools: [] as Array<'read' | 'glob' | 'grep'>,
    ...overrides,
  }
}

describe('循环停止条件', () => {
  it('模型直接 finish：一轮结束，结果为 finished', async () => {
    const { url } = await scriptedServer([
      { toolCalls: [{ name: 'finish', args: { findings: [] } }] },
    ])
    const r = await runAgentLoop(baseOpts(url) as never)
    expect(r.stopReason).toBe('finished')
    expect(r.rounds).toBe(1)
    expect(r.usage.requests).toBe(1)
  }, 60_000)

  it('一轮 run_code 后 finish：两轮，累计用量', async () => {
    const { url } = await scriptedServer([
      { toolCalls: [{ name: 'run_code', args: { program: 'return 1' } }] },
      { toolCalls: [{ name: 'finish', args: { findings: [{ path: 'a.ts', category: 'bug', severity: 'low', title: 't' }] } }] },
    ])
    const r = await runAgentLoop(baseOpts(url, { tools: ['read'] }) as never)
    expect(r.stopReason).toBe('finished')
    expect(r.rounds).toBe(2)
    expect(r.usage.requests).toBe(2)
    expect(r.usage.inputTokens).toBe(200)
    expect(r.result.findings).toHaveLength(1)
  }, 60_000)

  it('模型不调工具：两次后判无进展', async () => {
    const { url } = await scriptedServer([{ content: '我觉得还行' }, { content: '真的还行' }])
    const r = await runAgentLoop(baseOpts(url) as never)
    expect(r.stopReason).toBe('no-progress')
    expect(r.result.findings).toHaveLength(0)
  }, 60_000)

  it('超过最大轮次停止，并标记 max-rounds', async () => {
    const { url } = await scriptedServer([
      { toolCalls: [{ name: 'run_code', args: { program: 'return 1' } }] },
    ])
    const r = await runAgentLoop(baseOpts(url, { maxRounds: 3, tools: ['read'] }) as never)
    expect(r.stopReason).toBe('max-rounds')
    expect(r.rounds).toBe(3)
  }, 60_000)

  it('超过输入预算停止，并标记 budget（不是 finished）', async () => {
    const { url } = await scriptedServer([
      { toolCalls: [{ name: 'run_code', args: { program: 'return 1' } }] },
    ])
    const r = await runAgentLoop(baseOpts(url, { maxRounds: 10, maxInputTokens: 50, tools: ['read'] }) as never)
    expect(r.stopReason).toBe('budget')
    // 预算耗尽不算完成，结果必须为空而不是「没问题」
    expect(r.result.findings).toHaveLength(0)
  }, 60_000)

  it('端点报错时返回 error 而不是抛出', async () => {
    const { url } = await scriptedServer([{ content: 'x' }])
    // 用一个不存在的端口制造连接失败
    const bad = url.replace(/:\d+$/, ':1')
    const r = await runAgentLoop(baseOpts(bad, { llm: { baseUrl: bad, apiKey: 'k', requestTimeoutMs: 1000 } }) as never)
    expect(r.stopReason).toBe('error')
    expect(r.error).not.toBeNull()
  }, 60_000)
})

describe('输出预算 → max_tokens', () => {
  it('0 表示不限，翻译成「不发送」而不是 0', () => {
    // 这条是回归测试：曾经把 0 原样发给端点，得到
    // 400 Too small: expected number to be >0，整个评审在第一次请求就失败
    expect(maxTokensFor(0)).toBeUndefined()
  })

  it('负数也当作不限', () => {
    expect(maxTokensFor(-1)).toBeUndefined()
  })

  it('正数原样保留（小数向下取整）', () => {
    expect(maxTokensFor(1000)).toBe(1000)
    expect(maxTokensFor(12.7)).toBe(12)
  })

  it('不限时请求里不出现 max_tokens 字段', async () => {
    const { url, bodies } = await scriptedServer([
      { toolCalls: [{ name: 'finish', args: { findings: [] } }] },
    ])
    await runAgentLoop(baseOpts(url, { maxOutputTokens: 0 }) as never)
    const sent = JSON.parse(bodies()[0]!) as Record<string, unknown>
    expect('max_tokens' in sent).toBe(false)
  }, 60_000)

  it('有限预算时请求里带上该数值', async () => {
    const { url, bodies } = await scriptedServer([
      { toolCalls: [{ name: 'finish', args: { findings: [] } }] },
    ])
    await runAgentLoop(baseOpts(url, { maxOutputTokens: 321 }) as never)
    const sent = JSON.parse(bodies()[0]!) as Record<string, unknown>
    expect(sent.max_tokens).toBe(321)
  }, 60_000)
})

describe('可复现性与轮次耗尽后的抢救', () => {
  it('请求固定 temperature: 0（评审结论必须可复现）', async () => {
    // 实测教训：同一仓库同一配置跑两次，一次 12 条一次 0 条，
    // 差别只来自服务商默认采样温度。评审工具不能这样。
    const { url, bodies } = await scriptedServer([
      { toolCalls: [{ name: 'finish', args: { findings: [] } }] },
    ])
    await runAgentLoop(baseOpts(url) as never)
    const sent = JSON.parse(bodies()[0]!) as Record<string, unknown>
    expect(sent.temperature).toBe(0)
  }, 60_000)

  it('轮次耗尽时追加一次只带 finish 的收尾请求，把已有发现带回', async () => {
    // 前三轮都在跑代码（耗尽 maxRounds=3），第四轮是收尾请求。
    const { url, bodies } = await scriptedServer([
      { toolCalls: [{ name: 'run_code', args: { program: 'return 1' } }] },
      { toolCalls: [{ name: 'run_code', args: { program: 'return 2' } }] },
      { toolCalls: [{ name: 'run_code', args: { program: 'return 3' } }] },
      { toolCalls: [{ name: 'finish', args: { findings: [{ path: 'a.ts', category: 'bug', severity: 'high', title: '抢救回来的问题' }] } }] },
    ])
    const r = await runAgentLoop(baseOpts(url, { maxRounds: 3, tools: ['read'] }) as never)

    // 状态仍是 max-rounds（不能伪装成 finished），但发现不能丢
    expect(r.stopReason).toBe('max-rounds')
    expect(r.result.findings).toHaveLength(1)
    expect(r.result.findings[0]!.title).toContain('抢救')

    // 收尾请求只有 finish，不能再花预算跑代码
    const last = JSON.parse(bodies()[bodies().length - 1]!) as { tools: Array<{ function: { name: string } }> }
    expect(last.tools.map((x) => x.function.name)).toEqual(['finish'])
  }, 60_000)

  it('收尾请求也拿不到 finish 时，仍是 max-rounds 且给出明确告警', async () => {
    const { url } = await scriptedServer([
      { toolCalls: [{ name: 'run_code', args: { program: 'return 1' } }] },
    ])
    const r = await runAgentLoop(baseOpts(url, { maxRounds: 1, tools: ['read'] }) as never)
    expect(r.stopReason).toBe('max-rounds')
    expect(r.result.findings).toHaveLength(0)
    expect(r.result.issues.join()).toContain('最大轮次')
  }, 60_000)
})
