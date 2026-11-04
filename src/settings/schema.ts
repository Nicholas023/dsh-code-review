// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * schema.ts —— 设置描述的「宿主端」组装（第一层）。
 *
 * 字段本身的定义在 fields.ts（纯数据，浏览器端也要用）。
 * 这里只做三件事：
 *  1. 把字段树包成宿主可消费的形状（type/meta/dict）；
 *  2. 给**每个节点**挂上 toJSON()；
 *  3. 附上 Standard Schema 的 validate，让宿主用同一份描述做校验。
 *
 * 为什么 toJSON 是硬要求（这条踩过）：
 *   宿主 dsh-settings 认配置 schema 的判据是
 *     schema(entry) {
 *       const schema = entry.fiber?.runtime?.Config
 *       return schema !== void 0 && "toJSON" in schema ? schema : void 0
 *     }
 *   缺 toJSON 时它直接返回 undefined —— 该插件**不会出现在设置命名空间列表里**，
 *   插件页也就拿不到 form（读不到值、存不了盘），而且全程没有任何报错。
 *
 * 为什么 toJSON 必须返回**深拷贝**：
 *   dsh-settings 的 plainSchema() 会 new Schema(schema.toJSON()) 之后就地删掉
 *   volatile 元数据做校验副本。如果返回的是同一批对象，那份副本会把我们这份
 *   描述也一起改坏，第二次读取就变成「没有可编辑字段」。
 *
 * 为什么不直接用 schemastery：
 *   宿主会剥掉 volatile 元数据做校验副本，用自定义描述树能保证「描述」与
 *   「校验」永远来自同一份定义，且不引入额外运行时依赖。
 */

import type { ConfigV2 } from '../config/defaults.js'
import { normalizeConfig } from '../config/schema.js'
import { CONFIG_FIELDS, type Field, type FieldDict } from './fields.js'

export { CONFIG_FIELDS, editable, readonlyField } from './fields.js'
export type { Field, FieldDict, FieldType } from './fields.js'

/**
 * 宿主可消费的 schema 节点。
 *
 * 形状对齐 schemastery 的 toJSON 输出：{ type, meta, dict?, inner? }。
 * 宿主会用 new Schema(json) 把它重新水合成真 schema 来渲染表单。
 */
export interface SettingsSchemaNode {
  readonly type: string
  readonly meta: Record<string, unknown>
  readonly dict?: Record<string, SettingsSchemaNode>
  readonly inner?: SettingsSchemaNode
  /** 必须是深拷贝：见文件头的说明。 */
  toJSON(): SettingsSchemaNodeJson
}

/** toJSON 的产出：纯 JSON，不含任何函数。 */
export interface SettingsSchemaNodeJson {
  readonly type: string
  readonly meta: Record<string, unknown>
  readonly dict?: Record<string, SettingsSchemaNodeJson>
  readonly inner?: SettingsSchemaNodeJson
}

/** Standard Schema 校验结果。 */
type ValidateResult = { value: unknown } | { issues: { message: string }[] }

/** 带 Standard Schema 接口的完整设置描述。 */
export interface SettingsConfigSchema extends SettingsSchemaNode {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): ValidateResult
  }
}

/**
 * 把一份字段描述摊平成纯 JSON（不做任何缓存，每次都是新对象）。
 * @param node 字段描述节点
 */
function plain(node: Field | SettingsSchemaNode): SettingsSchemaNodeJson {
  const out: {
    type: string
    meta: Record<string, unknown>
    dict?: Record<string, SettingsSchemaNodeJson>
    inner?: SettingsSchemaNodeJson
  } = { type: node.type, meta: { ...(node.meta ?? {}) } }
  const withInner = node as { inner?: Field }
  const withDict = node as { dict?: FieldDict }
  if (withInner.inner !== undefined) out.inner = plain(withInner.inner)
  if (withDict.dict !== undefined) {
    const dict: Record<string, SettingsSchemaNodeJson> = {}
    for (const [key, child] of Object.entries(withDict.dict)) dict[key] = plain(child)
    out.dict = dict
  }
  return out
}

/**
 * 给一个节点挂上 toJSON。
 *
 * 用 defineProperty 设为**不可枚举**，这样：
 *  - JSON.stringify 仍然会调用它（它只看是不是函数）；
 *  - 但展开/遍历/深拷贝时不会把它当成数据字段，避免递归与脏字段。
 * @param node 待挂接的节点
 */
function withToJSON<T extends { type: string; meta?: Record<string, unknown> }>(node: T): T & SettingsSchemaNode {
  Object.defineProperty(node, 'toJSON', {
    value: () => plain(node as unknown as Field),
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return node as T & SettingsSchemaNode
}

/**
 * 递归地把一份字段描述包装成宿主节点。
 *
 * toJSON 必须挂到**每一个节点**上，不能只挂根节点 —— 宿主是逐层处理的：
 * volatileForm 会对每个叶子调用 plainSchema(node)，而 plainSchema 第一句就是
 * node.toJSON()。少挂一层，整条派生链直接抛 "schema.toJSON is not a function"，
 * 表现依然是「命名空间出不来，且没有明显报错」。
 * @param field 字段描述
 */
function buildNode(field: Field): SettingsSchemaNode {
  const node: {
    type: string
    meta: Record<string, unknown>
    dict?: Record<string, SettingsSchemaNode>
    inner?: SettingsSchemaNode
  } = { type: field.type, meta: { ...(field.meta ?? {}) } }
  const withInner = field as { inner?: Field }
  const withDict = field as { dict?: FieldDict }
  if (withInner.inner !== undefined) node.inner = buildNode(withInner.inner)
  if (withDict.dict !== undefined) {
    const dict: Record<string, SettingsSchemaNode> = {}
    for (const [key, child] of Object.entries(withDict.dict)) dict[key] = buildNode(child)
    node.dict = dict
  }
  return withToJSON(node)
}

/**
 * 组装成宿主可直接消费的配置描述。
 * @param normalize 归一化函数（与运行时用的是同一个）
 * @param fields    字段描述
 */
export function settingsConfig(
  normalize: (value: unknown) => unknown,
  fields: FieldDict,
): SettingsConfigSchema {
  const root = buildNode({
    type: 'object',
    meta: { volatile: false, description: '智能代码审查配置' },
    dict: fields,
  }) as SettingsConfigSchema

  Object.defineProperty(root, '~standard', {
    value: {
      version: 1 as const,
      vendor: 'dsh-code-review',
      /**
       * 宿主（以及 Cordis 的 resolveConfig）用它校验并归一化配置。
       * 约定：合法返回 { value }，非法返回 { issues }，**绝不抛异常**。
       */
      validate(value: unknown): ValidateResult {
        try {
          return { value: normalize(value) }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
    enumerable: true,
    configurable: true,
  })

  return root
}

/** 把任意输入收敛成对象（供 validate 使用）。 */
export function configObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('配置必须是对象')
  }
  return value as Record<string, unknown>
}

/** 完整设置描述（插件入口导出的那个 Config）。 */
export const Config = settingsConfig(
  (value) => normalizeConfig(configObject(value)).config,
  CONFIG_FIELDS,
)

/** 供测试引用的配置类型。 */
export type { ConfigV2 }
