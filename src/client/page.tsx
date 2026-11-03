// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * page.tsx —— 设置面板的渲染层。
 *
 * 这里只负责把 logic.ts 算出来的东西画出来：控件、草稿态、保存按钮。
 * 判断逻辑一律在 logic.ts —— 那样它能在没有 DOM 的环境里被测试。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  SECTION_LABELS,
  SECTION_ORDER,
  deriveControls,
  draftToPatch,
  snapshotToDraft,
  valueAt,
  type Control,
} from './logic.js'
import type { PluginConfigViewProps } from './types.js'

/** 输入控件的通用样式（不依赖宿主 CSS 变量，避免耦合）。 */
const fieldStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '4px',
  marginBottom: '14px',
}
const labelStyle = { fontSize: '13px', fontWeight: 600 }
const hintStyle = { fontSize: '12px', opacity: 0.65, lineHeight: 1.4 }
const inputStyle = {
  padding: '6px 8px',
  borderRadius: '6px',
  border: '1px solid rgba(128,128,128,0.35)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '13px',
}

/**
 * 页面组件。
 *
 * view=summary 时只给一行摘要（插件列表里那一行）；view=page 时给完整表单。
 */
export function CodeReviewSettings(props: PluginConfigViewProps) {
  const form = props.form
  const controls = useMemo(() => deriveControls(), [])

  // 宿主快照 → 草稿。宿主 revision 变化（别处保存了）且本地没改动时，跟随更新。
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [baseline, setBaseline] = useState<Record<string, unknown> | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const state = form?.state
  const revision = state?.revision
  const status = state?.status

  useEffect(() => {
    if (dirty) return
    const next = snapshotToDraft(state?.value, controls)
    setDraft(next)
    setBaseline(state?.value)
  }, [revision, status, dirty, controls, state?.value])

  // ── 摘要视图 ──
  if (props.view === 'summary') {
    const endpoint = valueAt(state?.value, 'review.endpoint')
    const model = valueAt(state?.value, 'review.model')
    if (typeof endpoint !== 'string' || endpoint === '') return <span>未配置端点</span>
    return <span>{String(model ?? '?')} @ {endpoint}</span>
  }

  // ── 不可用状态 ──
  if (form === undefined || status === 'unavailable') {
    return <p style={hintStyle}>配置不可用：宿主没有向本客户端暴露该设置命名空间。</p>
  }
  if (status === 'loading') {
    return <p style={hintStyle}>正在读取配置…</p>
  }
  const readOnly = state?.writable === false

  /** 改一个字段（只动草稿）。 */
  const edit = (path: string, value: unknown): void => {
    setDraft((prev) => ({ ...prev, [path]: value }))
    setDirty(true)
    setMessage('')
  }

  /** 保存：只提交变过的字段。 */
  const save = async (): Promise<void> => {
    if (form === undefined) return
    const patch = draftToPatch(draft, baseline)
    const sections = Object.keys(patch)
    if (sections.length === 0) {
      setMessage('没有改动')
      return
    }
    setBusy(true)
    try {
      // 逐字段 set：契约是「串行排队 + 各自带最新修订号」，
      // 用 mutate 一次性提交也可以，但逐字段能精确定位哪个被拒。
      const rejected: string[] = []
      for (const section of sections) {
        const sectionPatch = patch[section] ?? {}
        for (const [key, value] of Object.entries(sectionPatch)) {
          const field = section + '.' + key
          const accepted = await form.set(field, value)
          if (!accepted) rejected.push(field)
        }
      }
      if (rejected.length === 0) {
        setMessage('已保存')
        setDirty(false)
        setBaseline(state?.value)
      } else {
        setMessage('以下字段被宿主拒绝：' + rejected.join('、'))
      }
    } catch (error) {
      setMessage('保存失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  /** 放弃改动。 */
  const reset = (): void => {
    setDraft(snapshotToDraft(state?.value, controls))
    setBaseline(state?.value)
    setDirty(false)
    setMessage('')
  }

  // ── 表单视图 ──
  const bySection = new Map<string, Control[]>()
  for (const c of controls) {
    const list = bySection.get(c.section) ?? []
    list.push(c)
    bySection.set(c.section, list)
  }

  return (
    <div>
      <p style={hintStyle}>
        端点与凭据必须显式填写。留空时评审会在发出任何请求之前失败，不会隐式调用任何默认端点。
      </p>

      {SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => (
        <section key={section} style={{ marginTop: '18px' }}>
          <h4 style={{ margin: '0 0 10px', fontSize: '13px' }}>{SECTION_LABELS[section] ?? section}</h4>
          {(bySection.get(section) ?? []).map((c) => {
            const value = draft[c.path]
            if (c.kind === 'boolean') {
              return (
                <div key={c.path} style={fieldStyle}>
                  <label style={{ ...labelStyle, display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={value === true}
                      disabled={readOnly || busy}
                      onChange={(e) => edit(c.path, e.target.checked)}
                    />
                    {c.label}
                  </label>
                  {c.hint !== '' && <span style={hintStyle}>{c.hint}</span>}
                </div>
              )
            }
            if (c.options !== undefined) {
              return (
                <div key={c.path} style={fieldStyle}>
                  <label style={labelStyle}>{c.label}</label>
                  <select
                    style={inputStyle}
                    value={typeof value === 'string' ? value : ''}
                    disabled={readOnly || busy}
                    onChange={(e) => edit(c.path, e.target.value)}
                  >
                    {c.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {c.hint !== '' && <span style={hintStyle}>{c.hint}</span>}
                </div>
              )
            }
            return (
              <div key={c.path} style={fieldStyle}>
                <label style={labelStyle}>{c.label}</label>
                <input
                  style={inputStyle}
                  type={c.kind === 'number' ? 'number' : 'text'}
                  value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
                  disabled={readOnly || busy}
                  {...(c.min === undefined ? {} : { min: c.min })}
                  {...(c.max === undefined ? {} : { max: c.max })}
                  onChange={(e) => {
                    if (c.kind === 'number') {
                      const n = Number(e.target.value)
                      edit(c.path, Number.isFinite(n) ? n : 0)
                    } else {
                      edit(c.path, e.target.value)
                    }
                  }}
                />
                {c.hint !== '' && <span style={hintStyle}>{c.hint}</span>}
              </div>
            )
          })}
        </section>
      ))}

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '18px' }}>
        <button type="button" disabled={readOnly || busy || !dirty} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" disabled={busy || !dirty} onClick={reset}>放弃改动</button>
        {message !== '' && <span style={hintStyle}>{message}</span>}
        {readOnly && <span style={hintStyle}>宿主当前不接受写入</span>}
      </div>
    </div>
  )
}

/** 供测试引用：控件描述。 */
export type { Control }

