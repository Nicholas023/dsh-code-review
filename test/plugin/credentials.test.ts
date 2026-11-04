// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * credentials.test.ts —— 凭据解析与内核缓存的契约测试。
 *
 * 这层出错的后果很具体：用户在设置页填了正确的凭据名，第一次评审却报
 * 「凭据未能解析出值」，而且完全看不出为什么。所以要守死三条：
 *  1. 解析顺序：DSH 凭据库优先，环境变量兜底；
 *  2. 名字不合法时给出能照着改的提示（短横线是最常见的错）；
 *  3. 内核读缓存优先于环境变量，且缓存读写是合并语义（多引用不互相覆盖）。
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isValidCredentialRef, resolveCredentialFromHost } from '../../src/plugin/credentials.js'
import {
  readCachedCredential,
  writeCachedCredential,
  listCachedCredentialRefs,
} from '../../src/store/credential-cache.js'
import { resolveCredential } from '../../src/kernel/main.js'
import { credentialCachePath } from '../../src/store/paths.js'

const roots: string[] = []
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dcr-cred-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

/** 服务缺失时的取服务函数（与真实 Cordis 行为一致：返回 undefined，不抛）。 */
const noService = (): undefined => undefined

describe('引用名语法', () => {
  it('接受 POSIX 标识符', () => {
    expect(isValidCredentialRef('COMMANDCODE_API_KEY')).toBe(true)
    expect(isValidCredentialRef('_x1')).toBe(true)
  })

  it('拒绝短横线（最常见的手误）', () => {
    expect(isValidCredentialRef('command-code-api')).toBe(false)
  })

  it('拒绝空格与空串', () => {
    expect(isValidCredentialRef('')).toBe(false)
    expect(isValidCredentialRef('A B')).toBe(false)
  })
})

describe('解析顺序', () => {
  it('DSH 凭据库优先于环境变量', async () => {
    const getService = (name: string) =>
      name === 'credentials' ? { resolve: async () => ({ value: 'from-store' }) } : undefined
    const r = await resolveCredentialFromHost(getService, 'COMMANDCODE_API_KEY', {
      COMMANDCODE_API_KEY: 'from-env',
    })
    expect(r.value).toBe('from-store')
    expect(r.source).toBe('credentials')
  })

  it('凭据库没有时退回环境变量', async () => {
    const getService = (name: string) => (name === 'credentials' ? { resolve: async () => undefined } : undefined)
    const r = await resolveCredentialFromHost(getService, 'COMMANDCODE_API_KEY', {
      COMMANDCODE_API_KEY: 'from-env',
    })
    expect(r.value).toBe('from-env')
    expect(r.source).toBe('env')
  })

  it('服务不可用时只走环境变量，不报错', async () => {
    const r = await resolveCredentialFromHost(noService, 'X_KEY', { X_KEY: 'v' })
    expect(r.value).toBe('v')
    expect(r.source).toBe('env')
  })

  it('服务返回空字符串视为未配置（空值不能冒充已配置）', async () => {
    const getService = (name: string) => (name === 'credentials' ? { resolve: async () => ({ value: '   ' }) } : undefined)
    const r = await resolveCredentialFromHost(getService, 'X_KEY', {})
    expect(r.value).toBeNull()
    expect(r.source).toBe('none')
  })

  it('服务抛错时不让整个提交失败', async () => {
    const getService = (name: string) =>
      name === 'credentials' ? { resolve: async () => { throw new Error('store locked') } } : undefined
    const r = await resolveCredentialFromHost(getService, 'X_KEY', {})
    expect(r.value).toBeNull()
    expect(r.detail).toContain('store locked')
  })
})

describe('失败提示要能照着改', () => {
  it('名字带短横线时明确指出不能有短横线', async () => {
    const r = await resolveCredentialFromHost(noService, 'command-code-api', {})
    expect(r.value).toBeNull()
    expect(r.detail).toContain('短横线')
    expect(r.detail).toContain('command-code-api')
  })

  it('找不到时说明两处都查过了', async () => {
    const r = await resolveCredentialFromHost(noService, 'MISSING_KEY', {})
    expect(r.detail).toContain('凭据库')
    expect(r.detail).toContain('环境变量')
  })

  it('空引用单独说明', async () => {
    const r = await resolveCredentialFromHost(noService, '   ', {})
    expect(r.detail).toContain('为空')
  })
})

describe('内核缓存文件', () => {
  it('写进去能读回来', () => {
    const root = tempRoot()
    writeCachedCredential(root, 'COMMANDCODE_API_KEY', 'sk-test-value')
    expect(readCachedCredential(root, 'COMMANDCODE_API_KEY')).toBe('sk-test-value')
    expect(listCachedCredentialRefs(root)).toEqual(['COMMANDCODE_API_KEY'])
  })

  it('合并写入不会抹掉别的引用', () => {
    const root = tempRoot()
    writeCachedCredential(root, 'A_KEY', 'a')
    writeCachedCredential(root, 'B_KEY', 'b')
    expect(readCachedCredential(root, 'A_KEY')).toBe('a')
    expect(readCachedCredential(root, 'B_KEY')).toBe('b')
  })

  it('POSIX 上是 0600；Windows 上不靠 mode 保护', () => {
    const root = tempRoot()
    writeCachedCredential(root, 'K', 'v')
    const mode = statSync(credentialCachePath(root)).mode & 0o777
    if (process.platform === 'win32') {
      // Windows 忽略 Node 的 mode（实测落成 0666）。保护来自 ~/.dsh 的 ACL 继承，
      // 已实机比对过：与 DSH 自己的 .credentials.yaml 完全一致。
      // 这里只断言文件确实落在 DSH 数据根之下，不冒充「权限收紧了」。
      expect(credentialCachePath(root).startsWith(root)).toBe(true)
    } else {
      expect(mode & 0o077).toBe(0o000)
    }
  })

  it('文件里带版本与时间，便于排查', () => {
    const root = tempRoot()
    writeCachedCredential(root, 'K', 'v')
    const json = JSON.parse(readFileSync(credentialCachePath(root), 'utf8')) as {
      version: number
      updatedAt: string
      refs: Record<string, string>
    }
    expect(json.version).toBe(1)
    expect(typeof json.updatedAt).toBe('string')
    expect(json.refs.K).toBe('v')
  })

  it('文件损坏时读回 null 而不是抛错', () => {
    const root = tempRoot()
    const file = credentialCachePath(root)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ 坏掉的 json', 'utf8')
    expect(readCachedCredential(root, 'K')).toBeNull()
  })

  it('没有该引用时返回 null', () => {
    const root = tempRoot()
    writeCachedCredential(root, 'A_KEY', 'a')
    expect(readCachedCredential(root, 'B_KEY')).toBeNull()
  })
})

describe('内核侧解析', () => {
  it('缓存优先于环境变量', () => {
    const root = tempRoot()
    writeCachedCredential(root, 'COMMANDCODE_API_KEY', 'from-cache')
    const value = resolveCredential('COMMANDCODE_API_KEY', {
      dshRoot: root,
      env: { COMMANDCODE_API_KEY: 'from-env' },
    })
    expect(value).toBe('from-cache')
  })

  it('缓存没有时退回环境变量', () => {
    const root = tempRoot()
    const value = resolveCredential('COMMANDCODE_API_KEY', {
      dshRoot: root,
      env: { COMMANDCODE_API_KEY: 'from-env' },
    })
    expect(value).toBe('from-env')
  })

  it('两处都没有时返回 null', () => {
    const root = tempRoot()
    expect(resolveCredential('NOPE_KEY', { dshRoot: root, env: {} })).toBeNull()
  })

  it('空引用直接返回 null', () => {
    const root = tempRoot()
    expect(resolveCredential('  ', { dshRoot: root, env: {} })).toBeNull()
  })
})
