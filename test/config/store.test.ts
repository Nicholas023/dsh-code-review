// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * store.test.ts —— 配置文件读写的保真测试。
 *
 * 这里锁的是「用户明确要求：更新不能丢设置」的三条具体行为：
 *  1. 写入时未知字段不消失；
 *  2. 损坏文件不被默认值覆盖；
 *  3. 迁移前有备份，备份可回滚。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupConfigFile, readConfigFile, updateConfigFile, writeFileAtomic } from '../../src/config/store.js'

const dirs: string[] = []

/** 建一个临时目录并在结束时清理。 */
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-config-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('读取', () => {
  it('文件不存在时返回默认配置且 existed=false', () => {
    const p = join(tempDir(), 'config.json')
    const r = readConfigFile(p)
    expect(r.existed).toBe(false)
    expect(r.corrupt).toBe(false)
    expect(r.config.version).toBe(2)
  })

  it('v1 文件读取时自动迁移并标记 migrated', () => {
    const p = join(tempDir(), 'config.json')
    writeFileSync(p, JSON.stringify({ review_model: 'glm', concurrency: 6 }), 'utf8')
    const r = readConfigFile(p)
    expect(r.corrupt).toBe(false)
    expect(r.migrated).not.toBeNull()
    expect(r.config.review.model).toBe('glm')
    expect(r.config.execution.concurrency).toBe(6)
  })

  it('损坏的 JSON 标记 corrupt 且不抛错', () => {
    const p = join(tempDir(), 'config.json')
    writeFileSync(p, '{ this is not json', 'utf8')
    const r = readConfigFile(p)
    expect(r.corrupt).toBe(true)
    expect(r.corruptReason).toBeTruthy()
    expect(r.config.version).toBe(2)
  })
})

describe('写入保真', () => {
  it('更新保留磁盘上的未知字段（核心用例）', () => {
    const p = join(tempDir(), 'config.json')
    writeFileSync(
      p,
      JSON.stringify({ version: 2, review: { model: 'a', endpoint: '', protocol: 'openai-chat-completions', credentialRef: '', requestTimeoutMs: 1000, taskTimeoutMs: 2000 }, keepMe: { x: 1 } }),
      'utf8',
    )
    updateConfigFile(p, { review: { model: 'b' } }, { skipBackup: true })

    const written = JSON.parse(readFileSync(p, 'utf8'))
    expect(written.review.model).toBe('b')
    // 同区其他字段不能被顺手清掉
    expect(written.review.endpoint).toBe('')
    // 未知顶层字段必须还在
    expect(written.keepMe).toEqual({ x: 1 })
    expect(written.version).toBe(2)
  })

  it('损坏文件拒绝写入（不覆盖用户数据）', () => {
    const p = join(tempDir(), 'config.json')
    const broken = '{ broken json'
    writeFileSync(p, broken, 'utf8')
    expect(() => updateConfigFile(p, { review: { model: 'x' } }, { skipBackup: true })).toThrow(/损坏/)
    // 原文件必须原封不动
    expect(readFileSync(p, 'utf8')).toBe(broken)
  })

  it('首次写入不存在的文件可直接成功', () => {
    const p = join(tempDir(), 'nested', 'config.json')
    updateConfigFile(p, { review: { model: 'zzz' } }, { skipBackup: true })
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).review.model).toBe('zzz')
  })
})

describe('备份', () => {
  it('备份生成带时间戳副本', () => {
    const d = tempDir()
    const p = join(d, 'config.json')
    writeFileSync(p, '{"version":2}', 'utf8')
    const bak = backupConfigFile(p, '20261104-030000')
    expect(bak).not.toBeNull()
    expect(existsSync(bak!)).toBe(true)
    expect(readFileSync(bak!, 'utf8')).toBe('{"version":2}')
  })

  it('源文件不存在时返回 null', () => {
    expect(backupConfigFile(join(tempDir(), 'none.json'))).toBeNull()
  })

  it('只保留最近 3 份备份', () => {
    const d = tempDir()
    const p = join(d, 'config.json')
    writeFileSync(p, '{"version":2}', 'utf8')
    for (let i = 0; i < 6; i += 1) backupConfigFile(p, `2026110${i}-000000`)
    const backups = readdirSync(d).filter((n) => n.startsWith('config.json.bak.'))
    expect(backups.length).toBe(3)
    // 保留的应是最近的三个
    expect(backups.sort()).toEqual(['config.json.bak.20261103-000000', 'config.json.bak.20261104-000000', 'config.json.bak.20261105-000000'])
  })

  it('更新已有文件时默认会先备份', () => {
    const d = tempDir()
    const p = join(d, 'config.json')
    writeFileSync(p, JSON.stringify({ version: 2 }), 'utf8')
    updateConfigFile(p, { review: { model: 'new' } })
    const backups = readdirSync(d).filter((n) => n.startsWith('config.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })
})

describe('原子写', () => {
  it('写入后内容完整可解析', () => {
    const p = join(tempDir(), 'a.json')
    writeFileAtomic(p, '{"ok":true}')
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ok: true })
  })

  it('写入不留下临时文件', () => {
    const d = tempDir()
    const p = join(d, 'a.json')
    writeFileAtomic(p, '{"ok":1}')
    const leftovers = readdirSync(d).filter((n) => n.includes('.tmp.'))
    expect(leftovers).toHaveLength(0)
  })
})
