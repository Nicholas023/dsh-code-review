// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * line-locate.test.ts —— 行号定位在真实链路上生效（回归测试）。
 *
 * 曾经的缺陷：执行层调用 resolveLocation(undefined, ...)，永远拿不到 diff，
 * 于是每条发现都被标成 unresolved，报告里全显示「位置未定位」——
 * 哪怕模型给的行号完全正确。
 *
 * 修复后定位在编排层做（那里有 diff）。这里验证三种情况：
 *  1. 模型给的行号确实落在新增行 → exact；
 *  2. 行号不准但证据唯一匹配 → diff-resolved（行号被修正）；
 *  3. 既不匹配证据也越界 → unresolved（不瞎猜）。
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

/** 建仓库：提交一个基准文件，再改成「有新增行」的状态。 */
function makeRepoWithChange(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-locate-'))
  dirs.push(d)
  const git = (args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(d, 'a.ts'), 'const a = 1\nconst b = 2\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  // 改动后：第 2 行是新增行
  writeFileSync(join(d, 'a.ts'), 'const a = 1\nconst added = compute()\nconst b = 2\n')
  return d
}

/** 假端点：返回给定的 findings。 */
async function serverReturning(findings: unknown[]): Promise<string> {
  const server = createServer((req, res) => {
    req.on('data', () => { /* 丢弃 */ })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'finish', arguments: JSON.stringify({ findings }) },
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
  return 'http://127.0.0.1:' + String(port)
}

/** 跑一次评审，返回 findings。 */
async function runWith(findings: unknown[]) {
  const repo = makeRepoWithChange()
  const url = await serverReturning(findings)
  return runReview({
    scope: {
      repoPath: repo,
      command: 'review',
      mode: 'uncommitted',
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
}

const base = { path: 'a.ts', category: 'bug', severity: 'high', title: 't', explanation: 'x', recommendation: 'r', confidence: 0.9 }

describe('行号定位', () => {
  it('落在新增行上判为 exact', async () => {
    const out = await runWith([{ ...base, line: 2, evidence: 'const added = compute()' }])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.lineSource).toBe('exact')
    expect(out.findings[0]!.line).toBe(2)
  }, 120_000)

  it('行号不准但证据唯一匹配时修正行号并标记 diff-resolved', async () => {
    const out = await runWith([{ ...base, line: 99, evidence: 'const added = compute()' }])
    expect(out.findings[0]!.lineSource).toBe('diff-resolved')
    expect(out.findings[0]!.line).toBe(2)
  }, 120_000)

  it('既无匹配证据又无合法行号时判 unresolved（不瞎猜）', async () => {
    const out = await runWith([{ ...base, line: 99, evidence: '完全不存在的片段 zzzz' }])
    expect(out.findings[0]!.lineSource).toBe('unresolved')
  }, 120_000)
})
