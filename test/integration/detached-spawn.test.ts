// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * detached-spawn.test.ts —— 阶段 0 的核心运行语义回归测试。
 *
 * 0.2.0 的前提是「评审内核独立于 DSH 会话存活」，本测试锁住这条链上
 * 最容易在 Windows 上踩坑的三件事：
 *  1. detached + unref + stdio:ignore 能真正把子进程放走；
 *  2. 子进程能被单独寻址（写 pid 文件 → 外部读到 → 确认存活）；
 *  3. 能被可靠终止，且终止后探测为「不存在」（不留残留）。
 *
 * 注意：这里不验证「父进程退出后存活」——测试进程自己就是父进程，
 * 无法观察自己的退出。该语义由 scripts/probe-parent.mjs 单独实证（本地留存）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/** 本测试创建的临时目录与子进程，统一在 afterEach 清理。 */
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    try {
      fn?.()
    } catch {
      // 清理失败不影响测试结论（进程可能已被 kill）
    }
  }
})

/** 轮询等待条件成立，超时返回 false。 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** 判断 pid 是否仍存活（发送信号 0 不产生实际副作用）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('detached 子进程语义', () => {
  it('放走的子进程可被单独寻址，且能可靠终止', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcr-detached-'))
    const pidFile = join(dir, 'pid.txt')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    // 子进程：写入自身 pid，然后空转 10 秒等待被终止
    const childCode =
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 10000)'

    const child = spawn(process.execPath, ['-e', childCode, pidFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()

    // ① 子进程确实写下了 pid（说明它真的跑起来了）
    const wrote = await waitFor(() => existsSync(pidFile))
    expect(wrote).toBe(true)

    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(Number.isInteger(pid)).toBe(true)
    expect(pid).toBeGreaterThan(0)

    // ② 子进程此刻存活
    expect(isAlive(pid)).toBe(true)
    cleanups.push(() => {
      try {
        process.kill(pid)
      } catch {
        // 已终止则忽略
      }
    })

    // ③ 可靠终止
    process.kill(pid)
    const died = await waitFor(() => !isAlive(pid))
    expect(died).toBe(true)
  }, 20_000)
})
