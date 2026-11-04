// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * paths.ts —— 插件数据目录布局的唯一真源。
 *
 * 为什么集中：0.1.x 里 homedir()/.dsh 硬编码散落多处，导致自定义
 * DSH_HOME 的用户全部解析失败（那是 issue #13）。这里统一：
 *  - 优先 DSH_HOME 环境变量（DSH 支持自定义数据根）；
 *  - 否则回退 ~/.dsh；
 *  - 所有子路径都从根派生，不各自拼接。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 解析 DSH 数据根目录。 */
export function resolveDshRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 插件数据根：<dshRoot>/dsh-code-review。 */
export function pluginRoot(dshRoot: string = resolveDshRoot()): string {
  return join(dshRoot, 'dsh-code-review')
}

/** 配置文件路径。 */
export function configFilePath(dshRoot?: string): string {
  return join(pluginRoot(dshRoot), 'config.json')
}

/** 0.1.x 的旧配置文件路径（迁移源）。 */
export function legacyConfigFilePath(dshRoot?: string): string {
  return join(pluginRoot(dshRoot), 'plugin-config.json')
}

/** 任务簿目录。 */
export function tasksDir(dshRoot?: string): string {
  return join(pluginRoot(dshRoot), 'tasks')
}

/** 单个任务卡路径（id 只允许安全字符，防路径穿越）。 */
export function taskPath(taskId: string, dshRoot?: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(tasksDir(dshRoot), safe + '.json')
}

/** 内核运行时目录（pid/心跳/锁）。 */
export function kernelDir(dshRoot?: string): string {
  return join(pluginRoot(dshRoot), 'kernel')
}

/** 内核 info 文件（pid + nonce + 启动时间）。 */
export function kernelInfoPath(dshRoot?: string): string {
  return join(kernelDir(dshRoot), 'info.json')
}

/**
 * 内核凭据缓存。
 *
 * 为什么需要这个文件：DSH 把凭据存在自己的凭据库里（.credentials.yaml），
 * 由宿主进程通过 ctx.credentials 提供 —— 内核是**独立进程**，拿不到那个服务，
 * 也拿不到任何环境变量以外的形式。插件在提交时解析出值写在这里，内核读它。
 *
 * 位置在 kernel/ 下、权限 0600：与 DSH 自己的凭据文件同目录同保护级别。
 */
export function credentialCachePath(dshRoot?: string): string {
  return join(kernelDir(dshRoot), 'credentials.json')
}

/** 单例锁文件。 */
export function kernelLockPath(dshRoot?: string): string {
  return join(kernelDir(dshRoot), 'kernel.lock')
}

/** 任务产物目录（子任务结果、日志）。 */
export function artifactsDir(taskId: string, dshRoot?: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(pluginRoot(dshRoot), 'artifacts', safe)
}
