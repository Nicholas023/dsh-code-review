// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * review.ts —— 评审规模分档与子 agent 派发的领域模型。
 *
 * 核心问题（来自设计定稿 4.4）：主 agent 的上下文是稀缺资源。
 * 如果让它把所有 diff 正文都读进来，它就看不见「全局」了 —— 而这正是
 * 主 agent 存在的理由（发现接口与实现对不上、改了 A 忘了改 B）。
 *
 * 所以先量规模，再定主 agent 自己查多深：
 *   小档：全部自己看，不给工具（单轮、最省）
 *   中档：看全局 + 派子 agent 深挖
 *   大档：只看结构与摘要，正文全部交给子 agent
 *
 * 量纲选择：用 **diff 的 token 数**，不用文件数。
 * 理由：一个 2000 行的文件和一个 20 行的文件不是一个量级；而 token 数同时
 * 是成本量纲和上下文压力，一个数字能同时回答「贵不贵」和「装不装得下」。
 *
 * 派发规则分两半（用户拍板 C）：
 *   前半 = 这里的确定性规则（可预测、可测试）；
 *   后半 = 主 agent 输出 childRequests 追加（模型判断力）。
 */

/** 规模档位。 */
export type SizeTier = 'small' | 'medium' | 'large'

/** 规模阈值（全部可通过配置覆盖，默认值来自设计定稿）。 */
export interface SizingThresholds {
  /** 小档上界：小于此总 token 数，主 agent 全看，且不给 SDK。 */
  readonly smallTokens: number
  /** 大档下界：大于此总 token 数，主 agent 只看结构与摘要。 */
  readonly largeTokens: number
  /** 单文件改动行数超过此值 → 必须派子 agent。 */
  readonly fileLinesForChild: number
  /** 单文件 diff token 超过此值 → 必须派子 agent。 */
  readonly fileTokensForChild: number
  /** 切片后单任务仍超过此 token 数 → 继续下切。 */
  readonly childTokensMax: number
}

/** 默认阈值。数值来源：设计定稿 4.4（经 grill 确认）。 */
export const DEFAULT_THRESHOLDS: SizingThresholds = {
  smallTokens: 20_000,
  largeTokens: 150_000,
  fileLinesForChild: 400,
  fileTokensForChild: 10_000,
  childTokensMax: 30_000,
}

/**
 * 按总 diff token 数划分档位。
 * @param totalTokens 本次评审所有 diff 的 token 总数
 * @param t 阈值（默认 DEFAULT_THRESHOLDS）
 */
export function classifySize(totalTokens: number, t: SizingThresholds = DEFAULT_THRESHOLDS): SizeTier {
  if (totalTokens < t.smallTokens) return 'small'
  if (totalTokens > t.largeTokens) return 'large'
  return 'medium'
}

/** 主 agent 在该档位下自己读多少。 */
export type MainAgentDepth =
  | 'full'      // 小档：读完所有 diff，不调工具
  | 'global'    // 中档：读完全部 diff，可用工具探索，并派子 agent 深挖
  | 'outline'   // 大档：只读文件清单/变更统计/项目结构，正文交子 agent

/** 档位 → 主 agent 策略。 */
export function mainAgentPolicy(tier: SizeTier): { depth: MainAgentDepth; sdk: boolean } {
  switch (tier) {
    case 'small':
      // 最省路径：一轮，只读 diff，连 SDK 都不声明（省掉那几百 tokens）
      return { depth: 'full', sdk: false }
    case 'medium':
      return { depth: 'global', sdk: true }
    case 'large':
      return { depth: 'outline', sdk: true }
  }
}

/** 单个文件的改动画像（决定是否派子 agent）。 */
export interface FileChangeProfile {
  /** 仓库相对路径。 */
  readonly path: string
  /** 改动行数（新增 + 删除）。 */
  readonly changedLines: number
  /** diff 文本的 token 估算。 */
  readonly diffTokens: number
  /** 是否命中敏感路径（敏感文件只派「路径审查」，不发送正文）。 */
  readonly sensitive: boolean
  /** 是否属于横向影响文件（接口/类型定义/配置）。 */
  readonly crossCutting: boolean
}

/** 派发决定。 */
export interface DispatchDecision {
  /** 是否需要子 agent 深挖。 */
  readonly dispatch: boolean
  /** 触发原因（可多条；报告里会展示，便于解释为什么要多花钱）。 */
  readonly reasons: readonly string[]
}

/**
 * 确定性派发规则（用户拍板 C 的前半）。
 * 命中任一条件即派子 agent；没有命中就不派 —— 主 agent 仍可追加（C 的后半）。
 */
export function evaluateDispatch(
  f: FileChangeProfile,
  t: SizingThresholds = DEFAULT_THRESHOLDS,
): DispatchDecision {
  const reasons: string[] = []
  if (f.sensitive) reasons.push('敏感路径：只做路径审查，正文不送审')
  if (f.changedLines > t.fileLinesForChild) reasons.push(`单文件改动 ${f.changedLines} 行 > 阈值 ${t.fileLinesForChild}`)
  if (f.diffTokens > t.fileTokensForChild) reasons.push(`单文件 diff ${f.diffTokens} tokens > 阈值 ${t.fileTokensForChild}`)
  if (f.crossCutting) reasons.push('横向影响文件：接口/类型/配置改动会波及多处')
  return { dispatch: reasons.length > 0, reasons }
}

/**
 * 判断一个切片是否还需继续下切。
 * 用于大档 scan：模块切成子任务后，若单任务仍超预算，继续按语言/文件簇/行区间切。
 */
export function needsFurtherSplit(sliceTokens: number, t: SizingThresholds = DEFAULT_THRESHOLDS): boolean {
  return sliceTokens > t.childTokensMax
}

/** 评审范围（内核执行的输入契约，与 TaskScope 同构但更贴近内核）。 */
export interface ReviewScope {
  readonly repoPath: string
  readonly command: 'review' | 'scan'
  readonly mode: 'uncommitted' | 'branch' | 'commit' | null
  readonly baseRef: string | null
  readonly headRef: string | null
  readonly commit: string | null
  readonly focus: string | null
  readonly excludePaths: readonly string[]
}
