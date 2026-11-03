// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * settings.test.ts —— 设置描述与页面结构的契约测试。
 *
 * 这两层是「用户在面板上看到的东西」和「实际写进配置的东西」之间的桥。
 * 桥错了，用户改了设置却不生效，或者更糟：保存时把别的字段清空。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults.js'
import { CONFIG_FIELDS, Config, configObject, editable, readonlyField } from '../../src/settings/schema.js'
import { GROUPS, isEnabled, patchFor, projectGroups, readPath } from '../../src/panel/row-schema.js'

describe('字段描述', () => {
  it('editable 标记 volatile 并带说明', () => {
    const f = editable('string', '说明')
    expect(f.meta?.volatile).toBe(true)
    expect(f.meta?.description).toBe('说明')
  })

  it('readonlyField 不标记 volatile', () => {
    expect(readonlyField('boolean', 'x').meta?.volatile).toBe(false)
  })

  it('每个可编辑字段都有说明文字', () => {
    for (const [section, field] of Object.entries(CONFIG_FIELDS)) {
      if (field.type !== 'object' || field.dict === undefined) continue
      for (const [key, sub] of Object.entries(field.dict)) {
        expect(sub.meta?.description, section + '.' + key + ' 缺说明').toBeTruthy()
      }
    }
  })

  it('配置描述带 Standard Schema 的 validate', () => {
    expect(Config['~standard'].version).toBe(1)
    expect(typeof Config['~standard'].validate).toBe('function')
  })

  it('validate 接受合法配置并归一化', () => {
    const r = Config['~standard'].validate({ review: { model: 'x' } }) as { value?: unknown }
    expect(r.value).toBeTruthy()
    expect((r.value as { review: { model: string } }).review.model).toBe('x')
  })

  it('validate 对非对象返回 issues 而不是抛错', () => {
    const r = Config['~standard'].validate('nope') as { issues?: unknown[] }
    expect(Array.isArray(r.issues)).toBe(true)
  })

  it('configObject 拒绝数组与非对象', () => {
    expect(() => configObject([])).toThrow()
    expect(() => configObject('x')).toThrow()
    expect(configObject(undefined)).toEqual({})
  })
})

describe('页面结构', () => {
  it('每个分组都有 label 与 hint', () => {
    for (const g of GROUPS) {
      expect(g.label).toBeTruthy()
      expect(g.hint).toBeTruthy()
      expect(g.fields.length).toBeGreaterThan(0)
    }
  })

  it('每个字段路径都能在默认配置里读到值（路径没错字）', () => {
    const cfg = DEFAULT_CONFIG as unknown as Record<string, unknown>
    for (const g of GROUPS) {
      for (const f of g.fields) {
        expect(readPath(cfg, f.path), '路径无效：' + f.path.join('.')).not.toBeUndefined()
      }
    }
  })

  it('gatedBy 指向的开关在默认配置里存在', () => {
    const cfg = DEFAULT_CONFIG as unknown as Record<string, unknown>
    for (const g of GROUPS) {
      for (const f of g.fields) {
        if (f.gatedBy === undefined) continue
        expect(readPath(cfg, f.gatedBy)).not.toBeUndefined()
      }
    }
  })
})

describe('读写路径', () => {
  it('readPath 按 section.key 取值', () => {
    expect(readPath({ review: { model: 'm' } }, ['review', 'model'])).toBe('m')
  })

  it('readPath 对缺失分区返回 undefined', () => {
    expect(readPath({}, ['review', 'model'])).toBeUndefined()
  })

  it('patchFor 只含目标路径（不覆盖整份配置）', () => {
    expect(patchFor(['review', 'model'], 'x')).toEqual({ review: { model: 'x' } })
  })
})

describe('门控', () => {
  const off = { execution: { concurrencyEnabled: false, concurrency: 8 } }
  const on = { execution: { concurrencyEnabled: true, concurrency: 8 } }
  const field = GROUPS.find((g) => g.id === 'execution')!.fields.find((f) => f.path[1] === 'concurrency')!

  it('开关关闭时字段不可用', () => {
    expect(isEnabled(off, field)).toBe(false)
  })

  it('开关开启时字段可用', () => {
    expect(isEnabled(on, field)).toBe(true)
  })

  it('没有门控的字段永远可用', () => {
    const plain = GROUPS.find((g) => g.id === 'report')!.fields[0]!
    expect(isEnabled({}, plain)).toBe(true)
  })

  it('分组关闭时其下所有字段都不可用（但值仍在配置里）', () => {
    const projected = projectGroups(off)
    const exec = projected.find((p) => p.group.id === 'execution')!
    expect(exec.enabled).toBe(false)
    const conc = exec.values.find((v) => v.field.path[1] === 'concurrency')!
    expect(conc.enabled).toBe(false)
    // 关键：值没丢，用户重新打开开关时选择还在
    expect(conc.value).toBe(8)
  })

  it('默认配置下投影能拿到全部值', () => {
    const projected = projectGroups(DEFAULT_CONFIG as unknown as Record<string, unknown>)
    expect(projected).toHaveLength(GROUPS.length)
    for (const g of projected) {
      for (const v of g.values) expect(v.value).not.toBeUndefined()
    }
  })
})
