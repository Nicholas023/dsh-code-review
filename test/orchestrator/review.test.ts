// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * review.test.ts —— 总编排的端到端测试。
 *
 * 用真实临时 git 仓库 + 假 LLM 端点，验证「从仓库状态到结构化结果」这条链路。
 * 重点断言编排层的判断：档位、派发、敏感点名、状态区分。
 */

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { runReview } from '../../src/orchestrator/review.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const dirs: string[] = []
const servers: Server[] = []

/** 建临时仓库。 */
function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-orch-'))
  dirs.push(d)
  const git = (args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(d, 'a.ts'), 'export const a = 1\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  return d
}

/** 假端点：总是返回 finish。 */
async function finishServer(findings: unknown[] = []): Promise<{ url: string; calls: () => number }> {
  let n = 0
  const server = createServer((req, res) => {
    req.on('data', () => { /* 丢弃 */ })
    req.on('end', () => {
      n += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'c' + String(n),
              type: 'function',
              function: { name: 'finish', arguments: JSON.stringify({ findings }) },
            }],
          },
        }],
        usage: { prompt_tokens: 500, completion_tokens: 50 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { url: 'http://127.0.0.1:' + String(port), calls: () => n }
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

beforeAll(() => {
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' })
}, 120_000)

/** 基础输入。 */
function makeInput(repo: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    scope: {
      repoPath: repo,
      command: 'review' as const,
      mode: 'uncommitted' as const,
      baseRef: null,
      headRef: null,
      commit: null,
      focus: null,
      excludePaths: [],
    },
    config: DEFAULT_CONFIG,
    llm: { baseUrl: url, apiKey: 'k', requestTimeoutMs: 5000 },
    runner: { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 10_000, memoryMb: 256 },
    ...overrides,
  }
}

describe('总编排', () => {
  it('无改动时返回 completed 且零文件', async () => {
    const repo = makeRepo()
    const { url } = await finishServer()
    const out = await runReview(makeInput(repo, url) as never)
    expect(out.status).toBe('completed')
    expect(out.coverage.reviewed).toBe(0)
    expect(out.findings).toHaveLength(0)
  }, 60_000)

  it('小改动走小档，主 agent 一轮完成', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2\n')
    const { url, calls } = await finishServer()
    const out = await runReview(makeInput(repo, url) as never)
    expect(out.sizing.tier).toBe('small')
    expect(out.status).toBe('completed')
    expect(out.agentStops[0]!.agent).toBe('main')
    // 小档不派子 agent：只应有主 agent 一次调用
    expect(calls()).toBe(1)
    expect(out.usage.agents).toBe(1)
  }, 60_000)

  it('发现被原样带出（不丢字段）', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'export const a = 3\n')
    const { url } = await finishServer([
      { path: 'a.ts', line: 1, category: 'bug', severity: 'high', title: '问题', evidence: 'e', explanation: 'x', recommendation: 'r', confidence: 0.8 },
    ])
    const out = await runReview(makeInput(repo, url) as never)
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.path).toBe('a.ts')
    expect(out.findings[0]!.severity).toBe('high')
  }, 60_000)

  it('敏感文件被点名且不送审', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '.env'), 'SECRET=abc\n')
    const { url } = await finishServer()
    const out = await runReview(makeInput(repo, url) as never)
    expect(out.sensitiveFiles).toContain('.env')
    // 被排除而不是被评审
    const excluded = out.excluded.find((e) => e.path === '.env')
    expect(excluded?.reason).toBe('sensitive')
  }, 60_000)

  it('主 agent 未完成时状态为 partial 并记录原因', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.ts'), 'export const a = 4\n')
    // 让端点永不返回 finish（只返回普通文本），触发 no-progress
    let n = 0
    const server = createServer((req, res) => {
      req.on('data', () => { /* 丢弃 */ })
      req.on('end', () => {
        n += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '随便说点' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0

    const out = await runReview(makeInput(repo, 'http://127.0.0.1:' + String(port)) as never)
    expect(out.status).toBe('partial')
    expect(out.warnings.join()).toContain('未正常完成')
  }, 60_000)
})
