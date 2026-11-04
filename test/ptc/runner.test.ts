// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * runner.test.ts —— run_code 子进程的端到端测试。
 *
 * 这里是 0.2.0 唯一真正 spawn 子进程执行模型代码的地方，所以必须验证：
 *  1. 正常程序能拿到结果；
 *  2. 死循环被硬超时干掉（父进程存活）；
 *  3. 程序无法访问 require/process（能力受限）；
 *  4. 返回值超限被明确标记而不是静默截断。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runCodeProgram } from '../../src/ptc/runner-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const dirs: string[] = []
function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-runner-'))
  dirs.push(d)
  mkdirSync(join(d, 'src'), { recursive: true })
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1\n')
  return d
}

// 每个用例结束后删掉临时仓库：不清理会让 Temp 里堆积大量 dcr-runner-* 目录
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // Windows 上 git/杀软可能短暂占用，清理失败不影响测试结论
      }
    }
  }
})

beforeAll(() => {
  // 构建 runner 产物（一次即可；失败会让 ENTRY 不存在，测试直接暴露而不是假绿）
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' })
}, 120_000)

describe('runner 端到端', () => {
  it('产物已生成（前置条件）', () => {
    expect(existsSync(ENTRY)).toBe(true)
  })

  it('执行简单程序并拿回返回值', async () => {
    const root = makeRepo()
    const r = await runCodeProgram(
      { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 15_000, memoryMb: 256 },
      { program: 'return { ok: 42 }', root, tools: ['read'] },
    )
    expect(r.ok).toBe(true)
    expect(r.response?.value).toEqual({ ok: 42 })
  }, 60_000)

  it('程序能通过 SDK 读取仓库文件', async () => {
    const root = makeRepo()
    const program = [
      'const r = tools.read({ path: "src/a.ts" })',
      'return { status: r.status, first: r.data ? r.data.lines[0].text : null }',
    ].join('\n')
    const res = await runCodeProgram(
      { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 15_000, memoryMb: 256 },
      { program, root, tools: ['read'] },
    )
    expect(res.ok).toBe(true)
    expect((res.response?.value as any).status).toBe('completed')
    expect((res.response?.value as any).first).toContain('export const a');
  }, 60_000)

  it('死循环被硬超时终止，且不影响父进程', async () => {
    const root = makeRepo()
    const started = Date.now()
    const r = await runCodeProgram(
      { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 1500, memoryMb: 256 },
      { program: 'while (true) {}', root, tools: [] },
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.code).toBe('RUNTIME_RUNNER_TIMEOUT')
    // 父进程仍然活着（能执行到这里本身就是证明）
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 60_000)

  it('程序无法访问 require / process（能力受限）', async () => {
    const root = makeRepo()
    const program = 'try { return { hasRequire: typeof require, hasProcess: typeof process } } catch (e) { return { error: String(e) } }'
    const r = await runCodeProgram(
      { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 15_000, memoryMb: 256 },
      { program, root, tools: [] },
    )
    expect(r.ok).toBe(true)
    const v = r.response?.value as any
    expect(v.hasRequire).toBe('undefined')
    expect(v.hasProcess).toBe('undefined')
  }, 60_000)

  it('返回值超限被标记 truncated', async () => {
    const root = makeRepo()
    const program = 'return { big: "x".repeat(20000) }'
    const r = await runCodeProgram(
      { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 15_000, memoryMb: 256 },
      { program, root, tools: [], returnBytes: 1024 },
    )
    expect(r.ok).toBe(true)
    expect(r.response?.truncated).toBe(true)
  }, 60_000)

  it('程序抛错时返回结构化失败而不是崩溃', async () => {
    const root = makeRepo()
    const r = await runCodeProgram(
      { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 15_000, memoryMb: 256 },
      { program: 'throw new Error("boom")', root, tools: [] },
    )
    expect(r.ok).toBe(true)
    expect(r.response?.ok).toBe(false)
    expect(r.response?.error?.message).toContain('boom')
  }, 60_000)
})
