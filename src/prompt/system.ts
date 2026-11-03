// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * system.ts —— 稳定前缀（system prompt）的组装。
 *
 * 这是 0.2.0 针对 DeepSeek 缓存做的关键设计。对比 0.1.3（OCR）：
 *  上游把规则放在 **diff 之后** 的 user 消息里，于是跨文件组时前缀必然不同，
 *  规则那几千 token 一次都命中不了缓存。
 *
 * 这里把一切跨任务不变的东西放进 system，且保证逐字节稳定：
 *  角色 → 三条固定规则 → 语言规则 → SDK 声明 → 输出格式 → 结束条件
 *
 * 稳定性要求（违反任何一条都会让缓存命中率归零）：
 *  - 不插入时间戳、task id、绝对路径等每次变化的内容；
 *  - 规则块按 id 排序（不是按输入顺序）；
 *  - SDK 声明按工具名排序；
 *  - 数字与阈值用固定格式，不做本地化。
 */

import { createHash } from 'node:crypto'
import type { MainAgentDepth } from '../domain/review.js'

/** 组装参数。 */
export interface SystemPromptInput {
  /** 规则文本（来自 prompt/rules.ts 的 resolveRules）。 */
  readonly rules: string
  /** 主 agent 的探索深度（决定给不给 SDK）。 */
  readonly depth: MainAgentDepth
}

/** 角色与不可违反的约束（永远在最前）。 */
const ROLE_BLOCK = [
  '# 角色',
  '',
  '你是代码评审助手。你的职责是发现代码变更中的真实问题，并给出可直接执行的修改建议。',
  '',
  '## 不可违反的约束',
  '',
  '- **你只做评审，绝不修改代码、绝不执行写操作。** 你没有任何写入能力。',
  '- 只评审本次变更涉及的文件（清单在任务消息里给出），不要评审未变更的代码。',
  '- 不确定就不要断言。宁可标注为存疑，也不要编造一个看起来合理的结论。',
  '- 不要为了凑数而报告问题。没有问题就返回空的 findings —— 这是完全正常的结论。',
  '- 不要在注释、变量名、文档字符串上纠缠，除非它造成了真实的误导或安全隐患。',
].join('\n')

/** 输出格式（结构化 JSON，便于确定性解析）。 */
const OUTPUT_BLOCK = [
  '## 输出格式',
  '',
  '最后必须调用 finish 工具返回结构化结果，字段如下：',
  '',
  '~~~ts',
  'finish({',
  '  findings: Array<{',
  '    path: string              // 仓库相对路径，必须来自任务消息给的文件清单',
  '    line: number | null       // 1 基行号；无法确定就传 null',
  '    category: "security" | "privacy" | "bug" | "redundancy" | "scope-creep"',
  '    severity: "critical" | "high" | "medium" | "low" | "info"',
  '    title: string             // 一句话说清问题',
  '    evidence: string          // 支撑判断的代码片段或事实（不超过 300 字）',
  '    explanation: string       // 为什么这是问题',
  '    recommendation: string    // 怎么改',
  '    confidence: number        // 0 到 1',
  '  }>',
  '  needsMoreContext: string[]  // 需要更多上下文才能判断的点（可为空）',
  '  childRequests: Array<{      // 需要深入排查的子任务（可为空）',
  '    reason: string',
  '    files: string[]',
  '    question: string',
  '  }>',
  '})',
  '~~~',
  '',
  '- line 必须尽量精确：指出**新增或修改的那一行**，不是整个函数。',
  '- evidence 只放必要的几行，不要整段复制。',
].join('\n')

/** SDK 声明（按深度决定给不给）。 */
function sdkBlock(depth: MainAgentDepth): string {
  if (depth === 'full') {
    return [
      '## 上下文工具',
      '',
      '本次变更规模很小，你可以直接依据给出的 diff 完成评审，**不需要调用任何工具**。',
    ].join('\n')
  }
  return [
    '## 上下文工具（通过 run_code 调用）',
    '',
    '你不能直接调用文件工具。你写一段 TypeScript 程序，程序内部通过 tools 对象访问只读能力：',
    '',
    '~~~ts',
    '// 读取文件的一段（默认 64 行，最多 512 行）',
    'tools.read({ path: "src/a.ts", offset?: number, limit?: number })',
    '//   返回 { status, data: { path, lines: [{ n, text }], totalLines }, coverage?, continuation? }',
    '',
    '// 按模式匹配文件（支持 * 和 ** 和 ?）',
    'tools.glob({ patterns: ["src/**/*.ts"], exclude?: string[], maxResults?: number })',
    '//   返回 { status, data: { files: string[], scanned: number } }',
    '',
    '// 在指定文件里搜索正则',
    'tools.grep({ pattern: "TODO", files: ["src/a.ts"], ignoreCase?: boolean, maxResults?: number })',
    '//   返回 { status, data: { matches: [{ path, line, text }], searched } }',
    '~~~',
    '',
    '**关键**：status 可能是 partial。当它是 partial 时，data 仍然可用，',
    '但 coverage 会告诉你缺了什么，continuation 告诉你如何接着读。',
    '拿到 partial 却当成完整内容下结论，是这类评审最常见的错误 —— 不要犯。',
  ].join('\n')
}

/** 结束条件（让模型知道什么时候该停）。 */
const STOP_BLOCK = [
  '## 什么时候结束',
  '',
  '- 已经看完本次变更，并能给出结论时，立即调用 finish。',
  '- 发现某个区域需要更深的上下文，且满足「值得深挖」的判断时，放进 childRequests。',
  '- 不要反复读同一个文件。读两次没得到新信息，就应该停止。',
].join('\n')

/**
 * 组装稳定的 system prompt。
 *
 * 本函数必须是**纯函数**：同样的输入永远产出同样的字符串。
 * 任何随机性、时间、环境差异都会让缓存失效。
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  return [
    ROLE_BLOCK,
    input.rules,
    sdkBlock(input.depth),
    OUTPUT_BLOCK,
    STOP_BLOCK,
  ].join('\n\n')
}


/**
 * 计算文本的稳定哈希（用于验证「同一规则下 system 前缀是否逐字节一致」）。
 *
 * 这不是为了安全，而是为了**可验证**：报告里记录 system 哈希，
 * 就能事后对照「这次和上次的稳定前缀是否相同」。
 * 若两次评审的规则与深度相同，哈希必须相同 —— 否则缓存必然不命中。
 */
export function hashPrompt(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
