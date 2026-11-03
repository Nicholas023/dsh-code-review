// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * report.test.ts —— 行号定位、去重、脱敏、双写报告的契约测试。
 *
 * 这几块共同决定「报告可不可信」：
 *  - 行号定位错了 → 用户点进去看不到问题
 *  - 去重失效   → 同一问题报三遍，噪声淹没信号
 *  - 脱敏失效   → 报告本身成了泄露载体
 *  - 双写不一致 → 机器读的和人读的对不上
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Finding } from '../../src/domain/finding.js'
import type { FileDiff } from '../../src/git/diff-parser.js'
import { dedupeFindings, fingerprint } from '../../src/report/dedupe.js'
import { resolveLocation } from '../../src/report/line-resolver.js'
import { redact, redactDeep } from '../../src/report/redact.js'
import { renderMarkdown } from '../../src/report/markdown.js'
import type { ReviewReport } from '../../src/report/schema.js'
import { expandHome, validateReportDir, writeReport } from '../../src/report/writer.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

/** 造一个含新增行的 diff。 */
function diff(path = 'a.ts'): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified',
    hunks: [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, header: '',
      lines: [
        { type: 'context', content: 'const keep = 1', oldLine: 1, newLine: 1 },
        { type: 'del', content: 'const bad = null', oldLine: 2, newLine: null },
        { type: 'add', content: 'const good = compute()', oldLine: null, newLine: 2 },
        { type: 'add', content: 'return good.value', oldLine: null, newLine: 3 },
      ],
    }],
    additions: 2,
    deletions: 1,
  }
}

/** 造一条 finding。 */
function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1', path: 'a.ts', lineStart: 2, lineEnd: 2, lineSource: 'exact',
    category: 'bug', severity: 'high', title: 't', evidence: 'e', explanation: 'x',
    recommendation: 'r', confidence: 0.8, sourceAgent: 'main', sourceTask: null,
    ruleIds: [], status: 'confirmed', suppressionReason: null,
    fingerprint: 'a.ts|2|bug|e',
    ...overrides,
  }
}

describe('行号定位', () => {
  it('落在新增行时 exact', () => {
    expect(resolveLocation(diff(), 2, '')).toMatchObject({ lineStart: 2, lineSource: 'exact' })
  })

  it('落在删除行上不算 exact（那行已不存在）', () => {
    const r = resolveLocation(diff(), 99, 'const bad = null')
    expect(r.lineSource).not.toBe('exact')
  })

  it('行号不准但证据唯一匹配时 diff-resolved', () => {
    const r = resolveLocation(diff(), null, 'return good.value')
    expect(r.lineSource).toBe('diff-resolved')
    expect(r.lineStart).toBe(3)
  })

  it('证据太短不参与匹配（避免误定位）', () => {
    const r = resolveLocation(diff(), null, 'x')
    expect(r.lineSource).toBe('unresolved')
  })

  it('没有 diff 时一律 unresolved', () => {
    expect(resolveLocation(undefined, 5, 'anything long enough')).toMatchObject({
      lineStart: null,
      lineSource: 'unresolved',
    })
  })
})

describe('去重', () => {
  it('同指纹只保留一条', () => {
    const a = finding({ id: 'a', confidence: 0.6 })
    const b = finding({ id: 'b', confidence: 0.9 })
    const out = dedupeFindings([a, b])
    expect(out).toHaveLength(1)
    // 保留置信度更高的
    expect(out[0]!.id).toBe('b')
  })

  it('位置不同不合并', () => {
    const out = dedupeFindings([finding({ id: 'a' }), finding({ id: 'b', lineStart: 3, fingerprint: 'a.ts|3|bug|e' })])
    expect(out).toHaveLength(2)
  })

  it('类别不同不合并（同一行可能有两个不同问题）', () => {
    const out = dedupeFindings([finding({ id: 'a' }), finding({ id: 'b', category: 'security', fingerprint: 'a.ts|2|security|e' })])
    expect(out).toHaveLength(2)
  })

  it('指纹对空白与大小写不敏感', () => {
    const a = fingerprint('a.ts', 2, 'bug', 'Const X =  1')
    const b = fingerprint('a.ts', 2, 'bug', 'const x = 1')
    expect(a).toBe(b)
  })
})

describe('脱敏', () => {
  it('Bearer token 被替换', () => {
    const out = redact('Authorization: Bearer abcdefghijklmnop123456')
    expect(out).not.toContain('abcdefghijklmnop123456')
    expect(out).toContain('[REDACTED]')
  })

  it('URL 内嵌凭据被替换', () => {
    const out = redact('postgres://user:supersecret@db.local/x')
    expect(out).not.toContain('supersecret')
  })

  it('赋值形态的密钥被替换', () => {
    const out = redact('const apiKey = "sk-abcdefghijklmnopqrstuv"')
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuv')
  })

  it('私钥块被整体替换', () => {
    const out = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')
    expect(out).not.toContain('MIIEow')
  })

  it('普通代码不被误伤', () => {
    const code = 'function add(a, b) { return a + b }'
    expect(redact(code)).toBe(code)
  })

  it('redactDeep 处理嵌套结构', () => {
    const out = redactDeep({ a: ['Bearer 123456789012345678'], b: { c: 'ok' } })
    expect(out.a[0]).not.toContain('123456789012345678')
    expect(out.b.c).toBe('ok')
  })
})

describe('Markdown 渲染', () => {
  /** 造一份最小报告。 */
  function report(over: Partial<ReviewReport> = {}): ReviewReport {
    return {
      schemaVersion: 1,
      generatedAt: '2026-11-04T00:00:00.000Z',
      run: { taskId: 't1', kernelVersion: '0.2.0', protocolVersion: 1 },
      model: { id: 'deepseek-flash', endpointHost: 'api.deepseek.com' },
      repository: { path: 'D:/repo', command: 'review', mode: 'uncommitted', baseRef: null, headRef: null, commit: null },
      hashes: { systemPrompt: 'abc' },
      status: 'completed',
      findings: [],
      sensitiveFiles: [],
      excluded: [],
      coverage: { reviewed: 3, total: 3 },
      sizing: { tier: 'small', totalTokens: 1000, fileCount: 3 },
      agents: [{ name: 'main', stopReason: 'finished', rounds: 1 }],
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, requests: 1, agents: 1 },
      warnings: [],
      elapsedSec: 1.5,
      ...over,
    }
  }

  it('无问题时明确写「未发现问题」', () => {
    expect(renderMarkdown(report())).toContain('未发现问题')
  })

  it('有问题时按严重度排序', () => {
    const md = renderMarkdown(report({
      findings: [finding({ severity: 'low', title: '低危' }), finding({ severity: 'critical', title: '高危' })],
    }))
    expect(md.indexOf('高危')).toBeLessThan(md.indexOf('低危'))
  })

  it('未完成时给出醒目警告', () => {
    const md = renderMarkdown(report({ status: 'partial' }))
    expect(md).toContain('未完整完成')
  })

  it('敏感文件被点名', () => {
    const md = renderMarkdown(report({ sensitiveFiles: ['.env'] }))
    expect(md).toContain('.env')
    expect(md).toContain('内容未送审')
  })

  it('未覆盖文件被列出（不制造虚假安全感）', () => {
    const md = renderMarkdown(report({
      excluded: [{ path: 'big.ts', reason: 'too-large', detail: '太大' }],
    }))
    expect(md).toContain('未覆盖')
    expect(md).toContain('big.ts')
  })

  it('位置未定位时明确标注', () => {
    const md = renderMarkdown(report({
      findings: [finding({ lineStart: null, lineSource: 'unresolved' })],
    }))
    expect(md).toContain('位置未定位')
  })
})

describe('报告落盘', () => {
  it('expandHome 展开 ~', () => {
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'))
  })

  it('拒绝 home 之外的目录（防任意位置写入）', () => {
    expect(validateReportDir('C:/Windows/System32')).not.toBeNull()
  })

  it('拒绝相对路径', () => {
    expect(validateReportDir('reports')).not.toBeNull()
  })

  it('接受 home 下的绝对路径', () => {
    expect(validateReportDir(join(homedir(), 'reports'))).toBeNull()
  })

  it('双写成功且两份内容一致可读', () => {
    const home = mkdtempSync(join(homedir(), '.dcr-test-'))
    dirs.push(home)
    const r = writeReport({
      directory: home,
      repoName: 'my-repo',
      baseName: 'run-1',
      markdown: '# 报告',
      json: '{"ok":true}',
    })
    expect(r.errors).toHaveLength(0)
    expect(r.markdownPath).not.toBeNull()
    expect(r.jsonPath).not.toBeNull()
    expect(readFileSync(r.markdownPath!, 'utf8')).toBe('# 报告')
    expect(JSON.parse(readFileSync(r.jsonPath!, 'utf8'))).toEqual({ ok: true })
  })

  it('非法目录时不写文件并给出原因', () => {
    const r = writeReport({
      directory: 'C:/Windows/System32',
      repoName: 'x',
      baseName: 'y',
      markdown: 'a',
      json: 'b',
    })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.markdownPath).toBeNull()
  })
})
