// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scan-tier.test.ts —— scan 模式不能盲审（回归测试）。
 *
 * 曾经的缺陷：scan 枚举的是文件清单、没有 diff，于是 token 估算恒为 0，
 * 被判成「小档」；而小档的策略是不给工具、只读 diff ——
 * 模型手上既没有内容也没有读取能力，评审变成走过场。
 *
 * 这里从两个角度锁住修复：
 *  1. decideTier 对 scan 恒返回 large（不看 token 估算）；
 *  2. 真实跑一次 scan，断言主 agent 的 system prompt 里带了 SDK 声明。
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
  it('scan 恒为大档（不受 token 估算影响）', () => {
    expect(decideTier('scan', 0, DEFAULT_THRESHOLDS)).toBe('large')
    expect(decideTier('scan', 1, DEFAULT_THRESHOLDS)).toBe('large')
    expect(decideTier('scan', 9_999_999, DEFAULT_THRESHOLDS)).toBe('large')
  })

  it('review 按 token 正常分档', () => {
    expect(decideTier('review', 100, DEFAULT_THRESHOLDS)).toBe('small')
    expect(decideTier('review', 50_000, DEFAULT_THRESHOLDS)).toBe('medium')
    expect(decideTier('review', 2_000_000, DEFAULT_THRESHOLDS)).toBe('large')
  })

  it('大档策略给 SDK（模型才有能力读文件）', () => {
    expect(mainAgentPolicy('large').sdk).toBe(true)
  })

  it('小档策略不给 SDK（省 token）', () => {
    expect(mainAgentPolicy('small').sdk).toBe(false)
  })
})

describe('scan 真实执行', () => {
  /** 起一个假端点，捕获 system prompt 后返回 finish。 */
  async function captureSystem(): Promise<{ url: string; systems: string[] }> {
    const systems: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString('utf8') })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> }
          const sys = parsed.messages?.find((m) => m.role === 'system')
          if (sys !== undefined) systems.push(sys.content)
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
    return { url: 'http://127.0.0.1:' + String(port), systems }
  }

  it('scan 模式下主 agent 的 system prompt 声明了 SDK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcr-scan-tier-'))
    dirs.push(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })

    const { url, systems } = await captureSystem()
    await runReview({
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
      config: DEFAULT_CONFIG,
      llm: { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000 },
      runner: { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 10_000, memoryMb: 256 },
    })

    expect(systems.length).toBeGreaterThan(0)
    const sys = systems[0]!
    // SDK 声明的标志：tools.read / tools.glob / tools.grep
    expect(sys).toContain('tools.read')
    expect(sys).toContain('tools.glob')
    // 天然不该出现「不需要调用任何工具」那句（那是小档专属）
    expect(sys).not.toContain('不需要调用任何工具')
  }, 120_000)
})
