// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * schema.ts —— 设置描述的「宿主端」组装（第一层）。
 *
 * 字段本身的定义在 fields.ts（纯数据，浏览器端也要用）。
 * 这里只做两件事：
 *  1. 把字段树包成宿主可消费的形状（type/meta/dict）；
 *  2. 附上 Standard Schema 的 validate，让宿主用同一份描述做校验。
 *
 * 为什么不直接用 schemastery：宿主会剥掉 volatile 元数据做校验副本，
 * 用自定义描述树能保证「描述」与「校验」永远来自同一份定义。
 */

import type { ConfigV2 } from '../config/defaults.js'
import { normalizeConfig } from '../config/schema.js'
import { CONFIG_FIELDS, type FieldDict } from './fields.js'

export { CONFIG_FIELDS, editable, readonlyField } from './fields.js'
export type { Field, FieldDict, FieldType } from './fields.js'

/**
 * 组装成宿主可直接消费的配置描述。
 * @param normalize 归一化函数（与运行时用的是同一个）
 * @param fields    字段描述
 */
export function settingsConfig(normalize: (value: unknown) => unknown, fields: FieldDict) {
  return {
    type: 'object' as const,
    meta: { volatile: false, description: '智能代码审查配置' },
    dict: fields,
    '~standard': {
      version: 1 as const,
      vendor: 'dsh-code-review',
      validate(value: unknown): { value: unknown } | { issues: { message: string }[] } {
        try {
          return { value: normalize(value) }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
  }
}

/** 把任意输入收敛成对象（供 validate 使用）。 */
export function configObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('配置必须是对象')
  }
  return value as Record<string, unknown>
}

/** 完整设置描述（宿主注册用）。 */
export const Config = settingsConfig(
  (value) => normalizeConfig(configObject(value)).config,
  CONFIG_FIELDS,
)

/** 供测试引用的配置类型。 */
export type { ConfigV2 }
