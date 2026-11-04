// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * atomic.ts —— 原子文件读写。
 *
 * 为什么必须原子：任务卡是插件与内核之间唯一共享的持久状态。
 * 如果内核写到一半崩溃，留下半个 JSON，插件读到就会解析失败，
 * 用户看到的是「任务不见了」。临时文件 + rename 保证：
 * 要么是旧内容，要么是新内容，永远不是半个。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 原子写入文本。
 * @param path    目标路径
 * @param content 内容
 * @param mode    可选的文件权限（如凭据缓存用 0o600）。临时文件就按该权限创建，
 *                rename 之后权限随文件走，不会出现「先宽后收」的窗口。
 */
export function writeTextAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp.' + String(process.pid) + '.' + String(Date.now())
  if (mode === undefined) writeFileSync(tmp, content, 'utf8')
  else writeFileSync(tmp, content, { encoding: 'utf8', mode })
  try {
    renameSync(tmp, path)
  } catch {
    // Windows：目标存在时 rename 可能失败，退化为「删了再改名」
    try { rmSync(path, { force: true }) } catch { /* 不存在 */ }
    renameSync(tmp, path)
  }
}

/** 原子写入 JSON（2 空格缩进，便于人读与 diff）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n')
}

/** 读取 JSON；文件不存在或损坏时返回 null（不抛错）。 */
export function readJsonOrNull<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
