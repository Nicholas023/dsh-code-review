// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * report-redact.test.ts —— 脱敏的边界：该遮的遮住，该留的留住。
 *
 * 之前是整个报告 `redactDeep`，后果是 commit SHA（40 位十六进制）也命中高熵规则
 * 被打成 [REDACTED] —— 用户拿到报告第一件事就是想核对「审的是哪个提交」，
 * 结果那正是唯一被遮住的信息。
 *
 * 现在只脱敏自由文本（title/evidence/explanation/recommendation/warnings），
 * 结构化标识（commit、路径、任务 id）保持原样。
 */

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { executeTask } from '../../src/kernel/execute-task.js'
import { submitReview } from '../../src/plugin/submit.js'
import { readTask } from '../../src/store/task-store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')

/** 测试里用的假密钥（形态像真的，便于验证脱敏）。 */
const FAKE_SECRET = 'sk-live-9f8e7d6c5b4a3210zyxwvutsrqponmlk'

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

/** 建一个含「泄露密钥的提交」的仓库，返回仓库路径与该提交 SHA。 */
function makeRepoWithSecretCommit(): { repo: string; sha: string } {
  const d = mkdtempSync(join(tmpdir(), 'dcr-redact-'))
  dirs.push(d)
  const git = (args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(d, 'auth.ts'), 'export const x = 1\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  // 第二个提交：把密钥写进代码
  writeFileSync(join(d, 'auth.ts'), 'export const API_KEY = "' + FAKE_SECRET + '"\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'add key'])
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim()
  return { repo: d, sha }
}

/** 假端点：返回一条期望含密钥证据的发现。 */
async function secretEvidenceServer(): Promise<string> {
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
                    category: 'privacy',
                    severity: 'critical',
                    title: '硬编码密钥',
                    // 证据里带上完整密钥：报告必须把它遮掉
                    evidence: 'export const API_KEY = "' + FAKE_SECRET + '"',
                    explanation: '明文密钥会随仓库公开',
                    recommendation: '改用环境变量',
                    confidence: 0.95,
                  }],
                }),
              },
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
  return 'http://127.0.0.1:' + String(port)
}

describe('报告脱敏边界', () => {
  it('密钥被遮住，commit SHA 保持完整', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-redact-root-'))
    dirs.push(dshRoot)
    const reportDir = mkdtempSync(join(homedir(), '.dcr-redact-report-'))
    dirs.push(reportDir)
    const { repo, sha } = makeRepoWithSecretCommit()
    const url = await secretEvidenceServer()

    const config = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, endpoint: url, model: 'test-model', credentialRef: 'K' },
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
    }
    const submitted = submitReview(
      { repo_path: repo, mode: 'commit', commit: sha },
      { dshRoot, now: () => new Date().toISOString(), newId: () => 'redact-1', config, requestor: null },
    )
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return

    const record = readTask('redact-1', dshRoot)!
    const outcome = await executeTask(record, {
      resolveCredential: () => 'fake-key',
      nodePath: process.execPath,
      runnerEntry: ENTRY,
      now: () => new Date().toISOString(),
    })
    expect(outcome.ok).toBe(true)

    const json = JSON.parse(readFileSync(outcome.reportJsonPath!, 'utf8')) as {
      repository: { commit: string | null }
      findings: Array<{ evidence: string; title: string }>
    }

    // ① commit SHA 必须完整保留 —— 这是用户核对「审的是哪个提交」的唯一凭据
    expect(json.repository.commit).toBe(sha)

    // ② 证据里的密钥必须被遮住
    const evidence = json.findings[0]!.evidence
    expect(evidence).not.toContain(FAKE_SECRET)
    expect(evidence).toContain('[REDACTED]')

    // ③ Markdown 报告同样：密钥不出现
    const md = readFileSync(outcome.reportPath!, 'utf8')
    expect(md).not.toContain(FAKE_SECRET)
    // 但 SHA 要在（报告头里会写「提交：<sha>」）
    expect(md).toContain(sha)
  }, 120_000)
})
