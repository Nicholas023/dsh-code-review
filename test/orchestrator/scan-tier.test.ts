// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scan-tier.test.ts —— scan 模式的规模档位与「不能盲审」回归测试。
 *
 * 历史缺陷（两次，都在这一个文件里）：
 *
 *   第一次：scan 枚举的是文件清单、没有 diff，token 估算恒为 0 → 被判小档 →
 *           小档不给工具也不给正文 → 盲审。当时的补丁是「scan 恒为大档」。
 *
 *   第二次（真机复现）：那个补丁只是让主 agent 拿到了工具，但：
 *           ① 报表里「规模 0 tokens」；
 *           ② 单文件超限过滤永远不触发；
 *           ③ 任务提示词里「变更内容」是空的、清单写着 +0 -0；
 *           于是模型没有任何体积信号，只能一轮读一个文件，很快撞上轮次上限，
 *           最终的产物是「0 个问题」——一个没跑完的评审伪装成干净结论。
 *
 * 现在的契约：scan 会把受支持的文件整份合成为「新增」，体积与内容都是真的，
 * 因此它与 review 走同一条正常规则 —— 小仓库给正文、大仓库给清单 + SDK。
 * 这个文件用**配置阈值做控制变量**，把两侧都锁住。
 */

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { DEFAULT_THRESHOLDS, mainAgentPolicy } from '../../src/domain/review.js'
import { decideTier, runReview } from '../../src/orchestrator/review.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const dirs: string[] = []
const servers: Server[] = []

beforeAll(() => {
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' })
}, 120_000)

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()
    if (s) await new Promise<void>((r) => s.close(() => r()))
  }
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('档位决策', () => {
  it('scan 与 review 走同一套按体积分档（不再无条件大档）', () => {
    // 同一组 token 输入，两种模式必须给出同样的档位 —— 这正是「不再特殊对待」的含义
    for (const tokens of [100, 50_000, 2_000_000]) {
      expect(decideTier('scan', tokens, DEFAULT_THRESHOLDS)).toBe(decideTier('review', tokens, DEFAULT_THRESHOLDS))
    }
    expect(decideTier('scan', 100, DEFAULT_THRESHOLDS)).toBe('small')
    expect(decideTier('scan', 2_000_000, DEFAULT_THRESHOLDS)).toBe('large')
  })

  it('大档策略给 SDK（模型才有能力按需读文件）', () => {
    expect(mainAgentPolicy('large').sdk).toBe(true)
  })

  it('小档策略不给 SDK（正文已在提示里，省 token）', () => {
    expect(mainAgentPolicy('small').sdk).toBe(false)
  })
})

/** 起一个假端点：记录每条请求的 messages，然后立刻 finish。 */
async function captureMessages(): Promise<{ url: string; requests: Array<Array<{ role: string; content: string }>> }> {
  const requests: Array<Array<{ role: string; content: string }>> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8') })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> }
        if (parsed.messages !== undefined) requests.push(parsed.messages)
      } catch { /* 忽略解析失败 */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'finish', arguments: JSON.stringify({ findings: [] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { url: 'http://127.0.0.1:' + String(port), requests }
}

/** 造一个只有一个小文件的仓库。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dcr-scan-tier-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

/** 跑一次 scan，返回结果与「主 agent 收到的用户消息」。 */
async function scanOnce(config: typeof DEFAULT_CONFIG) {
  const dir = makeRepo()
  const { url, requests } = await captureMessages()
  const out = await runReview({
    scope: {
      repoPath: dir,
      command: 'scan',
      mode: null,
      baseRef: null,
      headRef: null,
      commit: null,
      focus: null,
      excludePaths: [],
    },
    config,
    llm: { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000 },
    runner: { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 10_000, memoryMb: 256 },
  })
  const first = requests[0] ?? []
  const system = first.find((m) => m.role === 'system')?.content ?? ''
  const user = first.find((m) => m.role === 'user')?.content ?? ''
  return { out, system, user }
}

describe('scan 真实执行', () => {
  it('小仓库：估算出真实体积，正文直接进提示词', async () => {
    const { out, system, user } = await scanOnce(DEFAULT_CONFIG)

    // 回归：曾经恒为 0，导致报表写「规模 0 tokens」、超限过滤形同虚设
    expect(out.sizing.totalTokens).toBeGreaterThan(0)
    expect(out.sizing.tier).toBe('small')

    // 小档：正文在提示里，因此不需要 SDK
    expect(user).toContain('export const a = 1')
    expect(system).not.toContain('tools.read')
  }, 120_000)

  it('大仓库：只给清单与 SDK，正文让模型按需读取', async () => {
    // 控制变量：把阈值压到极低，让同一个仓库被判为大档
    const tiny: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      sizing: { ...DEFAULT_CONFIG.sizing, smallTokens: 1, largeTokens: 2 },
    }
    const { out, system, user } = await scanOnce(tiny)

    expect(out.sizing.tier).toBe('large')
    expect(system).toContain('tools.read')
    expect(system).toContain('tools.glob')
    // 大档刻意不把正文塞进提示（否则上下文直接爆），清单仍然有
    expect(user).toContain('a.ts')
    expect(user).not.toContain('export const a = 1')
  }, 120_000)
})
