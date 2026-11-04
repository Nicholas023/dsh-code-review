// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * panel.tsx —— 左侧栏「代码审查」面板（主区页面）。
 *
 * 它只做一件事：把宿主 /api/code-review/progress 返回的最近几条任务画出来，
 * 并给运行中的任务一个「取消」按钮。
 *
 * 为什么轮询而不是推送：宿主侧的进度本来就是文件轮询产生的，
 * 3 秒一次的代价可以忽略；推送需要接 remote/typert，收益不成正比。
 */

import { useEffect, useState } from 'react'

/** 与宿主 webapi.ts 的 ProgressItem 对应（只取用到的字段）。 */
interface ProgressItem {
  readonly taskId: string
  readonly repoPath: string
  readonly command: string
  readonly mode: string | null
  readonly stage: string
  readonly detail: string | null
  readonly round: number | null
  readonly maxRounds: number | null
  readonly startedAt: string
  readonly updatedAt: string
  readonly finished: boolean
  readonly reportPath: string | null
  readonly findingCount: number | null
}

const hintStyle = { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 }
const cardStyle = {
  border: '1px solid rgba(128,128,128,0.25)',
  borderRadius: '8px',
  padding: '10px 12px',
  marginBottom: '10px',
}
const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }

/** 阶段 → 中文。 */
const STAGE_TEXT: Record<string, string> = {
  queued: '排队中',
  collecting: '采集代码',
  collect: '采集代码',
  select: '筛选文件',
  sizing: '估算规模',
  reviewing: '评审中',
  'main-agent': '主 agent',
  'child-agent': '子 agent',
  aggregating: '汇总',
  reporting: '写报告',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 把一个进度项渲染成一张小卡。 */
function Item({ item, onCancel }: { item: ProgressItem; onCancel: (id: string) => void }) {
  const running = !item.finished
  const repo = item.repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? item.repoPath
  const stage = STAGE_TEXT[item.stage] ?? item.stage
  const roundText = item.round !== null && item.maxRounds !== null ? ' 第 ' + String(item.round) + '/' + String(item.maxRounds) + ' 轮' : ''
  const detail = item.detail !== null && item.detail !== '' ? ' · ' + item.detail : ''

  return (
    <div style={cardStyle}>
      <div style={rowStyle}>
        <span style={{ color: running ? '#3fb950' : '#8b949e' }}>{running ? '●' : '○'}</span>
        <strong style={{ fontSize: '13px' }}>{stage}{roundText}</strong>
        <span style={{ ...hintStyle, marginLeft: 'auto' }}>{repo}</span>
      </div>
      <div style={hintStyle}>
        {item.command}{item.mode === null ? '' : ' / ' + item.mode}{detail}
      </div>
      {item.finished && item.findingCount !== null && (
        <div style={hintStyle}>结果：{String(item.findingCount)} 个问题</div>
      )}
      {item.reportPath !== null && (
        <div style={{ ...hintStyle, wordBreak: 'break-all' }}>{item.reportPath}</div>
      )}
      <div style={{ ...rowStyle, marginTop: '6px', marginBottom: 0 }}>
        <span style={{ ...hintStyle, fontFamily: 'monospace' }}>{item.taskId.slice(0, 8)}</span>
        {running && (
          <button type="button" onClick={() => onCancel(item.taskId)} style={{ marginLeft: 'auto', fontSize: '12px' }}>
            取消
          </button>
        )}
      </div>
    </div>
  )
}

/** 面板主体。 */
export function CodeReviewPanel() {
  const [items, setItems] = useState<ProgressItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/code-review/progress')
        const json = (await res.json()) as { ok?: boolean; tasks?: ProgressItem[]; error?: string }
        if (!alive) return
        if (json.ok === true && Array.isArray(json.tasks)) {
          setItems(json.tasks)
          setError('')
        } else {
          setError(json.error ?? '宿主未返回数据')
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const cancel = async (taskId: string): Promise<void> => {
    try {
      await fetch('/api/code-review/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
    } catch {
      // 取消失败不弹窗：下一轮轮询会把真实状态刷回来
    }
  }

  return (
    <div style={{ padding: '16px 20px', maxWidth: '720px' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: '15px' }}>代码审查</h3>
      <p style={{ ...hintStyle, margin: '0 0 14px' }}>
        最近 5 条任务的进度。在会话里用 <code>code_review</code> 工具或 <code>/review</code> 命令发起。
      </p>
      {error !== '' && <p style={{ ...hintStyle, color: '#f85149' }}>读取进度失败：{error}</p>}
      {items.length === 0 && error === '' && <p style={hintStyle}>还没有评审任务。</p>}
      {items.map((item) => <Item key={item.taskId} item={item} onCancel={(id) => void cancel(id)} />)}
    </div>
  )
}
