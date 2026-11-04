// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * set-config.ts —— 程序化修改配置（工具入口）。
 *
 * 0.2.0 起，配置的**唯一真源**是宿主（DSH）自己：插件在入口导出 Config 描述，
 * 宿主把这一行的 config 存进 profile 的 cordis patch，并通过 Cordis 的
 * resolveConfig 校验后作为 apply 的第二个参数交回来。
 *
 * 所以这个文件不再碰任何文件系统：
 *   planConfigPatch()       —— 纯函数：字段级校验 + 算出「只含被点名路径」的补丁；
 *   writeConfigThroughHost() —— 把补丁交给宿主的 configEditor 落盘。
 *
 * 为什么必须走宿主（这条踩过）：
 *   如果这里仍然自己写一份 config.json，就会出现「面板改了 → 写 profile；
 *   工具改了 → 写 config.json；两边各说各话」的分叉。表现出来是
 *   「工具回报成功，评测还用老配置」，而且没有任何报错。
 *
 * 校验原则和 0.1.3 一致：
 *   - 未知字段、只读字段、类型不符**逐条拒绝并说明原因**（不静默丢弃）；
 *   - 数值越界**钳制**而不是报错（保留用户「想更大」的意图）；
 *   - 只提交被点名的路径，配置里其他内容由宿主原样保留。
 */

import { CONFIG_FIELDS, type Field } from '../settings/schema.js'

/** 一次修改的计划（纯数据，不落到任何地方）。 */
export interface ConfigPatchPlan {
  /** 是否至少有一个字段被接受。 */
  readonly ok: boolean
  /** 被接受的字段（section.key）。 */
  readonly applied: readonly string[]
  /** 被拒绝的字段及原因。 */
  readonly rejected: ReadonlyArray<{ readonly field: string; readonly reason: string }>
  /** 被接受字段的最终值（供回显）。 */
  readonly effective: Readonly<Record<string, unknown>>
  /** 只含被接受字段的嵌套补丁：section → { key: value }。 */
  readonly changes: Readonly<Record<string, Record<string, unknown>>>
  /** 整体失败说明（补丁为空 / 全被拒）。 */
  readonly error: string | null
}

/** 宿主 configEditor 的一行（只取我们用到的那部分形状）。 */
export interface ConfigEditorEntryLike {
  readonly options: { readonly id: string; readonly config?: unknown }
}

/**
 * 宿主配置编辑器的最小形状（services 里叫 configEditor）。
 * 形状来源：@deepseek-ai/dsh-config-editor（0.2.x），只取两个成员。
 */
export interface ConfigEditorLike {
  /** profile patch 的路径（回显给用户，不暴露宿主内部结构）。 */
  readonly documentPath: string
  entries(): readonly ConfigEditorEntryLike[]
  /**
   * 校验并落盘一次修改。
   * change(current, inherited) 返回**完整的下一份行配置**；宿主负责校验与重挂。
   */
  edit(
    entry: unknown,
    change: (
      current: Record<string, unknown> | undefined,
      inherited: Record<string, unknown> | undefined,
    ) => Record<string, unknown>,
  ): Promise<void>
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
 * 规划一次配置修改（纯函数，可测）。
 * @param patch 形如 { 'review.model': 'deepseek-flash', 'budget.maxAgentRounds': 3 }
 */
export function planConfigPatch(patch: Record<string, unknown>): ConfigPatchPlan {
  const applied: string[] = []
  const rejected: { field: string; reason: string }[] = []
  const effective: Record<string, unknown> = {}
  const changes: Record<string, Record<string, unknown>> = {}

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
    changes[section] = { ...(changes[section] ?? {}), [name]: checked.value }
    applied.push(key)
    effective[key] = checked.value
  }

  if (applied.length === 0) {
    return {
      ok: false,
      applied: [],
      rejected,
      effective: {},
      changes: {},
      error: rejected.length > 0 ? '没有任何字段被接受' : '补丁为空',
    }
  }

  return { ok: true, applied, rejected, effective, changes, error: null }
}

/** 判断一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把补丁合并进当前行配置。
 *
 * 只合并补丁里出现的 section 与字段；其余内容（含我们不认识的字段）原样保留 ——
 * 这是「用户可以顺手在 yaml 里写插件不认识的键」这条约定的实现。
 * @param current 宿主报告的当前行配置（可能为 undefined）
 * @param changes planConfigPatch 产出的补丁
 */
export function mergeConfigChanges(
  current: Record<string, unknown> | undefined,
  changes: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(current) ? { ...current } : {}
  for (const [section, fields] of Object.entries(changes)) {
    const before = next[section]
    next[section] = { ...(isRecord(before) ? before : {}), ...fields }
  }
  return next
}

/** 写入结果（含写到哪了）。 */
export interface ConfigWriteResult {
  readonly ok: boolean
  /** profile patch 的路径（只用于回显）。 */
  readonly path: string
  /** 失败说明。 */
  readonly error: string | null
}

/**
 * 通过宿主的 configEditor 落盘。
 * @param changes 补丁
 * @param editor  宿主的 configEditor 服务（缺失时不可调用）
 * @param entryId 本插件在组合树里的行 id
 */
export async function writeConfigThroughHost(
  changes: Readonly<Record<string, Record<string, unknown>>>,
  editor: ConfigEditorLike,
  entryId: string,
): Promise<ConfigWriteResult> {
  const path = editor.documentPath
  const entry = editor.entries().find((row) => row.options.id === entryId)
  if (entry === undefined) {
    return {
      ok: false,
      path,
      error: '找不到配置行 "' + entryId + '"：当前 profile 不可写，或本插件不是以 profile 行的形式装载的',
    }
  }
  try {
    await editor.edit(entry, (current) => mergeConfigChanges(current, changes))
    return { ok: true, path, error: null }
  } catch (error) {
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 读取当前配置里的可编辑字段值（供工具回显）。 */
export function currentEditableValues(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [section, field] of Object.entries(CONFIG_FIELDS)) {
    if (field.dict === undefined) continue
    const sec = config[section]
    for (const [name, sub] of Object.entries(field.dict)) {
      if (sub.meta?.volatile !== true) continue
      if (isRecord(sec)) out[section + '.' + name] = sec[name]
    }
  }
  return out
}

/** 渲染修改结果为可读文本。 */
export function presentSetConfigResult(plan: ConfigPatchPlan, write: ConfigWriteResult): string {
  const lines: string[] = []
  if (plan.ok && write.ok) {
    lines.push('✅ 配置已更新（' + String(plan.applied.length) + ' 个字段）')
    lines.push('')
    for (const key of plan.applied) lines.push('- ' + key + ' = ' + JSON.stringify(plan.effective[key]))
  } else {
    const reason = plan.error ?? write.error ?? '未知原因'
    lines.push('❌ 配置未更新：' + reason)
  }
  if (plan.rejected.length > 0) {
    lines.push('')
    lines.push('**被拒绝的字段**：')
    for (const r of plan.rejected) lines.push('- ' + r.field + '：' + r.reason)
  }
  lines.push('')
  lines.push('配置文件：' + write.path)
  return lines.join('\n')
}
