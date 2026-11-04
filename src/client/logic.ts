// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * logic.ts —— 设置面板的纯逻辑（无 React、无 DOM）。
 *
 * 设计取舍：
 *  1. **草稿态**：改动先留在本地，点「保存」才写回。原因不是体验，
 *     是正确性 —— 每个击键都 set 会在用户还没输完时反复写盘，
 *     中间态（比如只输入了 "https://api"）也会被当成有效配置落地。
 *  2. **分组来自 schema**：控件不是手写的，而是从 CONFIG_FIELDS 派生。
 *     加一个字段只需要改 schema，这里不用动。
 *  3. **只渲染标量**：object/array 字段跳过（当前没有这种可编辑字段）。
 *
 * 为什么单独成一个文件：这些函数是「面板行为」的真正来源（渲染只是呈现），
 * 而且它们能在没有 DOM 的环境里被测到。组件文件只负责把结果画出来。
 */

import { CONFIG_FIELDS } from '../settings/fields.js'
import type { SettingsPathOp } from './types.js'

/** 一个可编辑控件的描述（从 schema 派生）。 */
export interface Control {
  readonly path: string
  readonly section: string
  readonly label: string
  readonly hint: string
  readonly kind: 'string' | 'number' | 'boolean'
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
}

/** 字段名 → 人类可读标签（schema 里只有说明，标签在这里补）。 */
const LABELS: Record<string, string> = {
  'review.endpoint': '模型端点',
  'review.model': '模型',
  'review.protocol': '协议',
  'review.credentialRef': '凭据引用',
  'review.requestTimeoutMs': '单请求超时（毫秒）',
  'review.taskTimeoutMs': '任务超时（毫秒）',
  'execution.concurrencyEnabled': '允许并行任务',
  'execution.concurrency': '并行任务数',
  'execution.runnerTimeoutMs': '代码执行超时（毫秒）',
  'execution.runnerMemoryMb': '代码执行内存（MB）',
  'budget.maxInputTokens': '输入 token 上限',
  'budget.maxOutputTokens': '输出 token 上限',
  'budget.maxCost': '费用上限',
  'budget.currency': '费用单位',
  'budget.inputPricePerMTok': '输入单价（每百万 token）',
  'budget.outputPricePerMTok': '输出单价（每百万 token）',
  'budget.cacheReadPricePerMTok': '缓存命中单价（每百万 token）',
  'budget.maxAgentRounds': '主 agent 轮次',
  'budget.maxChildren': '子 agent 上限',
  'report.directory': '报告目录',
  'report.writeMarkdown': '输出 Markdown',
  'report.writeJson': '输出 JSON',
  'sizing.smallTokens': '小档上界',
  'sizing.largeTokens': '大档下界',
  'sizing.fileLinesForChild': '单文件行数阈值',
  'sizing.fileTokensForChild': '单文件 token 阈值',
  'sizing.childTokensMax': '子任务 token 上限',
}

/** 分区中文名。 */
export const SECTION_LABELS: Record<string, string> = {
  review: '评审模型',
  execution: '执行',
  budget: '预算（0 表示不限）',
  report: '报告',
  sizing: '规模阈值（决定主 agent 自己看多深）',
}

/** 分区顺序。 */
export const SECTION_ORDER = ['review', 'execution', 'budget', 'report', 'sizing']

/** 从 schema 派生控件列表（顺序稳定，便于渲染与测试）。 */
export function deriveControls(): Control[] {
  const out: Control[] = []
  for (const section of SECTION_ORDER) {
    const def = CONFIG_FIELDS[section]
    if (def === undefined || def.dict === undefined) continue
    for (const [name, field] of Object.entries(def.dict)) {
      // 只渲染可编辑标量：只读展示项与复合类型跳过
      if (field.meta?.volatile !== true) continue
      if (field.type !== 'string' && field.type !== 'number' && field.type !== 'boolean') continue
      const path = section + '.' + name
      out.push({
        path,
        section,
        label: LABELS[path] ?? name,
        hint: String(field.meta.description ?? ''),
        kind: field.type,
        ...(field.meta.minimum === undefined ? {} : { min: field.meta.minimum }),
        ...(field.meta.maximum === undefined ? {} : { max: field.meta.maximum }),
        ...(field.meta.enum === undefined ? {} : { options: field.meta.enum }),
      })
    }
  }
  return out
}

/** 从宿主值里按路径取字段。 */
export function valueAt(value: Record<string, unknown> | undefined, path: string): unknown {
  if (value === undefined) return undefined
  const dot = path.indexOf('.')
  const section = value[path.slice(0, dot)]
  if (typeof section !== 'object' || section === null) return undefined
  return (section as Record<string, unknown>)[path.slice(dot + 1)]
}

/** 把草稿值写回成 patch（section → { key: value }）。 */
export function draftToPatch(
  draft: Readonly<Record<string, unknown>>,
  baseline: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  const patch: Record<string, Record<string, unknown>> = {}
  for (const [path, value] of Object.entries(draft)) {
    // 只提交真正变过的字段，避免把没动的字段也写一遍
    if (valueAt(baseline, path) === value) continue
    const dot = path.indexOf('.')
    const section = path.slice(0, dot)
    patch[section] = { ...(patch[section] ?? {}), [path.slice(dot + 1)]: value }
  }
  return patch
}

/**
 * 把草稿 diff 成宿主的 op 数组（这是面板真正提交给宿主的东西）。
 *
 * 与 draftToPatch 的区别：那个产出的是给人看的 {section:{key:value}}，
 * 这个产出的是宿主 applyPathOp 认识的 {op,path,value}，且 path 必须是**分段数组**。
 * 只提交真正变过的字段 —— 否则会把用户没动过的字段也覆写一遍。
 * @param draft    当前草稿（扁平路径 → 值）
 * @param baseline 基线（宿主上一次给的值）
 */
export function draftToOps(
  draft: Readonly<Record<string, unknown>>,
  baseline: Record<string, unknown> | undefined,
): SettingsPathOp[] {
  const ops: SettingsPathOp[] = []
  for (const [path, value] of Object.entries(draft)) {
    if (valueAt(baseline, path) === value) continue
    const dot = path.indexOf('.')
    if (dot <= 0) continue
    ops.push({ op: 'set', path: [path.slice(0, dot), path.slice(dot + 1)], value })
  }
  return ops
}

/** 把宿主值拉平成草稿。 */
export function snapshotToDraft(
  value: Record<string, unknown> | undefined,
  controls: readonly Control[],
): Record<string, unknown> {
  const draft: Record<string, unknown> = {}
  for (const c of controls) {
    const v = valueAt(value, c.path)
    if (v !== undefined) draft[c.path] = v
  }
  return draft
}

