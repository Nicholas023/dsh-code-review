// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * demo-review.mjs —— 0.2.0 内核的端到端演示（本地假端点，不联网）。
 *
 * 用途：证明「从仓库状态到报告文件」这条链路是通的。
 * 不参与 CI，不提交报告文件到仓库。
 */

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = 'file:///' + process.cwd().replace(/\\/g, '/') + '/dist/orchestrator/review.js'
const { runReview } = await import(HERE)

// 1. 建一个有真实问题的仓库
const repo = mkdtempSync(join(tmpdir(), 'dcr-demo-'))
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git(['init', '-q'])
git(['config', 'user.email', 'demo@example.com'])
git(['config', 'user.name', 'Demo'])
git(['config', 'core.autocrlf', 'false'])
writeFileSync(join(repo, 'auth.ts'), [
  'export function login(input: string) {',
  '  const user = findUser(input)',
  '  return user.name.toUpperCase()',
  '}',
  '',
].join('\n'))
git(['add', '-A'])
git(['commit', '-q', '-m', 'init'])

// 2. 引入一个真实 bug（空指针）+ 一个硬编码密钥
writeFileSync(join(repo, 'auth.ts'), [
  'const API_KEY = "sk-live-9f8e7d6c5b4a3210zyxwvutsrqponm"',
  '',
  'export function login(input: string) {',
  '  const user = findUser(input)',
  '  return user.name.toUpperCase()',
  '}',
  '',
].join('\n'))

// 3. 假端点：模拟模型给出两条发现
const server = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    const findings = [
      {
        path: 'auth.ts',
        line: 3,
        category: 'bug',
        severity: 'high',
        title: 'user 可能为 null 时直接解引用',
        evidence: 'return user.name.toUpperCase()',
        explanation: 'findUser 在找不到用户时返回 null，这里没有判空，会抛 TypeError。',
        recommendation: 'if (!user) throw new Error("用户不存在")',
        confidence: 0.9,
      },
      {
        path: 'auth.ts',
        line: 1,
        category: 'privacy',
        severity: 'critical',
        title: '硬编码 API 密钥',
        evidence: 'const API_KEY = "sk-live-..."',
        explanation: '密钥以明文写在源码里，提交到公开仓库即泄露。',
        recommendation: '改为从环境变量读取，并轮换该密钥。',
        confidence: 0.98,
      },
    ]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ findings }) } }] } }],
      usage: { prompt_tokens: 1800, completion_tokens: 260, prompt_cache_hit_tokens: 1500 },
    }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// 4. 跑一次完整评审
const { DEFAULT_CONFIG } = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/dist/config/defaults.js')
const out = await runReview({
  scope: { repoPath: repo, command: 'review', mode: 'uncommitted', baseRef: null, headRef: null, commit: null, focus: '开源前安全检查', excludePaths: [] },
  config: DEFAULT_CONFIG,
  llm: { baseUrl: 'http://127.0.0.1:' + port, apiKey: 'demo', requestTimeoutMs: 5000 },
  runner: { nodePath: process.execPath, entryPath: join(process.cwd(), 'dist/ptc/runner-entry.js'), timeoutMs: 10000, memoryMb: 256 },
})

server.close()

// 5. 渲染并写报告
const { renderMarkdown } = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/dist/report/markdown.js')
const { resolveLocation } = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/dist/report/line-resolver.js')
const { redact } = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/dist/report/redact.js')
const { writeReport } = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/dist/report/writer.js')

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  run: { taskId: 'demo-1', kernelVersion: '0.2.0', protocolVersion: 1 },
  model: { id: 'deepseek-flash', endpointHost: '127.0.0.1' },
  repository: { path: repo, command: 'review', mode: 'uncommitted', baseRef: null, headRef: null, commit: null },
  hashes: { systemPrompt: null },
  status: out.status,
  findings: out.findings.map((f, i) => ({
    id: 'f' + i, path: f.path, lineStart: f.line, lineEnd: f.line, lineSource: 'exact',
    category: f.category, severity: f.severity, title: redact(f.title),
    evidence: redact(f.evidence), explanation: redact(f.explanation), recommendation: redact(f.recommendation),
    confidence: f.confidence, sourceAgent: 'main', sourceTask: null, ruleIds: [],
    status: 'confirmed', suppressionReason: null, fingerprint: f.path + '|' + f.line + '|' + f.category,
  })),
  sensitiveFiles: out.sensitiveFiles,
  excluded: out.excluded.map((e) => ({ path: e.path, reason: e.reason, detail: e.detail })),
  coverage: out.coverage,
  sizing: out.sizing,
  agents: out.agentStops.map((a) => ({ name: a.agent, stopReason: a.stopReason, rounds: a.rounds })),
  usage: out.usage,
  warnings: out.warnings,
  elapsedSec: 0.4,
}

const md = renderMarkdown(report)
const written = writeReport({
  directory: join(homedir(), '.dsh-code-review-demo'),
  repoName: 'demo-repo',
  baseName: 'demo-' + String(Date.now()),
  markdown: md,
  json: JSON.stringify(report, null, 2),
})

console.log('=== 状态 ===')
console.log('status:', out.status)
console.log('覆盖:', out.coverage.reviewed + '/' + out.coverage.total)
console.log('发现:', out.findings.length, '条')
console.log('用量: input=' + out.usage.inputTokens + ' output=' + out.usage.outputTokens + ' cacheRead=' + out.usage.cacheReadTokens)
console.log('\n=== 报告文件 ===')
console.log('markdown:', written.markdownPath)
console.log('json    :', written.jsonPath)
console.log('\n=== 报告正文 ===')
console.log(md)
console.log('\n=== 脱敏验证 ===')
console.log('原文含密钥?', md.includes('sk-live-9f8e7d6c5b4a3210zyxwvutsrqponm'))
console.log('含 [REDACTED]?', md.includes('[REDACTED]'))

rmSync(repo, { recursive: true, force: true })
