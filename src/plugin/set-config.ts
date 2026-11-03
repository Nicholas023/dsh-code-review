// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * set-config.ts —— 程序化修改配置（工具入口）。
 *
 * 为什么需要：设置面板的客户端组件尚未实现，但用户不该被迫手改 JSON。
 * 这个工具让会话里的 AI 也能替用户改配置，走的是同一条路径：
 *   **字段级校验 → 只 patch 被点名的路径 → 保留未知字段**。
 *
 * 与 0.1.3 的差异：
 *  - 0.1.3 只支持三个字段（review_model / report_dir / engine_bin）；
 *  - 这里支持全部可编辑字段，但每个都要过同一份校验；
 *  - 被拒绝的字段**逐条回显原因**，不静默丢弃（issue #23 的教训）。
 */

import { readConfigFile, updateConfigFile } from '../config/store.js'
import { configFilePath } from '../store/paths.js'
import { CONFIG_FIELDS, type Field } from '../settings/schema.js'

/** 一次修改的结果。 */
export interface SetConfigResult {
  readonly ok: boolean
  /** 成功写入的字段（section.key）。 */
  readonly applied: readonly string[]
  /** 被拒绝的字段及原因。 */
  readonly rejected: ReadonlyArray<{ readonly field: string; readonly reason: string }>
  /** 修改后的有效值（仅 applied 的字段）。 */
  readonly effective: Readonly<Record<string, unknown>>
  /** 配置文件的版本与路径（供用户确认写到哪了）。 */
  readonly file: { readonly path: string; readonly version: number }
  /** 整体失败说明（如文件损坏无法写入）。 */
  readonly error: string | null
}

/** 找到字段描述。 */
function fieldOf(key: string): Field | null {
  const dot = key.indexOf('.')
  if (dot <= 0) return null
  const section = key.slice(0, dot)
  const name = key.slice(dot + 1)
  const sec = CONFIG_FIELDS[section]
  if (sec === undefined || sec.dict === undefined) return null
  return sec.dict[name] ?? null
}

/** 按字段描述校验并规范化一个值。 */
function coerce(field: Field, value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return { ok: false, reason: '应为字符串' }
      const opts = field.meta?.enum
      if (opts !== undefined && !opts.includes(value)) {
        return { ok: false, reason: '取值必须是 ' + opts.join(' / ') }
      }
      return { ok: true, value: value.trim() }
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, reason: '应为布尔值' }
      return { ok: true, value }
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: '应为有限数值' }
      const min = field.meta?.minimum
      const max = field.meta?.maximum
      let v = value
      if (min !== undefined && v < min) v = min
      if (max !== undefined && v > max) v = max
      return { ok: true, value: v }
    }
    default:
      return { ok: false, reason: '该字段暂不支持通过工具修改' }
  }
}

/**
 * 应用一次配置修改。
 * @param patch 形如 { 'review.model': 'deepseek-flash', 'budget.maxAgentRounds': 3 }
 */
export function applyConfigPatch(patch: Record<string, unknown>, dshRoot: string): SetConfigResult {
  const path = configFilePath(dshRoot)
  const applied: string[] = []
  const rejected: { field: string; reason: string }[] = []
  const effective: Record<string, unknown> = {}

  // 从「只含合法字段」的 patch 开始，逐个校验
  const clean: Record<string, Record<string, unknown>> = {}
  for (const [key, raw] of Object.entries(patch)) {
    const field = fieldOf(key)
    if (field === null) {
      rejected.push({ field: key, reason: '未知字段（可用字段见设置说明）' })
      continue
    }
    if (field.meta?.volatile !== true) {
      rejected.push({ field: key, reason: '该字段为只读展示项，不能修改' })
      continue
    }
    const checked = coerce(field, raw)
    if (!checked.ok) {
      rejected.push({ field: key, reason: checked.reason })
      continue
    }
    const dot = key.indexOf('.')
    const section = key.slice(0, dot)
    const name = key.slice(dot + 1)
    clean[section] = { ...(clean[section] ?? {}), [name]: checked.value }
    applied.push(key)
    effective[key] = checked.value
  }

  if (applied.length === 0) {
    return {
      ok: false,
      applied: [],
      rejected,
      effective: {},
      file: { path, version: 2 },
      error: rejected.length > 0 ? '没有任何字段被接受' : '补丁为空',
    }
  }

  try {
    const result = updateConfigFile(path, clean)
    return {
      ok: true,
      applied,
      rejected,
      effective,
      file: { path, version: (result.config as { version?: number }).version ?? 2 },
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      applied: [],
      rejected,
      effective: {},
      file: { path, version: 2 },
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读取当前配置里的可编辑字段值（供工具回显）。 */
export function currentEditableValues(dshRoot: string): Record<string, unknown> {
  const read = readConfigFile(configFilePath(dshRoot))
  const out: Record<string, unknown> = {}
  for (const [section, field] of Object.entries(CONFIG_FIELDS)) {
    if (field.dict === undefined) continue
    for (const [name, sub] of Object.entries(field.dict)) {
      if (sub.meta?.volatile !== true) continue
      const sec = (read.config as unknown as Record<string, Record<string, unknown>>)[section]
      if (sec !== undefined) out[section + '.' + name] = sec[name]
    }
  }
  return out
}

/** 渲染修改结果为可读文本。 */
export function presentSetConfigResult(result: SetConfigResult): string {
  const lines: string[] = []
  if (result.ok) {
    lines.push('✅ 配置已更新（' + String(result.applied.length) + ' 个字段）')
    lines.push('')
    for (const key of result.applied) lines.push('- ' + key + ' = ' + JSON.stringify(result.effective[key]))
  } else {
    lines.push('❌ 配置未更新' + (result.error === null ? '' : '：' + result.error))
  }
  if (result.rejected.length > 0) {
    lines.push('')
    lines.push('**被拒绝的字段**：')
    for (const r of result.rejected) lines.push('- ' + r.field + '：' + r.reason)
  }
  lines.push('')
  lines.push('配置文件：' + result.file.path + '（v' + String(result.file.version) + '）')
  return lines.join('\n')
}
