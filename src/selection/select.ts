// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * select.ts —— 确定性文件筛选流水线。
 *
 * 设计原则：**每个被排除的文件都必须有 reason code**。
 * 静默排除是评审工具最隐蔽的失败模式 —— 用户看到「没问题」，
 * 却不知道有 30 个文件根本没被看过。报告里要能逐条回答「这个文件为什么没审」。
 *
 * 筛选顺序（固定，可测试；顺序本身有语义，不要随意调换）：
 *   1. 二进制         —— 没有可读文本，无从评审
 *   2. 敏感路径       —— 内容绝不能送审（但要单独点名）
 *   3. 用户 exclude   —— 用户显式排除（如已验证的第三方目录）
 *   4. 默认排除目录   —— node_modules / dist / 构建产物等
 *   5. 不支持的语言   —— 没有对应规则，审了也是泛泛而谈
 *   6. 用户 include   —— 白名单可把「语言不支持」拉回来（但拉不回敏感）
 *   7. 单文件过大     —— 超出预算，交给人或跳过并说明
 */

import type { FileDiff } from '../git/diff-parser.js'
import { isSensitivePath, normalizePath } from './sensitive.js'

/** 排除原因。 */
export type ExcludeReason =
  | 'binary'
  | 'sensitive'
  | 'user-excluded'
  | 'default-excluded-dir'
  | 'unsupported-language'
  | 'too-large'
  | 'deleted'

/** 一个被排除的文件。 */
export interface ExcludedFile {
  readonly path: string
  readonly reason: ExcludeReason
  /** 人读说明（报告里展示）。 */
  readonly detail: string
}

/** 筛选结果。 */
export interface SelectionResult {
  /** 进入评审的文件。 */
  readonly selected: readonly FileDiff[]
  /** 被排除的文件（逐条带原因）。 */
  readonly excluded: readonly ExcludedFile[]
  /** 敏感文件路径（内容未审，但要点名）。 */
  readonly sensitive: readonly string[]
}

/** 筛选选项。 */
export interface SelectionOptions {
  /** 用户排除的路径模式（glob 风格，支持 * 与 **）。 */
  readonly excludePaths: readonly string[]
  /** 用户强制纳入的路径模式。 */
  readonly includePaths?: readonly string[]
  /** 单文件 diff token 上限（超过则排除并说明）。 */
  readonly maxFileTokens: number
  /** 支持的文件扩展名（含点，如 '.ts'）；空数组表示不按语言过滤。 */
  readonly supportedExtensions?: readonly string[]
}

/** 默认排除的目录（依赖、构建产物、缓存）。 */
const DEFAULT_EXCLUDED_DIRS = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'target/',
  'vendor/',
  '.git/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.venv/',
  '__pycache__/',
]

/**
 * 把 glob 模式转成正则（只支持评审场景需要的子集：* ** ?）。
 * 刻意不支持完整 glob —— 缩小语义面便于预测和测试。
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern)
  let out = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // ** 匹配任意层级（含零层）
        out += '.*'
        i += 1
        // 跳过紧随其后的 /（**/ 语义上可匹配空）
        if (normalized[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') { out += '[^/]'; continue }
    // 正则元字符转义
    if ('\\^$.|+()[]{}'.includes(ch)) { out += '\\' + ch; continue }
    out += ch
  }
  return new RegExp('^' + out + '$', 'i')
}

/** 判断路径是否匹配任一 pattern。 */
function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path))
}

/** 取文件扩展名（小写，含点）。 */
function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/**
 * 执行筛选。
 * @param files 从 diff 采集到的文件列表
 * @param opts  筛选选项
 */
export function selectFiles(files: readonly FileDiff[], opts: SelectionOptions): SelectionResult {
  const selected: FileDiff[] = []
  const excluded: ExcludedFile[] = []
  const sensitive: string[] = []
  const seenSensitive = new Set<string>()

  for (const f of files) {
    const path = normalizePath(f.newPath)

    // 1. 已删除文件：没有可评审的新内容（删除本身的风险由「跨文件引用」类发现覆盖）
    if (f.status === 'deleted') {
      excluded.push({ path, reason: 'deleted', detail: '文件已删除，无新增内容可评审' })
      continue
    }

    // 2. 二进制
    if (f.status === 'binary') {
      excluded.push({ path, reason: 'binary', detail: '二进制文件，无法按文本评审' })
      continue
    }

    // 3. 敏感路径：内容不送审，但必须点名
    if (isSensitivePath(path)) {
      excluded.push({ path, reason: 'sensitive', detail: '敏感路径，内容不送审（已在报告中点名）' })
      if (!seenSensitive.has(path)) {
        seenSensitive.add(path)
        sensitive.push(path)
      }
      continue
    }

    // 4. 用户 exclude
    if (matchesAny(path, opts.excludePaths)) {
      excluded.push({ path, reason: 'user-excluded', detail: '命中用户排除规则' })
      continue
    }

    // 5. 默认排除目录
    const inDefaultDir = DEFAULT_EXCLUDED_DIRS.some((d) => path.startsWith(d) || path.includes('/' + d))
    if (inDefaultDir) {
      excluded.push({ path, reason: 'default-excluded-dir', detail: '位于依赖/构建产物目录' })
      continue
    }

    // 6. 语言支持（未命中则看 include 白名单能否拉回）
    const exts = opts.supportedExtensions ?? []
    if (exts.length > 0) {
      const supported = exts.includes(extOf(path))
      const forced = opts.includePaths !== undefined && matchesAny(path, opts.includePaths)
      if (!supported && !forced) {
        excluded.push({ path, reason: 'unsupported-language', detail: `扩展名 ${extOf(path) || '(无)'} 无对应评审规则` })
        continue
      }
    }

    // 7. 单文件预算：用 diff 行数粗估（精确 token 由上层在渲染后计算）
    const approxTokens = estimateFileTokens(f)
    if (approxTokens > opts.maxFileTokens) {
      excluded.push({
        path,
        reason: 'too-large',
        detail: `diff 约 ${approxTokens} tokens，超过单文件上限 ${opts.maxFileTokens}`,
      })
      continue
    }

    selected.push(f)
  }

  return { selected, excluded, sensitive }
}

/**
 * 粗估一个文件 diff 的 token 数（不引入 tokenizer 依赖）。
 * 经验值：英文代码约 3.5 字符/token，中文约 1.5 字符/token；
 * 这里按 3 字符/token 取偏保守估计（宁可高估也不低估预算）。
 */
export function estimateFileTokens(f: FileDiff): number {
  let chars = 0
  for (const h of f.hunks) {
    for (const line of h.lines) chars += line.content.length + 1
  }
  return Math.ceil(chars / 3)
}

/** 供外部复用的 glob 匹配（测试与配置校验用）。 */
export { globToRegExp, matchesAny }
