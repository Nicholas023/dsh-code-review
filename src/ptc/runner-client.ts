// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * runner-client.ts —— 父进程侧：spawn 并监督 run_code 子进程。
 *
 * 职责边界：内核只负责「把程序递过去、拿回结果、超时就杀」。
 * 安全边界都在子进程内部（路径围栏 / 只读 SDK / 返回值预算）；
 * 这里加的是进程级兜底：硬超时、内存上限、输出上限、崩溃归一。
 *
 * 为什么超时只能在这里做：子进程内的 vm timeout 管不到 async 代码，
 * 模型可以 await 一个永不 resolve 的 Promise 把 runner 挂住。
 * 只有父进程的定时器 + 进程终止是可靠的。
 */

import { spawn } from 'node:child_process'
import type { RunnerRequest, RunnerResponse } from './runner-entry.js'

/** 运行选项。 */
export interface RunnerOptions {
  /** node 可执行文件绝对路径。 */
  readonly nodePath: string
  /** runner-entry.js 的绝对路径。 */
  readonly entryPath: string
  /** 硬超时（毫秒）。 */
  readonly timeoutMs: number
  /** V8 堆上限（MB）。 */
  readonly memoryMb: number
}

/** 运行结果。 */
export interface RunnerResult {
  readonly ok: boolean
  readonly response?: RunnerResponse
  readonly failure?: {
    readonly code:
      | 'RUNTIME_RUNNER_TIMEOUT'
      | 'RUNTIME_RUNNER_CRASHED'
      | 'RUNTIME_RUNNER_PROTOCOL_ERROR'
      | 'RUNTIME_RUNNER_OUTPUT_LIMIT'
      | 'RUNTIME_RUNNER_MEMORY_EXCEEDED'
    readonly message: string
  }
  readonly elapsedMs: number
}


/**
 * runner 子进程允许看到的环境变量白名单。
 *
 * 为什么必须显式给 env：Node 的 spawn 默认**继承父进程全部环境变量**。
 * 内核进程为了调 LLM 会持有 API key，如果原样继承，模型写的那段程序
 * 只要执行 `process.env.X` 就能把 key 读出来 —— 而它还可能在结果里
 * 把它打印回上下文，最后进报告。
 *
 * 白名单只留「跑一个 Node 进程所必需」的变量：定位系统 DLL、临时目录、编码。
 * 任何形似凭据的变量都不在其中。
 */
const RUNNER_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'NODE_OPTIONS',
  // Electron 以 Node 模式运行的开关：内核可能由 Harness.exe 启动，
  // runner 也要沿用同一条规则（对真 node.exe 无害）
  'ELECTRON_RUN_AS_NODE',
]

/** 从父进程环境里挑出白名单变量（导出供测试验证隔离效果）。 */
export function runnerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of RUNNER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** stdout 上限：防止程序往 stdout 灌数据撑爆父进程内存。 */
const STDOUT_LIMIT = 4 * 1024 * 1024

/**
 * 执行一次 run_code。
 * @param opts    运行选项
 * @param request 请求体
 */
export function runCodeProgram(opts: RunnerOptions, request: RunnerRequest): Promise<RunnerResult> {
  const startedAt = Date.now()
  return new Promise<RunnerResult>((resolve) => {
    let settled = false

    const finish = (r: RunnerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    const child = spawn(
      opts.nodePath,
      ['--max-old-space-size=' + String(opts.memoryMb), opts.entryPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // 只给最小环境：绝不让模型代码看到内核持有的凭据
        env: runnerEnv(),
      },
    )

    let stdout = ''
    let stderr = ''
    let outputExceeded = false

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish({
        ok: false,
        failure: {
          code: 'RUNTIME_RUNNER_TIMEOUT',
          message: 'run_code 超过 ' + String(opts.timeoutMs) + 'ms，已终止',
        },
        elapsedMs: Date.now() - startedAt,
      })
    }, opts.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > STDOUT_LIMIT) {
        outputExceeded = true
        try { child.kill() } catch { /* 已退出 */ }
        return
      }
      stdout += chunk.toString('utf8')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      finish({
        ok: false,
        failure: { code: 'RUNTIME_RUNNER_CRASHED', message: String(error.message) },
        elapsedMs: Date.now() - startedAt,
      })
    })

    child.on('close', (code) => {
      const elapsedMs = Date.now() - startedAt
      if (outputExceeded) {
        finish({
          ok: false,
          failure: {
            code: 'RUNTIME_RUNNER_OUTPUT_LIMIT',
            message: '程序输出超过 ' + String(STDOUT_LIMIT) + ' 字节',
          },
          elapsedMs,
        })
        return
      }
      if (code !== 0) {
        const oom = /heap out of memory|Allocation failed/i.test(stderr)
        finish({
          ok: false,
          failure: oom
            ? { code: 'RUNTIME_RUNNER_MEMORY_EXCEEDED', message: '内存超限（' + String(opts.memoryMb) + 'MB）' }
            : { code: 'RUNTIME_RUNNER_CRASHED', message: '退出码 ' + String(code) + '：' + stderr.slice(0, 500) },
          elapsedMs,
        })
        return
      }
      // 正常退出：取最后一个非空行解析
      const lines = stdout.trim().split('\n').filter((l) => l.trim() !== '')
      const last = lines.length > 0 ? lines[lines.length - 1] : ''
      try {
        const parsed = JSON.parse(last ?? '') as RunnerResponse
        finish({ ok: true, response: parsed, elapsedMs })
      } catch {
        finish({
          ok: false,
          failure: {
            code: 'RUNTIME_RUNNER_PROTOCOL_ERROR',
            message: 'runner 输出不是合法 JSON：' + stdout.slice(0, 300),
          },
          elapsedMs,
        })
      }
    })

    // 写入请求后关闭 stdin（runner 读完全部再执行）
    try {
      child.stdin?.end(JSON.stringify(request))
    } catch (error) {
      finish({
        ok: false,
        failure: {
          code: 'RUNTIME_RUNNER_CRASHED',
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      })
    }
  })
}
