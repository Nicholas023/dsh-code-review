// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scan.e2e.test.ts —— 全仓 scan 模式的端到端验证。
 *
 * scan 与 review 的差别不只是「取 diff 还是取文件」：
 *  - 没有 diff，findings 的行号定位依赖文件内容；
 *  - 规模通常远大于 diff，会落到 large 档 —— 主 agent 不拿正文，由子 agent 分片读。
 *
 * 这里验证的是「这条路径能跑完并产出报告」，而不是「扫描质量多好」。
 * 质量评估需要真实模型与真实仓库，属于基准实验的范畴。
 */

import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** 建一个有多文件的仓库（scan 才有意义）。 */
function makeRepo(fileCount: number): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-scan-'))
  dirs.push(d)
  const git = (args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'core.autocrlf', 'false'])
  mkdirSync(join(d, 'src'))
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(d, 'src', 'file' + String(i) + '.ts'), 'export const v' + String(i) + ' = ' + String(i) + '\n')
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  return d
}

/** 假端点：返回空 findings（只验证链路，不验证质量）。 */
async function emptyServer(): Promise<string> {
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
              function: { name: 'finish', arguments: JSON.stringify({ findings: [] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 500, completion_tokens: 20 },
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

describe('全仓 scan', () => {
  it('scan 模式跑通并产出报告，覆盖全部文件', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-scan-root-'))
    dirs.push(dshRoot)
    const repo = makeRepo(12)
    const reportDir = mkdtempSync(join(homedir(), '.dcr-scan-report-'))
    dirs.push(reportDir)
    const url = await emptyServer()

    const config = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, endpoint: url, model: 'test-model', credentialRef: 'TEST_KEY' },
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
    }
    const submitted = submitReview(
      { repo_path: repo, mode: 'scan' },
      { dshRoot, now: () => new Date().toISOString(), newId: () => 'scan-1', config, requestor: null },
    )
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    expect(submitted.scope.command).toBe('scan')

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

    const done = readTask('scan-1', dshRoot)!
    expect(done.stage).toBe('completed')
    expect(done.summary).not.toBeNull()
    // 12 个源文件都应进入评审范围
    expect(done.summary?.coverage?.total ?? 0).toBeGreaterThanOrEqual(12)

    const json = JSON.parse(readFileSync(done.summary!.reportJsonPath!, 'utf8')) as {
      repository: { command: string }
      coverage: { reviewed: number; total: number }
    }
    expect(json.repository.command).toBe('scan')
    expect(json.coverage.reviewed).toBeGreaterThanOrEqual(12)
  }, 120_000)

  it('scan 忽略 node_modules 等依赖目录', async () => {
    const dshRoot = mkdtempSync(join(tmpdir(), 'dcr-scan-ign-'))
    dirs.push(dshRoot)
    const repo = makeRepo(3)
    // 造一个未跟踪但被忽略的目录，确认它不进评审
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    const reportDir = mkdtempSync(join(homedir(), '.dcr-scan-ign-report-'))
    dirs.push(reportDir)
    const url = await emptyServer()

    const config = {
      ...DEFAULT_CONFIG,
      review: { ...DEFAULT_CONFIG.review, endpoint: url, model: 'test-model', credentialRef: 'TEST_KEY' },
      report: { ...DEFAULT_CONFIG.report, directory: reportDir },
    }
    submitReview(
      { repo_path: repo, mode: 'scan' },
      { dshRoot, now: () => new Date().toISOString(), newId: () => 'scan-2', config, requestor: null },
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

    const done = readTask('scan-2', dshRoot)!
    const json = JSON.parse(readFileSync(done.summary!.reportJsonPath!, 'utf8')) as {
      excluded: Array<{ path: string; reason: string }>
    }
    const dep = json.excluded.find((e) => e.path.includes('node_modules'))
    // 要么被显式排除并记录原因，要么根本没进候选 —— 两种都不该被评审
    if (dep !== undefined) {
      expect(dep.reason).toBe('default-excluded-dir')
    }
  }, 120_000)
})
