// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * progress.test.ts —— 进度落地与读取的契约测试。
 *
 * 这条链路的失败模式是"静默"的：进度写不进去，界面就一直显示"还没有任务"，
 * 用户只会以为功能没做。所以这里逐条钉住：写进去能读回、坏文件不拖垮整体、
 * 只保留最近 N 条、以及合并任务卡终态的逻辑。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  progressDir,
  progressPath,
  pruneProgress,
  readAllProgress,
  removeProgress,
  writeProgress,
  type ProgressSnapshot,
} from '../../src/plugin/progress.js'
import { buildProgressItems, isRunningStage } from '../../src/plugin/webapi.js'

const roots: string[] = []
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-progress-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

/** 造一份快照。 */
function snap(taskId: string, over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    taskId,
    repoPath: 'D:/repo',
    command: 'review',
    mode: 'uncommitted',
    stage: 'main-agent',
    detail: null,
    round: null,
    maxRounds: null,
    startedAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    ...over,
  }
}

describe('写入与读取', () => {
  it('写进去能原样读回', () => {
    const root = tempRoot()
    writeProgress(snap('t1', { detail: 'round 3', round: 3, maxRounds: 8 }), root)
    const all = readAllProgress(root)
    expect(all).toHaveLength(1)
    expect(all[0]!.taskId).toBe('t1')
    expect(all[0]!.round).toBe(3)
    expect(all[0]!.maxRounds).toBe(8)
  })

  it('按更新时间倒序', () => {
    const root = tempRoot()
    writeProgress(snap('old', { updatedAt: '2026-11-05T00:00:00.000Z' }), root)
    writeProgress(snap('mid', { updatedAt: '2026-11-05T01:00:00.000Z' }), root)
    writeProgress(snap('new', { updatedAt: '2026-11-05T02:00:00.000Z' }), root)
    expect(readAllProgress(root).map((s) => s.taskId)).toEqual(['new', 'mid', 'old'])
  })

  it('目录不存在时返回空数组而不是抛错', () => {
    expect(readAllProgress(join(tempRoot(), 'nope'))).toEqual([])
  })

  it('损坏的文件被跳过，不影响其它条目', () => {
    const root = tempRoot()
    writeProgress(snap('good'), root)
    mkdirSync(progressDir(root), { recursive: true })
    writeFileSync(join(progressDir(root), 'broken.json'), '{ 不是 json', 'utf8')
    expect(readAllProgress(root).map((s) => s.taskId)).toEqual(['good'])
  })

  it('taskId 里的路径分隔符被清洗（不逃出目录）', () => {
    // 关键不是"没有点号"，而是"文件必须落在进度目录里、且文件名不再含分隔符"。
    // '..' 作为普通字符留在名字里完全无害，只要它不构成路径段。
    const dir = progressDir('C:/root')
    const p = progressPath('../../evil', 'C:/root')
    expect(p.startsWith(dir)).toBe(true)
    const tail = p.slice(dir.length)
    expect(tail).toMatch(/^[\\/][^\\/]+$/)
    expect(p.endsWith('.json')).toBe(true)
  })

  it('removeProgress 删掉单条', () => {
    const root = tempRoot()
    writeProgress(snap('a'), root)
    removeProgress('a', root)
    expect(readAllProgress(root)).toEqual([])
  })
})

describe('裁剪', () => {
  it('只保留最近 N 条', () => {
    const root = tempRoot()
    for (let i = 0; i < 5; i += 1) {
      writeProgress(snap('t' + String(i), { updatedAt: '2026-11-05T0' + String(i) + ':00:00.000Z' }), root)
    }
    const removed = pruneProgress(2, root)
    expect(removed).toBe(3)
    expect(readAllProgress(root).map((s) => s.taskId)).toEqual(['t4', 't3'])
  })
})

describe('合并成界面数据', () => {
  it('运行中的条目 running=true', () => {
    const items = buildProgressItems([snap('t1')], [], 5)
    expect(items).toHaveLength(1)
    expect(items[0]!.finished).toBe(false)
  })

  it('终态从任务卡补齐，并带出报告路径与问题数', () => {
    const items = buildProgressItems(
      [snap('t1', { stage: 'reporting' })],
      [{ id: 't1', stage: 'completed', summary: { reportPath: 'C:/r/x.md', findingCount: 7 } }],
      5,
    )
    expect(items[0]!.finished).toBe(true)
    expect(items[0]!.reportPath).toBe('C:/r/x.md')
    expect(items[0]!.findingCount).toBe(7)
  })

  it('stage 判定：只有 completed/failed/cancelled 算结束', () => {
    expect(isRunningStage('main-agent')).toBe(true)
    expect(isRunningStage('reporting')).toBe(true)
    expect(isRunningStage('completed')).toBe(false)
    expect(isRunningStage('failed')).toBe(false)
    expect(isRunningStage('cancelled')).toBe(false)
  })

  it('limit 生效', () => {
    const many = Array.from({ length: 10 }, (_, i) => snap('t' + String(i)))
    expect(buildProgressItems(many, [], 3)).toHaveLength(3)
  })
})
