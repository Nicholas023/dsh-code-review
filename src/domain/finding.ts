// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * finding.ts —— 一条评审发现的唯一结构定义。
 *
 * 所有下游（Markdown 报告、JSON 报告、会话内清单、去重、脱敏）都消费它，
 * 不允许任何一方另起一套字段。这是「单一真源」规则在数据层的落地。
 *
 * 设计要点：
 *  - **行号可信度显式化**：lineSource 说明这个行号是模型直给的、diff 匹配出的、
 *    还是根本没定位到。编辑器跳转和「这条评论该挂哪个行」都依赖它，
 *    不能把 unresolved 伪装成 exact。
 *  - **evidence 不等于原文粘贴**：它是给人看的证据摘要，敏感内容必须脱敏后再进，
 *    否则报告本身就成了泄露渠道。
 *  - **fingerprint 与 id 分离**：id 标识「这一次的这条发现」，fingerprint 标识
 *    「同一个问题」（跨运行、跨 agent），去重靠后者。
 */

/** 发现类别，对应三条固定评审视角 + 敏感文件点名。 */
export type FindingCategory =
  | 'security'     // 安全漏洞（注入、越权、不安全的反序列化等）
  | 'privacy'      // 脱敏问题（硬编码密钥、口令、PII、内部信息外泄）
  | 'bug'          // 正确性缺陷（逻辑、边界、异常、并发）
  | 'redundancy'   // 冗余代码（重复实现、死代码、无效分支）
  | 'scope-creep'  // 与任务无关的改动
  | 'sensitive-file' // 敏感文件点名（内容不送审，仅提示检查是否该提交）

/** 严重度。用于排序与聚合复核的优先级判断。 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/**
 * 行号来源，决定这条发现的可信度。
 *  - exact         ：模型给出的位置直接落在新增/修改行上
 *  - diff-resolved ：模型没给准，但证据片段在 diff hunk 中唯一匹配到了
 *  - file-resolved ：diff 里匹配不到，退到当前文件内容中唯一匹配到
 *  - unresolved    ：无法定位（多处匹配或完全没有证据），必须显式暴露
 */
export type LineSource = 'exact' | 'diff-resolved' | 'file-resolved' | 'unresolved'

/** 发现的状态（供聚合阶段与人工复核使用）。 */
export type FindingStatus =
  | 'confirmed'  // 已确认为真实问题
  | 'uncertain'  // 存疑，需要更多上下文或人工判断
  | 'suppressed' // 被确定性证伪或聚合复核排除

/** 一条评审发现。 */
export interface Finding {
  /** 本次运行内的稳定标识（内容哈希派生）。 */
  readonly id: string
  /** 仓库相对路径（正斜杠，已规范化）。 */
  readonly path: string
  /** 起始行（1 基）；unresolved 时为 null。 */
  readonly lineStart: number | null
  /** 结束行（1 基，含）；单行时与 lineStart 相同。 */
  readonly lineEnd: number | null
  /** 行号可信度来源。 */
  readonly lineSource: LineSource
  /** 类别。 */
  readonly category: FindingCategory
  /** 严重度。 */
  readonly severity: FindingSeverity
  /** 一句话标题（报告清单行）。 */
  readonly title: string
  /** 证据摘要（已脱敏；可以是代码片段或事实描述）。 */
  readonly evidence: string
  /** 为什么这是问题（说理，不是复述现象）。 */
  readonly explanation: string
  /** 建议怎么改（可执行，不空泛）。 */
  readonly recommendation: string
  /** 模型自评置信度 0~1。 */
  readonly confidence: number
  /** 产出这条发现的 agent 标识（main / child-<n>）。 */
  readonly sourceAgent: string
  /** 产出它的子任务 id（主 agent 直接产出时为 null）。 */
  readonly sourceTask: string | null
  /** 命中的规则 id（固定三视角 + 语言规则）。 */
  readonly ruleIds: readonly string[]
  /** 当前状态。 */
  readonly status: FindingStatus
  /** 被抑制时的原因（status=suppressed 时必有）。 */
  readonly suppressionReason: string | null
  /** 跨运行去重指纹（同问题同指纹）。 */
  readonly fingerprint: string
}

/** 严重度排序权重（数字越小越严重，供报告排序）。 */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/** 按严重度升序排序（稳定：同严重度保持原有相对顺序）。 */
export function sortBySeverity(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/**
 * 判断一条发现是否「有位置可挂」。
 * 报告与后续跳转只在 true 时使用行号，否则明确标注「位置未定位」。
 */
export function hasLocation(f: Finding): f is Finding & { lineStart: number; lineEnd: number } {
  return f.lineStart !== null && f.lineEnd !== null && f.lineSource !== 'unresolved'
}
