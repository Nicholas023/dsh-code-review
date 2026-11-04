// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * sensitive.ts —— 敏感路径识别（内容不送审，但必须点名）。
 *
 * 产品语义（用户 2026-10-12 拍板，不允许静默）：
 *  - 敏感文件的**内容一律不送审**，防止评审本身成为二次泄露渠道；
 *  - 但**必须逐个点名**列入报告，提示人工确认是否该提交 ——
 *    「静默排除」会让用户误以为审过了，这比不审更危险。
 *
 * 模式表移植自 0.1.3 的 sensitive-list.js，保留了 issue #11 / #24 两轮
 * 修正带来的全部收敛（那些误报是用真实噪声换来的教训，不能重走一遍）：
 *  - 凭据扩展名必须独立成段：src/key.js / cert.ts / pem.js 是源码，不是凭据
 *  - token 必须是独立词段且有凭据类扩展名：tokenizer.js / design-tokens.md 不算
 *  - 不把裸 pass 当敏感：passenger.json / pass-through.yml 不算
 */

/** 敏感路径模式表（按仓库相对路径匹配，一次命中即敏感）。 */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  // 隐藏文件里基名含 key 的（如 .apikey）
  /(^|\/)\.[^/]*key[^/]*$/i,
  // 点前缀的 secrets 独立词段（.secret / .secrets.yml / .my-secrets）
  /(^|\/)\.([^/]*[.\-_])?secrets?(?=[.\-_]|$)/i,
  // .env 及其变体
  /(^|\/)\.env(\.[^/]+)?$/i,
  // 凭据扩展名（必须独立成段，允许再跟点号修饰如 .key.bak）
  /(^|\/)[^/]*\.(pem|p12|pfx|keystore|jks|cert|crt|key|kdbx|otpkey)(\.[^/]+)?$/i,
  // credentials 开头的基名
  /(^|\/)credentials[^/]*$/i,
  // token 独立词段 + 凭据类扩展名或路径结尾
  /(^|\/)(.*[.\-_])?tokens?(?=[._-]|$)(\.(json|yml|yaml|txt|ini|conf|cfg|config|log|bak|old|tmp|env))?$/i,
  // token 后跟分隔符 + 凭据类扩展名
  /(^|\/)(.*[.\-_])?tokens?[._-][^/]*\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
  // 常见凭据文件：.npmrc / .netrc / .git-credentials
  /(^|\/)\.(npmrc|netrc|git-credentials)$/i,
  // 非隐藏的 secrets / credentials 命名
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  // 私钥文件
  /(^|\/)(.*\.)?(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  // password/passwd/pwd + 凭据类扩展名（不含裸 pass，避免 passenger.json 误报）
  /(^|\/)(.*\.)?(password|passwd|pwd)[^/]*\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
  // pass 作为独立词段 + 凭据类扩展名
  /(^|\/)(.*[.\-_])?pass\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
]

/** 敏感文件原因分类（报告里要说清「为什么点名」）。 */
export type SensitiveReason = 'credential' | 'private-key' | 'env-file' | 'secret-store'

/** 判断路径是否敏感。 */
export function isSensitivePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath === '') return false
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(relPath))
}

/** 把路径归一为正斜杠（git 内部统一用 /，Windows 输入可能带 \\）。 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 从文件清单中筛出敏感文件。
 * @returns 归一化路径数组（去重、保持输入顺序）
 */
export function listSensitiveFiles(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw === '') continue
    const p = normalizePath(raw)
    if (seen.has(p)) continue
    if (!isSensitivePath(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * 生成报告里的敏感点名段落（markdown）。
 *
 * 安全要点：路径不转义直接进反引号会被文件名里的反引号/换行闭合代码块，
 * 进而向报告注入任意 markdown —— 这里先清洗掉全部有意义的标记字符。
 */
export function buildSensitiveBlock(pendingPaths: readonly string[]): string {
  const hits = listSensitiveFiles(pendingPaths)
  if (hits.length === 0) return ''
  const lines = hits.map((p, i) => {
    const safe = p.replace(/[`\r\n*_~#&[\]<>|]+/g, ' ')
    return `${i + 1}. \`${safe}\``
  })
  return [
    '',
    '## ⚠ 敏感文件点名（内容未送审，请人工确认是否该提交）',
    '',
    ...lines,
    '',
    '> 这些文件命中敏感路径模式，其内容未送审。请逐一确认：',
    '> 若包含密钥/凭据/隐私信息，提交 GitHub 前应加入 .gitignore 或剔除。',
  ].join('\n')
}
