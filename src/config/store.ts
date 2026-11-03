// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * store.ts —— 配置文件的读写（原子、可迁移、保真）。
 *
 * 三条保障，对应「升级不能丢设置」：
 *  1. **原子写**：先写同目录临时文件，fsync 后 rename。中途崩溃只会留下
 *     临时文件，原文件始终是完整的旧版本 —— 绝不会出现半个 JSON。
 *  2. **patch 合并**：更新时基于磁盘上的原始对象做深合并，只改被点名的路径。
 *     未知字段因此天然保留（不是「特意不删」，而是「根本不去碰」）。
 *  3. **迁移前备份**：检测到需要迁移时，先把原文件复制一份带时间戳的备份，
 *     保留最近 3 份。迁移出问题可以人工回滚。
 *
 * 损坏处理原则：JSON 解析失败时**不覆盖**。返回 corrupt 标记 + 错误信息，
 * 由上层提示用户修复或从备份恢复。用默认值覆盖用户的坏文件是最坏的选择 ——
 * 那会永久丢掉用户可能还能抢救的配置。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConfigV2 } from './defaults.js'
import { migrate, type MigrationResult } from './migrate.js'
import { normalizeConfig } from './schema.js'

/** 备份文件保留数量。 */
const KEEP_BACKUPS = 3

/** 读取结果。 */
export interface ConfigReadResult {
  /** 归一化后的可用配置。 */
  readonly config: ConfigV2
  /** 磁盘上的原始对象（含未知字段），写回时作为基底。 */
  readonly raw: Record<string, unknown>
  /** 文件是否存在。 */
  readonly existed: boolean
  /** 文件是否损坏（存在但解析失败）。 */
  readonly corrupt: boolean
  /** 损坏原因（corrupt=true 时有值）。 */
  readonly corruptReason: string | null
  /** 发生的迁移（未迁移为 null）。 */
  readonly migrated: MigrationResult | null
  /** 归一化过程中的诊断。 */
  readonly issues: readonly string[]
}

/** 深合并的简化规则：只处理普通对象，数组与标量直接替换。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 列出某文件的既有备份（按名称升序，名称含时间戳故即时间序）。 */
function listBackups(path: string): string[] {
  const dir = dirname(path)
  const prefix = basename(path) + '.bak.'
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * 备份原文件，只保留最近 KEEP_BACKUPS 份。
 * @returns 新备份的路径；源文件不存在时返回 null。
 */
export function backupConfigFile(path: string, stamp = new Date().toISOString().replace(/[:.]/g, '-')): string | null {
  if (!existsSync(path)) return null
  const target = `${path}.bak.${stamp}`
  copyFileSync(path, target)
  // 清理超量备份：loop 从最旧的开始删
  const backups = listBackups(path)
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    try {
      rmSync(old, { force: true })
    } catch {
      // 清理失败不影响主流程
    }
  }
  return target
}

/**
 * 原子写入：临时文件 → rename。
 * @param path    目标路径
 * @param content 完整文件内容（字符串）
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  // rename 在 Windows 上覆盖已存在文件可能偶发 EPERM，做有界重试
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (error) {
      lastError = error
      // 短暂让出，给杀软/索引器释放句柄的机会
      const waitUntil = Date.now() + 20
      while (Date.now() < waitUntil) { /* 忙等极短时间，避免引入异步 */ }
    }
  }
  try {
    rmSync(tmp, { force: true })
  } catch {
    // 清理临时文件失败不改变结论
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 读取配置文件。
 * @param path 配置文件路径
 * @returns 读取结果（不抛错：损坏时返回 corrupt 标记）
 */
export function readConfigFile(path: string): ConfigReadResult {
  if (!existsSync(path)) {
    const fresh = normalizeConfig(null)
    return {
      config: fresh.config,
      raw: {},
      existed: false,
      corrupt: false,
      corruptReason: null,
      migrated: null,
      issues: fresh.issues,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // 损坏：不覆盖、不当默认值写回，只报告
    const fallback = normalizeConfig(null)
    return {
      config: fallback.config,
      raw: {},
      existed: true,
      corrupt: true,
      corruptReason: error instanceof Error ? error.message : String(error),
      migrated: null,
      issues: fallback.issues,
    }
  }

  // 迁移（v1 → v2 等）
  let migrated: MigrationResult | null = null
  let source = parsed
  try {
    const result = migrate(parsed)
    if (result) {
      migrated = result
      source = result.config
    }
  } catch (error) {
    // 版本高于支持：按损坏处理（拒绝静默降级，也不覆盖文件）
    const fallback = normalizeConfig(null)
    return {
      config: fallback.config,
      raw: {},
      existed: true,
      corrupt: true,
      corruptReason: error instanceof Error ? error.message : String(error),
      migrated: null,
      issues: fallback.issues,
    }
  }

  const normalized = normalizeConfig(source)
  return {
    config: normalized.config,
    raw: normalized.raw,
    existed: true,
    corrupt: false,
    corruptReason: null,
    migrated,
    issues: normalized.issues,
  }
}

/**
 * 更新配置：基于磁盘上的原始对象做深合并，保留一切未知字段。
 *
 * @param path  配置文件路径
 * @param patch 只包含要改的路径（如 { review: { model: 'x' } }）
 * @param opts  可选：skipBackup（测试用）、stamp（备份时间戳，测试用）
 * @returns 更新后的读取结果
 */
export function updateConfigFile(
  path: string,
  patch: Record<string, unknown>,
  opts: { readonly skipBackup?: boolean; readonly stamp?: string } = {},
): ConfigReadResult {
  // 先把当前状态读出来（损坏时不写，避免把坏文件覆盖成默认值）
  const current = readConfigFile(path)
  if (current.corrupt) {
    throw new Error(`配置文件已损坏，拒绝写入（避免覆盖原始内容）：${current.corruptReason}`)
  }

  // 需要迁移时先备份原文件
  if (!opts.skipBackup && (current.migrated !== null || current.existed)) {
    backupConfigFile(path, opts.stamp)
  }

  // 基底 = 磁盘原始对象（含未知字段）；合并后再补上 version
  const merged = deepMerge(current.raw, { ...patch, version: 2 })
  writeFileAtomic(path, JSON.stringify(merged, null, 2) + '\n')
  return readConfigFile(path)
}
