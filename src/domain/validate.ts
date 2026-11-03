// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * validate.ts —— 落盘 JSON 的运行时校验入口。
 *
 * 为什么需要：任务卡、配置文件、报告都是从磁盘读回来的不可信数据
 * （可能被人工编辑、被旧版本写入、写到一半崩溃）。TypeScript 的静态类型
 * 在运行时不存在，只靠它等于放弃校验。这里用 JSON Schema 做真正的守门。
 *
 * 设计取舍：
 *  - 编译期复用同一个 Ajv 实例（构造开销不小，且 schema 是固定的）；
 *  - 校验失败抛带路径的错，而不是返回 undefined —— 调用方必须显式处理，
 *    避免「读坏了当默认值用」这类静默兜底（0.1.x 的 config 就有这个洞）。
 */

import { Ajv, type JSONSchemaType, type ValidateFunction } from 'ajv'

/** 校验器缓存：同一份 schema 只编译一次。 */
const compiled = new Map<string, ValidateFunction>()

/** 校验失败时抛出的错误，携带 schema 名与失败路径。 */
export class SchemaValidationError extends Error {
  constructor(
    readonly schemaName: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${schemaName} 校验失败（${path || "<root>"}）：${detail}`)
    this.name = 'SchemaValidationError'
  }
}

/**
 * 按 schema 校验一个从磁盘读回的值。
 * @param schemaName 用于缓存与报错的稳定名字（如 'task' / 'config' / 'report'）。
 * @param schema     JSON Schema 定义。
 * @param value      待校验的不可信数据。
 * @returns 通过校验后的同一个值（不复制，保持引用身份）。
 * @throws SchemaValidationError 校验不通过时。
 */
export function validateWith<T>(schemaName: string, schema: object, value: unknown): T {
  let fn = compiled.get(schemaName)
  if (!fn) {
    // allErrors:false —— 只报第一个错，错误信息更可读；strict:false 容忍未知关键字
    const ajv = new Ajv({ allErrors: false, strict: false })
    fn = ajv.compile(schema)
    compiled.set(schemaName, fn)
  }
  if (fn(value)) return value as T
  const first = fn.errors?.[0]
  const path = first?.instancePath ?? ''
  const detail = first ? `${first.message ?? 'invalid'}` : 'unknown validation error'
  throw new SchemaValidationError(schemaName, path, detail)
}

/** 清空校验器缓存（测试用：模拟不同 schema 版本共存）。 */
export function resetValidatorCache(): void {
  compiled.clear()
}

/** 供 schema 定义方复用的类型别名。 */
export type { JSONSchemaType }
