// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * sensitive.test.ts —— 敏感路径识别的回归测试。
 *
 * 正例来自「必须拦住」的真实凭据形态；反例全部来自 0.1.3 修过的误报
 * （issue #11 / #24）。误报的代价是噪声淹没真信号，所以反例和正例同等重要。
 */

import { describe, expect, it } from 'vitest'
import { buildSensitiveBlock, isSensitivePath, listSensitiveFiles } from '../../src/selection/sensitive.js'

describe('敏感路径：必须命中', () => {
  const positives = [
    '.env',
    '.env.production',
    'config/.env.local',
    'deploy/id_rsa',
    'deploy/id_ed25519',
    'certs/server.pem',
    'certs/client.p12',
    'keys/app.key',
    'keystore.jks',
    'credentials.yml',
    'src/credentials.json',
    'secrets/prod.yaml',
    'token.json',
    'config/refresh_token_backup.json',
    '.npmrc',
    '.git-credentials',
    'db.pass.yml',
    'password.txt',
  ]
  for (const p of positives) {
    it(`命中：${p}`, () => {
      expect(isSensitivePath(p)).toBe(true)
    })
  }
})

describe('敏感路径：不得误报（issue #11 / #24 回归）', () => {
  const negatives = [
    // 源码文件带 key/cert/pem 字样
    'src/key.js',
    'src/key.ts',
    'src/cert.ts',
    'src/pem.js',
    'lib/sessionkey.go',
    'lib/keycmd.go',
    // token 作为词前缀的业务文件
    'src/tokenizer.js',
    'src/token-utils/index.js',
    'docs/design-tokens.md',
    'src/tokens.ts',
    'src/tokenizer-decoder.yml',
    // 裸 pass 误报
    'src/passenger.json',
    'config/pass-through.yml',
    'src/pass.ts',
    // 普通源码
    'src/index.ts',
    'README.md',
    'package.json',
  ]
  for (const p of negatives) {
    it(`不误报：${p}`, () => {
      expect(isSensitivePath(p)).toBe(false)
    })
  }
})

describe('清单筛选', () => {
  it('去重并归一化反斜杠路径', () => {
    const out = listSensitiveFiles(['.env', 'config\\.env', 'src/a.ts', '.env'])
    expect(out).toEqual(['.env', 'config/.env'])
  })

  it('过滤非字符串与空串（脏数据不进入点名单）', () => {
    const out = listSensitiveFiles(['', '  ', 'token.json'] as unknown as string[])
    expect(out).toEqual(['token.json'])
  })
})

describe('点名块生成', () => {
  it('无命中时返回空串', () => {
    expect(buildSensitiveBlock(['src/a.ts'])).toBe('')
  })

  it('命中时生成带标题的 markdown 段落', () => {
    const block = buildSensitiveBlock(['.env'])
    expect(block).toContain('敏感文件点名')
    expect(block).toContain('.env')
    expect(block).toContain('未送审')
  })

  it('路径中的 markdown 标记被清洗（防报告注入）', () => {
    const block = buildSensitiveBlock(['`token.json`'])
    expect(block).not.toContain('``')
  })
})
