// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * writer.ts —— 报告落盘（Markdown + JSON 双写，原子）。
 *
 * 写入顺序与失败语义：
 *   1. 先写 JSON（机器可读，是后续聚合的权威来源）
 *   2. 再写 Markdown（人读的呈现）
 *   任何一份失败，结果里都要能看出来是哪一份缺了 ——
 *   不允许「报告写了一半却报成功」。
 *
 * 路径安全：report 目录必须落在用户 home 之下。理由与 0.1.3 一致：
 * 插件自动写入的路径不应能被配置导向任意位置（issue #23 的教训）。
 */

import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 写入选项。 */
export interface WriteReportOptions {
  /** 报告根目录（支持 ~ 前缀）。 */
  readonly directory: string
  /** 仓库名（用于分子目录）。 */
  readonly repoName: string
  /** 时间戳文件名（不含扩展名）。 */
  readonly baseName: string
  /** Markdown 内容（null 表示不写）。 */
  readonly markdown: string | null
  /** JSON 内容（null 表示不写）。 */
  readonly json: string | null
}

/** 写入结果。 */
export interface WriteReportResult {
  readonly markdownPath: string | null
  readonly jsonPath: string | null
  readonly errors: readonly string[]
}

/** 展开 ~ 前缀。 */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * 校验报告目录安全：必须是绝对路径，且（展开后）位于用户 home 之下。
 * @returns null 表示通过，否则返回拒绝原因。
 */
export function validateReportDir(p: string): string | null {
  const expanded = expandHome(p)
  if (!isAbsolute(expanded)) return '报告目录必须是绝对路径（或 ~ 开头）'
  const target = resolve(expanded)
  const home = resolve(homedir())
  // 用大小写不敏感比较适配 Windows
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const t = norm(target)
  const h = norm(home)
  if (t !== h && !t.startsWith(h + '/')) {
    return '报告目录必须位于用户主目录之下（防止被配置导向任意位置）'
  }
  return null
}

/** 原子写单个文件：临时文件 → rename，失败时退化为「删除后改名」。 */
function writeAtomic(path: string, content: string): void {
  const tmp = path + '.tmp.' + String(process.pid) + '.' + String(Date.now())
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    // Windows 上 rename 覆盖已存在文件偶发失败
    try { rmSync(path, { force: true }) } catch { /* 文件不存在 */ }
    renameSync(tmp, path)
  }
}

/**
 * 写一份报告。
 */
export function writeReport(opts: WriteReportOptions): WriteReportResult {
  const errors: string[] = []
  const invalid = validateReportDir(opts.directory)
  if (invalid !== null) {
    return { markdownPath: null, jsonPath: null, errors: [invalid] }
  }

  const root = resolve(expandHome(opts.directory))
  const safeRepo = opts.repoName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'repo'
  const dir = join(root, safeRepo)

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { markdownPath: null, jsonPath: null, errors: ['无法创建报告目录：' + (error instanceof Error ? error.message : String(error))] }
  }

  let jsonPath: string | null = null
  let markdownPath: string | null = null

  if (opts.json !== null) {
    const p = join(dir, opts.baseName + '.json')
    try {
      writeAtomic(p, opts.json)
      jsonPath = p
    } catch (error) {
      errors.push('JSON 报告写入失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  if (opts.markdown !== null) {
    const p = join(dir, opts.baseName + '.md')
    try {
      writeAtomic(p, opts.markdown)
      markdownPath = p
    } catch (error) {
      errors.push('Markdown 报告写入失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  return { markdownPath, jsonPath, errors }
}

/** 判断目录是否存在（供测试与诊断）。 */
export function dirExists(p: string): boolean {
  try {
    return existsSync(realpathSync(p))
  } catch {
    return false
  }
}
