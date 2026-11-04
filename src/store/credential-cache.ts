// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * credential-cache.ts —— 凭据在内核与插件之间的唯一传递通道。
 *
 * 为什么需要一个文件，而不是环境变量：
 *   内核是**独立于 DSH 的常驻进程**，它的环境变量在 spawn 那一刻就固定了。
 *   如果只在拉起时注入，用户改一次 key 就必须重启整个 DSH；而内核本身可能
 *   已经跑了好几天。用一个小文件，内核每次任务前现读，改完立即生效。
 *
 * 安全边界（与 DSH 自己的做法对齐，已实机比对过 ACL）：
 *   - 位置：<dshRoot>/dsh-code-review/kernel/credentials.json
 *     就在 ~/.dsh 之下，与 DSH 自己的 ~/.dsh/.credentials.yaml 同一个目录树；
 *   - 保护级别：实测两者 ACL 完全一致（SYSTEM / Administrators / 当前用户）。
 *     写入时仍显式请求 0o600 —— 在 POSIX 上生效，在 Windows 上 Node 会忽略它，
 *     真正的保护来自用户目录的 ACL 继承。**不要以为设了 mode 就安全了。**
 *
 * 这个文件**不是**配置真源。配置在 profile 里，这里只是内核够得着的一份副本。
 */

import { readFileSync } from 'node:fs'
import { credentialCachePath } from './paths.js'
import { readJsonOrNull, writeTextAtomic } from './atomic.js'
import type { ConfigV2 } from '../config/defaults.js'

/** 缓存文件的结构（版本号用于将来格式变更时识别）。 */
export interface CredentialCacheFile {
  readonly version: 1
  /** 最近一次更新时间（ISO-8601，仅供排查）。 */
  readonly updatedAt: string
  /** 引用名 → 值。键必须符合 DSH 的引用语法。 */
  readonly refs: Record<string, string>
}

/** 凭据引用名的语法（与 DSH 的 REF_PATTERN 保持一致）。 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 判断一个引用名是否合法。
 *
 * DSH 的语法是 POSIX shell 标识符：字母或下划线开头，只含字母数字下划线。
 * **短横线不合法** —— 写成 command-code-api 时 DSH 会拒绝，而我们在本地也要
 * 提前拦下来并给出可操作的提示，而不是让内核在第一次请求时才失败。
 * @param ref 候选引用名
 */
export function isValidCredentialRef(ref: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(ref.trim())
}

/**
 * 读取缓存里的某一条凭据。
 * @param dshRoot DSH 数据根
 * @param ref     引用名
 * @returns 值；文件不存在、解析失败或没有该引用时返回 null（不抛错）
 */
export function readCachedCredential(dshRoot: string, ref: string): string | null {
  const file = readJsonOrNull<CredentialCacheFile>(credentialCachePath(dshRoot))
  if (file === null || typeof file.refs !== 'object' || file.refs === null) return null
  const value = file.refs[ref]
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim()
}

/**
 * 写入（合并）一条凭据。
 *
 * 合并而不是覆盖：一个内核可能同时服务多个不同引用的任务，覆盖会让排在
 * 后面的任务突然解析不到自己那条。旧的引用会保留，这对凭据文件是可接受的
 * ——它和 DSH 自己的凭据文件一样，是「按引用名索引的仓库」。
 * @param dshRoot DSH 数据根
 * @param ref     引用名
 * @param value   值
 */
export function writeCachedCredential(dshRoot: string, ref: string, value: string): void {
  const existing = readJsonOrNull<CredentialCacheFile>(credentialCachePath(dshRoot))
  const refs: Record<string, string> = {}
  if (existing !== null && typeof existing.refs === 'object' && existing.refs !== null) {
    for (const [key, v] of Object.entries(existing.refs)) {
      if (typeof v === 'string' && v !== '') refs[key] = v
    }
  }
  refs[ref.trim()] = value
  const payload: CredentialCacheFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    refs,
  }
  // POSIX 上 0600 生效；Windows 上 Node 忽略 mode，保护来自目录 ACL 继承。
  writeTextAtomic(credentialCachePath(dshRoot), JSON.stringify(payload, null, 2) + '\n', 0o600)
}

/** 供诊断使用：缓存里有哪些引用名（**不返回任何值**）。 */
export function listCachedCredentialRefs(dshRoot: string): string[] {
  try {
    const file = JSON.parse(readFileSync(credentialCachePath(dshRoot), 'utf8')) as CredentialCacheFile
    return Object.keys(file.refs ?? {})
  } catch {
    return []
  }
}

/** 供类型引用（避免未使用告警）。 */
export type { ConfigV2 }
