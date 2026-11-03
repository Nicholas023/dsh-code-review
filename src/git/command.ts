// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * command.ts —— 受限的 Git 子进程执行器。
 *
 * 安全与稳定性的三条底线：
 *  1. **参数数组，不拼 shell 字符串**：任何来自用户/配置的值都当独立 argv 传递，
 *     从根本上消除命令注入（路径里带空格、引号、分号都不会被解释）。
 *  2. **输出有上限**：大仓库的 git 输出可能几百 MB，全读进内存会拖垮内核。
 *     超过上限即截断并标记，由调用方决定是否视为失败。
 *  3. **超时与隐藏窗口**：Windows 上 GUI 进程 spawn 控制台程序会闪黑窗；
 *     同时 git 卡住（如网络文件系统）必须有硬超时。
 */

import { spawn } from 'node:child_process'

/** 单次 git 调用的默认超时。 */
export const GIT_TIMEOUT_MS = 60_000

/** 单次 git 调用的stdout/stderr 各自字节上限（默认 32 MB）。 */
export const GIT_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024

/** 一次 git 调用的结果。 */
export interface GitResult {
  /** 是否成功（退出码 0 且未超时/未超限）。 */
  readonly ok: boolean
  /** 退出码；超时或 spawn 失败时为 null。 */
  readonly code: number | null
  /** 标准输出。 */
  readonly stdout: string
  /** 标准错误。 */
  readonly stderr: string
  /** 是否因超时被终止。 */
  readonly timedOut: boolean
  /** 输出是否被截断（超过上限）。 */
  readonly truncated: boolean
}

/** 调用选项。 */
export interface GitRunOptions {
  /** 工作目录（默认仓库根）。 */
  readonly cwd?: string
  /** 超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 允许的退出码集合（默认 [0]）。git diff 用 --exit-code 时会返回 1。 */
  readonly okCodes?: readonly number[]
  /** 额外的环境变量（合并进 process.env）。 */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 执行一次 git 命令（异步）。
 *
 * @param repoPath 仓库路径（同时作为默认工作目录）
 * @param args     git 子命令与参数（**不允许**包含 shell 元字符拼接，直接数组传参）
 * @param opts     选项
 */
export function runGit(repoPath: string, args: readonly string[], opts: GitRunOptions = {}): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS
  const okCodes = opts.okCodes ?? [0]
  const limit = GIT_OUTPUT_LIMIT_BYTES

  return new Promise<GitResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false

    const child = spawn('git', ['-C', repoPath, ...args], {
      cwd: opts.cwd ?? repoPath,
      // Windows 上避免弹出控制台窗口；其他平台忽略该选项
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    /** 统一收尾：保证 resolve 只发生一次。 */
    const finish = (result: GitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // 硬超时：先礼后兵（SIGTERM 在 Windows 上等同于强制终止）
    const timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill()
      } catch {
        // 进程可能已退出
      }
      finish({ ok: false, code: null, stdout, stderr, timedOut: true, truncated })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > limit) {
        truncated = true
        // 截断后停止累积，但仍继续消费流，避免子进程阻塞在写管道
        const room = limit - stdout.length
        if (room > 0) stdout += chunk.subarray(0, room).toString('utf8')
        return
      }
      stdout += chunk.toString('utf8')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length > limit) {
        const room = limit - stderr.length
        if (room > 0) stderr += chunk.subarray(0, room).toString('utf8')
        return
      }
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      // spawn 本身失败（git 不存在、权限不足等）
      finish({ ok: false, code: null, stdout, stderr: stderr + String(error.message), timedOut: false, truncated })
    })

    child.on('close', (code) => {
      const ok = code !== null && okCodes.includes(code) && !truncated
      finish({ ok, code, stdout, stderr, timedOut: false, truncated })
    })
  })
}

/**
 * 校验某路径确实是 Git 仓库根，并返回规范化后的根路径。
 * @returns 仓库根绝对路径；不是仓库时返回 null。
 */
export async function resolveRepoRoot(repoPath: string): Promise<string | null> {
  const r = await runGit(repoPath, ['rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
  if (!r.ok) return null
  const root = r.stdout.trim()
  return root === '' ? null : root
}

/**
 * 判断路径是否位于仓库根之内（防越界读取）。
 * 用规范化前缀比较，避免 /a/bc 被误判为 /a/b 的子路径。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const r = norm(root)
  const t = norm(target)
  if (t === r) return true
  return t.startsWith(r + '/')
}
