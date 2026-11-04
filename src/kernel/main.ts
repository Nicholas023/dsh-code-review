// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * main.ts —— 内核进程的 CLI 入口（被插件 spawn 出来的那个进程）。
 *
 * 用法：node dist/kernel/main.js [--dsh-root <path>] [--once]
 *
 * 为什么入口这么薄：真正的逻辑都在 serve() 里，便于单元测试；
 * 这里只做「解析参数 → 组装依赖 → 调用 → 处理信号」。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCachedCredential } from '../store/credential-cache.js'
import { resolveDshRoot } from '../store/paths.js'
import { serve } from './serve.js'
import type { ExecuteDeps } from './execute-task.js'

/** 从环境变量解析凭据（引用名即变量名）。 */
export function resolveCredentialFromEnv(ref: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = ref.trim()
  if (key === '') return null
  const value = env[key]
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim()
}

/**
 * 解析一个凭据引用。**先读插件写的缓存，再退回环境变量。**
 *
 * 为什么要缓存这一步：DSH 的凭据存在它自己的仓库里，由宿主进程通过
 * ctx.credentials 提供；本进程是独立进程，既没有那个服务，也不会从 DSH
 * 那里继承到任何环境变量。插件在提交时把解析结果写进
 * <dshRoot>/dsh-code-review/kernel/credentials.json（0600），这里现读，
 * 于是「改凭据立即生效」，不需要重启内核或 DSH。
 *
 * 顺序不能反过来：环境变量是用户的兜底手段（有人就习惯自己 export），
 * 但 DSH 里显式配置的凭据应当优先。
 * @param ref     引用名（来自任务卡里的配置快照）
 * @param opts.dshRoot DSH 数据根
 * @param opts.env     环境变量来源（测试可注入）
 */
export function resolveCredential(
  ref: string,
  opts: { readonly dshRoot: string; readonly env?: NodeJS.ProcessEnv },
): string | null {
  const key = ref.trim()
  if (key === '') return null
  const cached = readCachedCredential(opts.dshRoot, key)
  if (cached !== null) return cached
  return resolveCredentialFromEnv(key, opts.env ?? process.env)
}

/** 解析命令行参数。 */
export function parseArgs(argv: readonly string[]): { dshRoot: string | null; once: boolean } {
  let dshRoot: string | null = null
  let once = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dsh-root' && i + 1 < argv.length) {
      dshRoot = argv[i + 1] ?? null
      i += 1
      continue
    }
    if (a === '--once') { once = true }
  }
  return { dshRoot, once }
}

/** 组装执行依赖。 */
export function makeDeps(dshRoot: string): ExecuteDeps {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/kernel/main.js → dist/ptc/runner-entry.js
  const runnerEntry = join(resolve(here, '..'), 'ptc', 'runner-entry.js')
  return {
    resolveCredential: (ref: string) => resolveCredential(ref, { dshRoot }),
    nodePath: process.execPath,
    runnerEntry,
    now: () => new Date().toISOString(),
  }
}

/** 进程入口。 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dshRoot = args.dshRoot ?? resolveDshRoot()
  const deps = makeDeps(dshRoot)

  console.log('[codecheck] 内核启动 pid=' + String(process.pid) + ' root=' + dshRoot)
  const result = await serve({
    dshRoot,
    deps,
    ...(args.once ? { once: true } : {}),
    log: (line: string) => console.log(line),
  })
  console.log('[codecheck] 内核退出：' + result.reason + '，处理 ' + String(result.processed) + ' 个任务')
}

// 只在被直接执行时启动（被 import 时保持纯函数）
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.js')) {
  void main()
}
