// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * redact.ts —— 报告输出前的最后一道脱敏。
 *
 * 为什么已经「不送审」了还要脱敏：评审工具自己会复制代码片段进报告。
 * 如果片段里恰好有一行硬编码密钥，报告文件就成了泄露载体 ——
 * 而且它还会被提交到仓库或发到聊天里。
 *
 * 策略：
 *  - 识别常见的「值形态」（长随机串、Bearer token、连接串里的密码）
 *  - 只保留类型与位置，值替换为固定占位符
 *  - 宁可多脱敏，也不要漏 —— 误伤一个代码片段远好于泄露一个密钥
 */

/** 替换占位符。 */
const MASK = '[REDACTED]'

/** 一条脱敏规则：匹配 + 用捕获组重建（保留可读上下文，只盖住值）。 */
interface RedactRule {
  readonly name: string
  readonly re: RegExp
  /** match 为整段命中，groups 为捕获组；返回替换后的文本。 */
  readonly rebuild: (match: string, groups: readonly string[]) => string
}

/** 规则顺序有意义：先具体后宽泛，避免宽泛规则吃掉上下文。 */
const RULES: readonly RedactRule[] = [
  // Bearer / Basic 认证头：保留前缀，盖住凭据
  {
    name: 'auth-header',
    re: /(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}=*/g,
    rebuild: (_m, g) => (g[0] ?? '') + ' ' + MASK,
  },
  // URL 内嵌凭据：scheme://user:pass@host
  {
    name: 'url-credential',
    re: /(\/\/)[^:\/\s@]+:[^@\/\s]+@/g,
    rebuild: (_m, g) => (g[0] ?? '') + MASK + '@',
  },
  // key = "长随机串"：保留左值与引号，盖住值
  {
    name: 'assignment',
    re: /((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key)\s*[=:]\s*['"]?)([A-Za-z0-9._~+\/-]{16,})(['"]?)/gi,
    rebuild: (_m, g) => (g[0] ?? '') + MASK + (g[2] ?? ''),
  },
  // 私钥块整体替换
  {
    name: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    rebuild: () => '-----BEGIN PRIVATE KEY-----' + MASK + '-----END PRIVATE KEY-----',
  },
  // 高熵长串（32 位以上字母数字）
  {
    name: 'high-entropy',
    re: /(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g,
    rebuild: () => MASK,
  },
]

/**
 * 对一段文本做脱敏。
 * @returns 脱敏后的文本（未命中则原样返回）
 */
export function redact(text: string): string {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = String(args[0] ?? '')
      // replace 回调的尾部两个参数是 offset 与整段输入，捕获组在其间
      const groups = args.slice(1, Math.max(1, args.length - 2)).map((g) => (typeof g === 'string' ? g : ''))
      return rule.rebuild(match, groups)
    })
  }
  return out
}

/** 脱敏一个对象的全部字符串字段（递归，够报告用）。 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v)
    return out as T
  }
  return value
}
