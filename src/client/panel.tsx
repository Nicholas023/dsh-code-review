// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * panel.tsx —— 左侧栏「代码审查」面板。
 *
 * 三条设计约束（来自使用反馈）：
 *  1. 绝对路径必须**可复制**——人眼记不住 `C:\\Users\\...\\2026-...md`；
 *  2. 评审结果要**在这里直接看**，不必去翻文件；
 *  3. 状态三色：绿=已完成、黄=进行中、红=失败。
 *
 * 字体不写死 px：DSH 的字号由宿主决定，写死会和界面不一致。
 * 这里只用 em 相对大小与字重/颜色做层次，跟随宿主基准。
 */

import { useEffect, useState } from 'react'

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
  readonly status: string | null
}

interface ReportFinding {
  readonly id: string
  readonly severity: string
  readonly category: string
  readonly path: string
  readonly lineStart: number | null
  readonly title: string
  readonly explanation: string | null
  readonly recommendation: string | null
  readonly confidence: number | null
}

const LIMIT = 3
const POLL_MS = 3000

const C = {
  card: 'rgba(255,255,255,0.035)',
  border: 'rgba(255,255,255,0.08)',
  muted: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.35)',
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
} as const

/** 阶段 → 中文。 */
const STAGE_TEXT: Record<string, string> = {
  queued: '排队中', collect: '采集代码', collecting: '采集代码', select: '筛选文件',
  sizing: '估算规模', reviewing: '评审中', 'main-agent': '评审中', 'child-agent': '深挖子任务',
  aggregating: '汇总结果', reporting: '写报告中', completed: '已完成', failed: '失败', cancelled: '已取消',
}

/** 严重度 → 颜色。 */
const SEV_COLOR: Record<string, string> = {
  critical: '#f85149', high: '#ff8f4d', medium: '#d29922', low: 'rgba(255,255,255,0.55)', info: 'rgba(255,255,255,0.4)',
}

/** 三态判定：失败红、运行黄、其余绿。 */
export function stateColor(item: ProgressItem): string {
  if (item.stage === 'failed' || item.stage === 'cancelled' || item.status === 'failed') return C.red
  if (!item.finished) return C.yellow
  return C.green
}

function shortRepo(repoPath: string): string {
  const parts = repoPath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function formatElapsed(fromIso: string, toIso: string): string {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ''
  const sec = Math.round((to - from) / 1000)
  if (sec < 60) return String(sec) + ' 秒'
  return String(Math.floor(sec / 60)) + ' 分 ' + String(sec % 60) + ' 秒'
}

/** 小图标按钮（复制）。 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 老浏览器/无权限时退回到临时 textarea
      try {
        const el = document.createElement('textarea')
        el.value = text
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        el.remove()
      } catch { return }
    }
    setDone(true)
    window.setTimeout(() => setDone(false), 1200)
  }
  return (
    <button
      type="button"
      title={label}
      onClick={(e) => { e.stopPropagation(); void copy() }}
      style={{
        border: '1px solid ' + C.border, background: 'transparent', color: C.muted,
        borderRadius: '5px', padding: '1px 6px', fontSize: '0.85em', cursor: 'pointer', flex: '0 0 auto',
      }}
    >
      {done ? '已复制' : '复制'}
    </button>
  )
}

/** 展开后的结果列表。 */
function ReportView({ taskId }: { taskId: string }) {
  const [report, setReport] = useState<{ status: string; findings: ReportFinding[] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/code-review/report?taskId=' + encodeURIComponent(taskId))
        const json = (await res.json()) as { ok?: boolean; report?: { status: string; findings: ReportFinding[] }; error?: string }
        if (!alive) return
        if (json.ok === true && json.report !== undefined) setReport(json.report)
        else setError(json.error ?? '报告不可用')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { alive = false }
  }, [taskId])

  if (error !== '') return <div style={{ fontSize: '0.92em', color: C.faint, padding: '6px 0' }}>{error}</div>
  if (report === null) return <div style={{ fontSize: '0.92em', color: C.faint, padding: '6px 0' }}>读取中…</div>
  if (report.findings.length === 0) return <div style={{ fontSize: '0.92em', color: C.faint, padding: '6px 0' }}>没有发现问题。</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0 2px' }}>
      {report.findings.map((f) => (
        <div key={f.id} style={{ borderLeft: '2px solid ' + (SEV_COLOR[f.severity] ?? C.faint), paddingLeft: '10px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
            <span style={{ fontSize: '0.8em', color: SEV_COLOR[f.severity] ?? C.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {f.severity}
            </span>
            <span style={{ fontSize: '0.85em', color: C.faint, fontFamily: 'ui-monospace, monospace' }}>
              {f.path}{f.lineStart === null ? '' : ':' + String(f.lineStart)}
            </span>
          </div>
          <div style={{ fontSize: '0.95em', marginTop: '2px' }}>{f.title}</div>
          {f.explanation !== null && f.explanation !== '' && (
            <div style={{ fontSize: '0.9em', color: C.muted, marginTop: '3px', lineHeight: 1.6 }}>{f.explanation}</div>
          )}
          {f.recommendation !== null && f.recommendation !== '' && (
            <div style={{ fontSize: '0.9em', color: 'rgba(255,255,255,0.72)', marginTop: '4px', lineHeight: 1.6 }}>
              <span style={{ color: C.faint }}>建议：</span>{f.recommendation}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** 一张任务卡。 */
function Item({ item, onCancel }: { item: ProgressItem; onCancel: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const color = stateColor(item)
  const stage = STAGE_TEXT[item.stage] ?? item.stage
  const round = item.round !== null && item.maxRounds !== null ? '第 ' + String(item.round) + '/' + String(item.maxRounds) + ' 轮' : ''
  const elapsed = formatElapsed(item.startedAt, item.finished ? item.updatedAt : new Date().toISOString())
  const scope = item.command + (item.mode === null ? '' : ' / ' + item.mode)
  const reportName = item.reportPath === null ? '' : item.reportPath.split(/[\\/]/).pop() ?? ''

  return (
    <div style={{ background: C.card, border: '1px solid ' + C.border, borderRadius: '12px', padding: '13px 15px', marginBottom: '10px' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: item.finished ? 'pointer' : 'default' }}
      >
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flex: '0 0 auto' }} />
        <strong style={{ fontSize: '1em', fontWeight: 600 }}>{stage}</strong>
        {round !== '' && <span style={{ fontSize: '0.9em', color: C.muted }}>{round}</span>}
        {item.status === 'partial' && (
          <span style={{ fontSize: '0.8em', color: C.yellow, border: '1px solid ' + C.yellow, borderRadius: '4px', padding: '0 5px' }}>部分</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.8em', color: C.faint, fontFamily: 'ui-monospace, monospace' }}>
          {item.taskId.slice(0, 8)}
        </span>
        {item.finished && <span style={{ fontSize: '0.8em', color: C.faint }}>{open ? '收起' : '展开'}</span>}
      </div>

      <div style={{ fontSize: '0.9em', color: C.muted, display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
        <span style={{ color: 'rgba(255,255,255,0.75)' }}>{shortRepo(item.repoPath)}</span>
        <span style={{ color: C.faint }}>·</span><span>{scope}</span>
        {elapsed !== '' && <><span style={{ color: C.faint }}>·</span><span>{elapsed}</span></>}
      </div>

      {item.detail !== null && item.detail !== '' && (
        <div style={{ fontSize: '0.88em', color: C.faint, marginTop: '4px' }}>{item.detail}</div>
      )}

      {open && item.finished && <ReportView taskId={item.taskId} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
        {item.finished && item.findingCount !== null && (
          <span style={{ fontSize: '0.9em', color: C.muted }}>发现 <strong>{String(item.findingCount)}</strong> 个问题</span>
        )}
        {item.reportPath !== null && (
          <>
            <span title={item.reportPath} style={{ fontSize: '0.82em', color: C.faint, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '260px' }}>
              {reportName}
            </span>
            <CopyButton text={item.reportPath} label="复制报告完整路径" />
          </>
        )}
        {!item.finished && (
          <button
            type="button"
            onClick={() => onCancel(item.taskId)}
            style={{ marginLeft: 'auto', fontSize: '0.88em', padding: '3px 12px', borderRadius: '6px', border: '1px solid ' + C.border, background: 'transparent', color: C.muted, cursor: 'pointer' }}
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
        if (json.ok === true && Array.isArray(json.tasks)) { setItems(json.tasks.slice(0, LIMIT)); setError('') }
        else setError(json.error ?? '宿主未返回数据')
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
      await fetch('/api/code-review/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) })
    } catch { /* 下一轮轮询会刷新真实状态 */ }
  }

  return (
    <div style={{ padding: '22px 26px', maxWidth: '820px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <h2 style={{ margin: 0, fontSize: '1.15em', fontWeight: 600 }}>代码审查</h2>
        <span style={{ fontSize: '0.85em', color: C.faint }}>最近 {LIMIT} 条</span>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: '0.86em', color: C.muted, lineHeight: 1.6 }}>
        用 <code style={{ fontSize: '0.95em', padding: '1px 5px', borderRadius: '4px', background: C.card }}>code_review</code> 工具或
        <code style={{ fontSize: '0.95em', padding: '1px 5px', borderRadius: '4px', background: C.card, marginLeft: '4px' }}>/review</code> 命令发起评审。已完成的条目可点开直接看结果。
      </p>

      {error !== '' && <div style={{ fontSize: '0.9em', color: C.red, marginBottom: '12px' }}>读取进度失败：{error}</div>}

      {loaded && items.length === 0 && error === '' && (
        <div style={{ border: '1px dashed ' + C.border, borderRadius: '12px', padding: '26px 16px', textAlign: 'center', fontSize: '0.9em', color: C.faint }}>
          还没有评审任务
        </div>
      )}

      {items.map((item) => <Item key={item.taskId} item={item} onCancel={(id) => void cancel(id)} />)}
    </div>
  )
}
