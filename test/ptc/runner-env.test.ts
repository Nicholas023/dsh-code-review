// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * runner-env.test.ts —— runner 子进程的环境隔离。
 *
 * 这条比多数测试更要紧：如果 runner 继承了内核的环境变量，
 * 模型写出的程序可以直接把 API key 读出来，再「顺便」打印进结果，
 * 最后落进报告文件。那不是理论风险，是一次 `process.env` 就够。
 *
 * 两层验证：
 *  1. 白名单函数本身不返回任何形似凭据的变量；
 *  2. 真起一个子进程，确认它在受限环境里跑。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCodeProgram, runnerEnv } from '../../src/ptc/runner-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const ENTRY = join(ROOT, 'dist', 'ptc', 'runner-entry.js')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

beforeAll(() => {
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' })
}, 120_000)

describe('环境变量白名单', () => {
  it('不包含任何形似凭据的变量', () => {
    const env = runnerEnv()
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i)
    }
  })

  it('不含测试注入的敏感变量（即使父进程里有）', () => {
    const original = process.env.DCR_TEST_SECRET
    process.env.DCR_TEST_SECRET = 'sk-should-not-leak'
    try {
      const env = runnerEnv()
      expect(env.DCR_TEST_SECRET).toBeUndefined()
      // 整个环境里不该出现这个值
      expect(Object.values(env)).not.toContain('sk-should-not-leak')
    } finally {
      if (original === undefined) delete process.env.DCR_TEST_SECRET
      else process.env.DCR_TEST_SECRET = original
    }
  })

  it('保留运行 Node 所需的基础变量', () => {
    const env = runnerEnv()
    // PATH 与系统根目录是 Node 启动与 DLL 解析需要的
    const hasPath = typeof env.PATH === 'string' || typeof env.Path === 'string'
    expect(hasPath).toBe(true)
  })
})

describe('真实子进程隔离', () => {
  it('程序拿不到父进程的敏感环境变量', async () => {
    expect(existsSync(ENTRY)).toBe(true)
    const original = process.env.DCR_TEST_SECRET
    process.env.DCR_TEST_SECRET = 'sk-should-not-leak'
    try {
      // 程序尝试从 process.env 读（沙箱里 process 应不存在），
      // 退而求其次通过全局对象探测
      const program = [
        'const probe = typeof process === "object" && process !== null && process.env',
        'return { hasProcess: typeof process, secret: probe && probe.DCR_TEST_SECRET ? String(probe.DCR_TEST_SECRET) : null }',
      ].join('\n')
      const r = await runCodeProgram(
        { nodePath: process.execPath, entryPath: ENTRY, timeoutMs: 15_000, memoryMb: 256 },
        { program, root: ROOT, tools: [] },
      )
      expect(r.ok).toBe(true)
      const value = r.response?.value as { hasProcess: string; secret: string | null }
      // 沙箱里没有 process
      expect(value.hasProcess).toBe('undefined')
      // 就算将来 sandbox 松了口子，也不该读到密钥
      expect(value.secret).toBeNull()
    } finally {
      if (original === undefined) delete process.env.DCR_TEST_SECRET
      else process.env.DCR_TEST_SECRET = original
    }
  }, 60_000)
})
