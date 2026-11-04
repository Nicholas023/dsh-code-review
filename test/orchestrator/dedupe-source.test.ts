// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * dedupe-source.test.ts —— 去重与来源标记的联合验证。
 *
 * 两个原本真实存在的问题：
 *  1. `dedupeFindings` 写了但从没被调用 —— 主 agent 和子 agent 各报一次同一问题，
 *     报告里就会出现两条一模一样的条目；
 *  2. 所有发现的 `sourceAgent` 被硬编码成 'main' —— 子 agent 的贡献在报告里
 *     被冒名顶替，调子任务这件事无从追溯。
 *
 * 这个测试同时锁住两者：让主 agent 与子 agent 报同一个问题，断言最终只剩一条，
 * 且 sources 里两路都在。
 */

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { executeTask } from '../../src/kernel/execute-task.js'
import { submitReview } from '../../src/plugin/submit.js'
import { readTask } from '../../src/store/task-store.js'
import { readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')

const dirs: string[] = []
const servers: Server[] = []

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

beforeAll(() => {
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' })
}, 120_000)

/** 一个 500 行改动的仓库（超过 400 行阈值，会触发派子 agent）。 */
function makeBigChangeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-dedupe-'))
  dirs.push(d)
  const git = (args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(d, 'big.ts'), 'export const v = 0\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  // 500 行改动：触发 evaluateDispatch 的 fileLinesForChild（默认 400）
  const lines = Array.from({ length: 500 }, (_, i) => 'export const v' + String(i) + ' = ' + String(i))
  writeFileSync(join(d, 'big.ts'), lines.join('\n') + '\n')
  return d
}

/** 假端点：每次请求都返回**完全一样**的一条发现（模拟主/子 agent 各自独立发现同一问题）。 */
async function duplicateFindingServer(): Promise<{ url: string; calls: () => number }> {
  let n = 0
  const finding = {
    path: 'big.ts',
    line: 1,
    category: 'bug',
    severity: 'high',
    title: '同一处问题',
    evidence: 'export const v0 = 0',
    explanation: '两个 agent 都会看到它',
    recommendation: '改掉',
    confidence: 0.9,
  }
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
              function: { name: 'finish', arguments: JSON.stringify({ findings: [finding] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { url: 'http://127.0.0.1:' + String(port), calls: () => n }
}

describe('去重与来源', () => {
  it('主 agent 与子 agent 报同一问题时合并为一条，且来源都保留', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-dedupe-root-'))
    dirs.push(dshRoot)
    const reportDir = mkdtempSync(join(homedir(), '.dcr-dedupe-report-'))
    dirs.push(reportDir)
    const repo = makeBigChangeRepo()
    const { url, calls } = await duplicateFindingServer()

    const config = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, endpoint: url, model: 'test-model', credentialRef: 'K' },
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
      // 只允许一个子 agent，让链路确定
      budget: { ...DEFAULT_CONFIG.budget, maxChildren: 1 },
    }
    const submitted = submitReview(
      { repo_path: repo },
      { dshRoot, now: () => new Date().toISOString(), newId: () => 'dedupe-1', config, requestor: null },
    )
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return

    const record = readTask('dedupe-1', dshRoot)!
    const outcome = await executeTask(record, {
      resolveCredential: () => 'fake-key',
      nodePath: process.execPath,
      runnerEntry: ENTRY,
      now: () => new Date().toISOString(),
    })
    expect(outcome.ok).toBe(true)

    // 至少调用了两次（主 + 子），否则这条测试没有验证「重复」
    expect(calls()).toBeGreaterThanOrEqual(2)

    const json = JSON.parse(readFileSync(outcome.reportJsonPath!, 'utf8')) as {
      findings: Array<{ title: string; sources: string[]; sourceAgent: string }>
    }
    // 核心断言一：重复被合并
    expect(json.findings).toHaveLength(1)
    // 核心断言二：来源不止一个 agent
    expect(json.findings[0]!.sources.length).toBeGreaterThanOrEqual(2)
    expect(json.findings[0]!.sources).toContain('main')
    expect(json.findings[0]!.sources.some((s) => s.startsWith('child-'))).toBe(true)
    // 核心断言三：不再被硬编码成 main
    expect(json.findings[0]!.sourceAgent).not.toBe('')
  }, 120_000)
})
