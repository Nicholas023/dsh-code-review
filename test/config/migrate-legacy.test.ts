// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * migrate-legacy.test.ts —— 0.1.x → 0.2.0 配置自动迁移的契约测试。
 *
 * 用户的底线要求：升级一个版本不能把设置搞丢。
 * 这里验证四条：真的搬了、值对得上、不覆盖已有新配置、坏文件不动。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureLegacyMigrated } from '../../src/config/migrate-legacy.js'
import { readConfigFile } from '../../src/config/store.js'
import { configFilePath, legacyConfigFilePath } from '../../src/store/paths.js'

const roots: string[] = []
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-legacy-'))
  roots.push(d)
  // 预建插件数据目录（写入旧配置前必须存在）
  mkdirSync(join(d, 'dsh-code-review'), { recursive: true })
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('旧配置自动迁移', () => {
  it('新文件不存在时从 plugin-config.json 搬过来', () => {
    const root = tempRoot()
    const legacy = legacyConfigFilePath(root)
    writeFileSync(legacy, JSON.stringify({
      review_model: 'glm-5.1',
      report_dir: 'D:/my-reports',
      concurrency: 6,
      first_run: false,
    }), 'utf8')

    const r = ensureLegacyMigrated(root)
    expect(r.performed).toBe(true)

    const read = readConfigFile(configFilePath(root))
    expect(read.config.review.model).toBe('glm-5.1')
    expect(read.config.report.directory).toBe('D:/my-reports')
    expect(read.config.execution.concurrency).toBe(6)
    expect(read.config.onboarding.firstRunCompleted).toBe(true)
  })

  it('engine_bin 被丢弃（0.2.0 无外部引擎）', () => {
    const root = tempRoot()
    writeFileSync(legacyConfigFilePath(root), JSON.stringify({ engine_bin: 'C:/bin/codecheck.exe' }), 'utf8')
    ensureLegacyMigrated(root)
    const cfg = readConfigFile(configFilePath(root)).config as unknown as Record<string, unknown>
    expect(cfg.engine_bin).toBeUndefined()
  })

  it('新文件已存在时不覆盖（幂等）', () => {
    const root = tempRoot()
    // 先造一个新配置
    writeFileSync(configFilePath(root), JSON.stringify({ version: 2, review: { model: 'new-model' } }), 'utf8')
    writeFileSync(legacyConfigFilePath(root), JSON.stringify({ review_model: 'old-model' }), 'utf8')

    const r = ensureLegacyMigrated(root)
    expect(r.performed).toBe(false)
    expect(readConfigFile(configFilePath(root)).config.review.model).toBe('new-model')
  })

  it('无旧文件时不做任何事', () => {
    const root = tempRoot()
    const r = ensureLegacyMigrated(root)
    expect(r.performed).toBe(false)
    expect(r.reason).toContain('无旧配置')
  })

  it('旧文件损坏时不迁移（不把坏数据写进新文件）', () => {
    const root = tempRoot()
    writeFileSync(legacyConfigFilePath(root), '{ broken json', 'utf8')
    const r = ensureLegacyMigrated(root)
    expect(r.performed).toBe(false)
    expect(r.reason).toContain('损坏')
    // 新文件不应该被创建
    expect(readConfigFile(configFilePath(root)).existed).toBe(false)
  })

  it('迁移保留未知字段', () => {
    const root = tempRoot()
    writeFileSync(legacyConfigFilePath(root), JSON.stringify({
      review_model: 'x',
      my_custom_setting: { nested: true },
    }), 'utf8')
    ensureLegacyMigrated(root)
    // 未知字段保留在原始对象里（raw），归一化后的 config 只含已知分区 —— 这是设计
    const read = readConfigFile(configFilePath(root))
    expect(read.raw.my_custom_setting).toEqual({ nested: true })
    expect(read.config.review.model).toBe('x')
  })

  it('写入磁盘的新文件里确实带着未知字段（降级也不丢）', () => {
    const root = tempRoot()
    writeFileSync(legacyConfigFilePath(root), JSON.stringify({
      review_model: 'x',
      future_field: 'keep-me',
    }), 'utf8')
    ensureLegacyMigrated(root)
    const onDisk = JSON.parse(readFileSync(configFilePath(root), 'utf8')) as Record<string, unknown>
    expect(onDisk.future_field).toBe('keep-me')
    expect(onDisk.version).toBe(2)
  })
})
