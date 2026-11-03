// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * dedupe.ts —— 发现去重与指纹。
 *
 * 主 agent 和子 agent 会看到同一处代码，重复报告同一个问题。
 * 不做去重，报告里会出现三份一模一样的「这里空指针了」。
 *
 * 去重键的设计要点：
 *  - 必须包含「位置」和「类别」，否则同一行上的两个不同问题会被误合并；
 *  - evidence 要归一化（空白、大小写），否则措辞微差就会漏合并；
 *  - 标题**不参与**指纹 —— 同一问题的标题每次措辞都可能不同。
 *
 * 合并策略：保留置信度更高的那条，但把来源都记下来（可追溯）。
 */

import type { Finding } from '../domain/finding.js'

/** 归一化 evidence 用于指纹。 */
function normalizeEvidence(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200)
}

/**
 * 计算跨运行稳定的指纹。
 * 同一个问题在不同次评审中应得到相同指纹（用于「上次也报过」这类后续能力）。
 */
export function fingerprint(
  path: string,
  line: number | null,
  category: string,
  evidence: string,
): string {
  return [path, line === null ? '?' : String(line), category, normalizeEvidence(evidence)].join('|')
}

/**
 * 去重：同一指纹只保留一条。
 * @returns 去重后的列表（保持首次出现顺序）
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Map<string, Finding>()
  for (const f of findings) {
    const key = f.fingerprint
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, f)
      continue
    }
    // 保留置信度更高、或严重度更高的那条
    if (f.confidence > existing.confidence) {
      seen.set(key, f)
    }
  }
  return [...seen.values()]
}
