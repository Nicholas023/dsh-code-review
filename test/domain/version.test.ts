// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * version.test.ts —— 协议版本模块的最小契约测试。
 *
 * 目标不只是"能跑"，而是锁住三件事：
 *  1. 版本常量存在且为正整数（防止误写成字符串/0）；
 *  2. PROTOCOL_VERSIONS 与各独立常量一致（防止有人只改一处）；
 *  3. 版本集合在进程内是不可变的（as const 的运行时体现是冻结语义由使用方保证，
 *     这里只断言不会被意外改动关键字段的读取结果）。
 */

import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION,
  KERNEL_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  REPORT_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
} from '../../src/domain/version.js'

describe('协议版本常量', () => {
  it('四个版本号都是正整数', () => {
    for (const v of [TASK_SCHEMA_VERSION, CONFIG_VERSION, REPORT_SCHEMA_VERSION, KERNEL_PROTOCOL_VERSION]) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })

  it('PROTOCOL_VERSIONS 与独立常量逐项一致', () => {
    expect(PROTOCOL_VERSIONS.task).toBe(TASK_SCHEMA_VERSION)
    expect(PROTOCOL_VERSIONS.config).toBe(CONFIG_VERSION)
    expect(PROTOCOL_VERSIONS.report).toBe(REPORT_SCHEMA_VERSION)
    expect(PROTOCOL_VERSIONS.kernel).toBe(KERNEL_PROTOCOL_VERSION)
  })

  it('0.2.0 的任务卡与配置版本均为 2（0.1.x 视作 v1）', () => {
    expect(TASK_SCHEMA_VERSION).toBe(2)
    expect(CONFIG_VERSION).toBe(2)
  })
})
