// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * pipeline.e2e.test.ts —— 端到端：从提交任务到报告落盘。
 *
 * 这是唯一一个把全部环节串起来的测试：
 *   提交（参数校验 + 任务卡） → 内核认领 → 编排（git/diff/筛选/agent）→ 报告 → 任务卡终态
 *
 * 用假 LLM 端点，所以不联网、不花钱，可以进 CI。
 * 真实端点的验证留给 scripts/benchmark-tokens.mjs --real（需要人工配置）。
 */

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { serve } from '../../src/kernel/serve.js'
import { submitReview } from '../../src/plugin/submit.js'
import { readTask } from '../../src/store/task-store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')

const dirs: string[] = []
const servers: Server[] = []

function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-e2e-repo-'))
  dirs.push(d)
  const git = (args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(d, 'auth.ts'), 'export function login(u) { return u.name.toUpperCase() }\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  return d
}

/** 假端点：永远返回带一条发现的 finish。 */
async function finishServer(): Promise<string> {
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
              function: {
                name: 'finish',
                arguments: JSON.stringify({
                  findings: [{
                    path: 'auth.ts',
                    line: 1,
                    category: 'bug',
                    severity: 'high',
                    title: 'u 可能为 null',
                    evidence: 'u.name.toUpperCase()',
                    explanation: '未判空',
                    recommendation: '加空值判断',
                    confidence: 0.9,
                  }],
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 800, completion_tokens: 60, prompt_cache_hit_tokens: 600 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return 'http://127.0.0.1:' + String(port)
}

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

/** 造一个 home 下的报告目录（writer 会校验必须在 home 之下）。 */
function makeReportDir(): string {
  const d = mkdtempSync(join(homedir(), '.dcr-e2e-report-'))
  dirs.push(d)
  return d
}

describe('端到端：提交 → 认领 → 评审 → 报告', () => {
  it('完整链路产出报告并把任务卡推进到 completed', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-e2e-root-'))
    dirs.push(dshRoot)
    const repo = makeRepo()
    // 关键：workspace 模式取的是「未提交改动」，必须真的改一个文件才有 diff
    writeFileSync(join(repo, 'auth.ts'), 'export function login(u) { const API_KEY = "sk-x"; return u.name.toUpperCase() }\n')
    const reportDir = makeReportDir()
    const url = await finishServer()

    // ① 提交（走真实参数校验 + 任务卡写入）
    const config = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, endpoint: url, model: 'test-model', credentialRef: 'TEST_KEY' },
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
    }
    const submitted = submitReview(
      { repo_path: repo },
      {
        dshRoot,
        now: () => new Date().toISOString(),
        newId: () => 'e2e-task-1',
        config,
        requestor: null,
      },
    )
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return

    expect(readTask('e2e-task-1', dshRoot)?.stage).toBe('queued')

    // ② 内核跑一轮（once 模式）
    const result = await serve({
      dshRoot,
      once: true,
      deps: {
        resolveCredential: () => 'fake-key',
        nodePath: process.execPath,
        runnerEntry: ENTRY,
        now: () => new Date().toISOString(),
      },
      log: () => { /* 静默 */ },
    })
    expect(result.processed).toBe(1)

    // ③ 任务卡进入终态，带 summary
    const done = readTask('e2e-task-1', dshRoot)!
    expect(done.stage).toBe('completed')
    expect(done.summary).not.toBeNull()
    expect(done.summary?.findingCount).toBe(1)

    // ④ 报告文件真的落盘了
    const mdPath = done.summary?.reportPath
    const jsonPath = done.summary?.reportJsonPath
    expect(mdPath).not.toBeNull()
    expect(jsonPath).not.toBeNull()
    expect(existsSync(mdPath!)).toBe(true)
    expect(existsSync(jsonPath!)).toBe(true)

    // ⑤ 内容对得上
    const md = readFileSync(mdPath!, 'utf8')
    expect(md).toContain('代码审查报告')
    expect(md).toContain('u 可能为 null')

    const json = JSON.parse(readFileSync(jsonPath!, 'utf8')) as {
      schemaVersion: number
      status: string
      findings: unknown[]
      usage: { inputTokens: number; cacheReadTokens: number }
    }
    expect(json.schemaVersion).toBe(1)
    expect(json.status).toBe('completed')
    expect(json.findings).toHaveLength(1)
    expect(json.usage.inputTokens).toBe(800)
    expect(json.usage.cacheReadTokens).toBe(600)
  }, 120_000)

  it('缺端点时任务失败且不产生报告（红线：不隐式兜底）', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-e2e-nocfg-'))
    dirs.push(dshRoot)
    const repo = makeRepo()
    writeFileSync(join(repo, 'auth.ts'), 'export function login(u) { return (u.name ?? "").toUpperCase() }\n')
    const reportDir = makeReportDir()

    const config = {
      ...DEFAULT_CONFIG,
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
    }
    const submitted = submitReview(
      { repo_path: repo },
      { dshRoot, now: () => new Date().toISOString(), newId: () => 'e2e-task-2', config, requestor: null },
    )
    expect(submitted.ok).toBe(true)

    const result = await serve({
      dshRoot,
      once: true,
      deps: {
        resolveCredential: () => null,
        nodePath: process.execPath,
        runnerEntry: ENTRY,
        now: () => new Date().toISOString(),
      },
      log: () => { /* 静默 */ },
    })
    expect(result.processed).toBe(1)

    const failed = readTask('e2e-task-2', dshRoot)!
    expect(failed.stage).toBe('failed')
    expect(failed.failure?.code).toBe('CONFIG_MODEL_ENDPOINT_MISSING')
    // 没有报告：连外呼都没发生
    expect(failed.summary).toBeNull()
  }, 120_000)

  it('敏感文件不送审但在报告里被点名', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-e2e-sens-'))
    dirs.push(dshRoot)
    const repo = makeRepo()
    writeFileSync(join(repo, '.env'), 'SECRET=abc\n')
    const reportDir = makeReportDir()
    const url = await finishServer()

    const config = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, endpoint: url, model: 'test-model', credentialRef: 'TEST_KEY' },
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
    }
    submitReview(
      { repo_path: repo },
      { dshRoot, now: () => new Date().toISOString(), newId: () => 'e2e-task-3', config, requestor: null },
    )
    await serve({
      dshRoot,
      once: true,
      deps: {
        resolveCredential: () => 'fake-key',
        nodePath: process.execPath,
        runnerEntry: ENTRY,
        now: () => new Date().toISOString(),
      },
      log: () => { /* 静默 */ },
    })

    const done = readTask('e2e-task-3', dshRoot)!
    const json = JSON.parse(readFileSync(done.summary!.reportJsonPath!, 'utf8')) as {
      sensitiveFiles: string[]
    }
    expect(json.sensitiveFiles).toContain('.env')
    // 报告里不能出现 .env 的内容
    const md = readFileSync(done.summary!.reportPath!, 'utf8')
    expect(md).not.toContain('SECRET=abc')
  }, 120_000)
})
