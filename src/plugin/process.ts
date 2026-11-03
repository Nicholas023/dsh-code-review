// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * process.ts —— 内核进程的拉起与探活（插件侧）。
 *
 * 设计要点：
 *  - **detached + unref**：内核必须独立于 DSH 会话存活，插件退出/重载不影响它；
 *  - **单例由内核自己保证**（锁文件），插件这边只做「活着就不拉、死了才拉」；
 *  - 拉起失败不抛错，只返回原因 —— 任务卡已经写好了，下次轮询还会再试。
 */

import { spawn } from 'node:child_process'
import { isKernelAlive } from '../kernel/serve.js'

/** 拉起结果。 */
export interface EnsureKernelResult {
  /** 是否已有一个存活内核（无论本次是否新拉起）。 */
  readonly alive: boolean
  /** 本次是否新拉起了进程。 */
  readonly started: boolean
  /** 拉起失败原因（started=false 且 alive=false 时有值）。 */
  readonly reason: string | null
}

/**
 * 确保内核在跑。
 * @param opts.nodePath    node 可执行文件
 * @param opts.entryPath   内核入口脚本（dist/kernel/main.js）
 * @param opts.dshRoot     DSH 数据根
 */
export function ensureKernel(opts: {
  readonly nodePath: string
  readonly entryPath: string
  readonly dshRoot: string;
}): EnsureKernelResult {
  if (isKernelAlive(opts.dshRoot)) {
    return { alive: true, started: false, reason: null }
  }
  try {
    const child = spawn(
      opts.nodePath,
      [opts.entryPath, '--dsh-root', opts.dshRoot],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    child.unref()
    return { alive: true, started: true, reason: null }
  } catch (error) {
    return {
      alive: false,
      started: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
