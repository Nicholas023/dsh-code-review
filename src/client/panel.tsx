// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * panel.tsx —— 左侧栏「代码审查」面板（主区页面）。
 *
 * 只做一件事：把宿主 /api/code-review/progress 返回的最近几条任务画出来，
 * 并给运行中的任务一个「取消」按钮。
 *
 * 样式原则：
 *  - 只用 rgba 中性色，不引用宿主 CSS 变量（版本耦合），也不写死深/浅主题；
 *    在 DSH 的深色界面上实测可读；
 *  - 一张卡只承载一条任务，层次是「状态 → 目标 → 细节 → 操作」四行；
 *  - 空态与错误态都给出可执行的下一步，不留白屏。
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

/** 最多显示几条。 */
const LIMIT = 3
/** 轮询间隔（毫秒）。 */
const POLL_MS = 3000

const C = {
  card: 'rgba(255,255,255,0.035)',
  cardHover: 'rgba(255,255,255,0.055)',
  border: 'rgba(255,255,255,0.08)',
  muted: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.35)',
  green: '#3fb950',
  gray: '#6e7681',
  red: '#f85149',
  amber: '#d29922',
} as const

/** 阶段 → 中文。 */
const STAGE_TEXT: Record<string, string> = {
  queued: '排队中',
  collect: '采集代码',
  collecting: '采集代码',
  select: '筛选文件',
  sizing: '估算规模',
  reviewing: '评审中',
  'main-agent': '评审中',
  'child-agent': '深挖子任务',
  aggregating: '汇总结果',
  reporting: '写报告中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 取路径最后两段，太长会撑破标题行。 */
function shortRepo(repoPath: string): string {
  const parts = repoPath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

/** 把毫秒差格式化成 "3 分 12 秒"。 */
function formatElapsed(fromIso: string, toIso: string): string {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ''
  const sec = Math.round((to - from) / 1000)
  if (sec < 60) return String(sec) + ' 秒'
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  return String(min) + ' 分 ' + String(rest) + ' 秒'
}

/** 一张任务卡。 */
function Item({ item, onCancel }: { item: ProgressItem; onCancel: (id: string) => void }) {
  const running = !item.finished
  const stage = STAGE_TEXT[item.stage] ?? item.stage
  const round = item.round !== null && item.maxRounds !== null
    ? '第 ' + String(item.round) + '/' + String(item.maxRounds) + ' 轮'
    : ''
  const elapsed = formatElapsed(item.startedAt, running ? new Date().toISOString() : item.updatedAt)
  const scope = item.command + (item.mode === null ? '' : ' / ' + item.mode)

  return (
    <div
      style={{
        background: C.card,
        border: '1px solid ' + C.border,
        borderRadius: '12px',
        padding: '14px 16px',
        marginBottom: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      {/* 第一行：状态 + 轮次 + 短 id */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: running ? C.green : C.gray,
            flex: '0 0 auto',
          }}
        />
        <strong style={{ fontSize: '13px', fontWeight: 600 }}>{stage}</strong>
        {round !== '' && <span style={{ fontSize: '12px', color: C.muted }}>{round}</span>}
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: C.faint, fontFamily: 'ui-monospace, monospace' }}>
          {item.taskId.slice(0, 8)}
        </span>
      </div>

      {/* 第二行：仓库 + 模式 + 时长 */}
      <div style={{ fontSize: '12px', color: C.muted, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ color: 'rgba(255,255,255,0.75)' }}>{shortRepo(item.repoPath)}</span>
        <span style={{ color: C.faint }}>·</span>
        <span>{scope}</span>
        {elapsed !== '' && <><span style={{ color: C.faint }}>·</span><span>{elapsed}</span></>}
      </div>

      {/* 第三行：细节（有才显示） */}
      {item.detail !== null && item.detail !== '' && (
        <div style={{ fontSize: '12px', color: C.faint }}>{item.detail}</div>
      )}

      {/* 第四行：结果 或 操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {item.finished && item.findingCount !== null && (
          <span style={{ fontSize: '12px', color: C.muted }}>
            发现 <strong style={{ color: 'inherit' }}>{String(item.findingCount)}</strong> 个问题
          </span>
        )}
        {item.finished && item.reportPath !== null && (
          <span
            title={item.reportPath}
            style={{ fontSize: '11px', color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '320px' }}
          >
            {item.reportPath.split(/[\\/]/).pop()}
          </span>
        )}
        {running && (
          <button
            type="button"
            onClick={() => onCancel(item.taskId)}
            style={{
              marginLeft: 'auto',
              fontSize: '12px',
              padding: '4px 12px',
              borderRadius: '6px',
              border: '1px solid ' + C.border,
              background: 'transparent',
              color: C.muted,
              cursor: 'pointer',
            }}
          >
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
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/code-review/progress')
        const json = (await res.json()) as { ok?: boolean; tasks?: ProgressItem[]; error?: string }
        if (!alive) return
        if (json.ok === true && Array.isArray(json.tasks)) {
          setItems(json.tasks.slice(0, LIMIT))
          setError('')
        } else {
          setError(json.error ?? '宿主未返回数据')
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoaded(true)
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
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
    <div style={{ padding: '22px 26px', maxWidth: '760px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>代码审查</h2>
        <span style={{ fontSize: '12px', color: C.faint }}>最近 {LIMIT} 条</span>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: '12px', color: C.muted, lineHeight: 1.6 }}>
        在会话里用 <code style={{ fontSize: '11px', padding: '1px 5px', borderRadius: '4px', background: C.card }}>code_review</code> 工具
        或 <code style={{ fontSize: '11px', padding: '1px 5px', borderRadius: '4px', background: C.card }}>/review</code> 命令发起评审。
      </p>

      {error !== '' && (
        <div style={{ fontSize: '12px', color: C.red, marginBottom: '12px' }}>读取进度失败：{error}</div>
      )}

      {loaded && items.length === 0 && error === '' && (
        <div
          style={{
            border: '1px dashed ' + C.border,
            borderRadius: '12px',
            padding: '28px 16px',
            textAlign: 'center',
            fontSize: '12px',
            color: C.faint,
          }}
        >
          还没有评审任务
        </div>
      )}

      {items.map((item) => <Item key={item.taskId} item={item} onCancel={(id) => void cancel(id)} />)}
    </div>
  )
}
