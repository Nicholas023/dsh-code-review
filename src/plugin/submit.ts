// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * submit.ts —— 把一次工具/命令调用变成一条任务卡。
 *
 * 这里是**唯一的参数校验点**：工具和 /review 命令都必须走这里。
 * 0.1.3 的教训是「入口早检」与「权威层校验」容易分叉，
 * 于是同一个非法输入在两条路径上有两种表现。现在只有一个函数。
 *
 * 校验原则：
 *  - repo_path 必须是绝对路径（内核是独立进程，没有「当前目录」概念）；
 *  - commit 模式缺 SHA 一律 fail-closed，绝不静默退化成 workspace；
 *  - 模式与参数互斥（branch 才用 base_ref，commit 才用 commit）。
 */

import { isAbsolute } from 'node:path'
import type { ConfigV2 } from '../config/defaults.js'
import { KernelError } from '../domain/errors.js'
import type { TaskScope } from '../domain/task.js'
import { createTask } from '../store/task-store.js'

/** 工具/命令传入的原始参数。 */
export interface ReviewArgs {
  readonly repo_path?: unknown
  readonly mode?: unknown
  readonly base_ref?: unknown
  readonly head_ref?: unknown
  readonly commit?: unknown
  readonly focus?: unknown
  readonly exclude_paths?: unknown
  readonly pending_paths?: unknown
}

/** 提交所需依赖。 */
export interface SubmitDeps {
  readonly dshRoot?: string
  /** 当前时间（ISO-8601）。 */
  readonly now: () => string
  /** 生成任务 id。 */
  readonly newId: () => string
  /** 配置快照（写入任务卡）。 */
  readonly config: ConfigV2
  /** 发起会话（用于完成后推送，可空）。 */
  readonly requestor: { readonly sessionId: string } | null
  /** 调用方工作目录（repo_path 省略时用它）。 */
  readonly cwdHint?: string | undefined
}

/** 提交结果。 */
export type SubmitResult =
  | { readonly ok: true; readonly taskId: string; readonly scope: TaskScope }
  | { readonly ok: false; readonly error: KernelError }

/** 取字符串参数（去掉首尾空白）。 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** 取字符串数组参数（过滤非字符串与空串）。 */
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

/**
 * 校验并创建任务卡。
 * @returns 成功带 taskId；失败带结构化错误（不抛异常，便于工具层直接回显）
 */
export function submitReview(args: ReviewArgs, deps: SubmitDeps): SubmitResult {
  // ① repo_path：绝对路径，或者用调用方 cwd 兜底
  const rawRepo = str(args.repo_path)
  const repoPath = rawRepo ?? deps.cwdHint ?? null
  if (repoPath === null || repoPath.trim() === '') {
    return {
      ok: false,
      error: new KernelError('INPUT_REPO_PATH_REQUIRED', '缺少 repo_path：后台内核没有「当前目录」概念，请显式传入仓库绝对路径', {
        nextAction: '在参数里传入 repo_path（如 D:/projects/my-repo）',
      }),
    }
  }
  if (!isAbsolute(repoPath)) {
    return {
      ok: false,
      error: new KernelError('INPUT_REPO_PATH_NOT_ABSOLUTE', 'repo_path 必须是绝对路径，收到：' + repoPath, {
        nextAction: '改用绝对路径（如 D:/projects/my-repo）',
      }),
    }
  }

  // ② 模式
  const rawMode = str(args.mode) ?? 'uncommitted'
  const allowed = ['uncommitted', 'branch', 'commit', 'scan'] as const
  if (!(allowed as readonly string[]).includes(rawMode)) {
    return {
      ok: false,
      error: new KernelError('INPUT_INVALID_ARGUMENT', '未知 mode：' + rawMode + '（可选：' + allowed.join(' / ') + '）'),
    }
  }
  const mode = rawMode as (typeof allowed)[number]

  const commit = str(args.commit)
  const baseRef = str(args.base_ref)
  const headRef = str(args.head_ref)

  // ③ 参数互斥：commit 模式要 SHA，branch 模式才用 ref
  if (mode === 'commit' && commit === null) {
    return {
      ok: false,
      error: new KernelError('INPUT_MISSING_COMMIT_SHA', 'commit 模式必须提供提交号（SHA）', {
        nextAction: '在 commit 参数里传入提交哈希，或改用 mode=uncommitted',
      }),
    }
  }
  if (mode !== 'commit' && commit !== null) {
    return {
      ok: false,
      error: new KernelError('INPUT_MODE_CONFLICT', 'commit 参数只能配合 mode=commit 使用（当前 mode=' + mode + '）'),
    }
  }
  if (mode === 'scan' && (baseRef !== null || headRef !== null)) {
    return {
      ok: false,
      error: new KernelError('INPUT_MODE_CONFLICT', 'scan 模式不接受 base_ref / head_ref'),
    }
  }

  const scope: TaskScope = {
    repoPath,
    command: mode === 'scan' ? 'scan' : 'review',
    mode: mode === 'scan' ? null : mode,
    baseRef: mode === 'branch' ? baseRef : null,
    headRef: mode === 'branch' ? headRef : null,
    commit: mode === 'commit' ? commit : null,
    focus: str(args.focus),
    excludePaths: strArray(args.exclude_paths),
    pendingPaths: strArray(args.pending_paths),
  }

  // ④ 写任务卡（配置拍快照，之后改设置不影响本次）
  const taskId = deps.newId()
  try {
    createTask(
      {
        id: taskId,
        scope,
        config: deps.config as unknown as Record<string, unknown>,
        requestor: deps.requestor,
        now: deps.now(),
      },
      deps.dshRoot,
    )
  } catch (error) {
    return {
      ok: false,
      error: error instanceof KernelError
        ? error
        : new KernelError('STORAGE_WRITE_FAILED', error instanceof Error ? error.message : String(error)),
    }
  }

  return { ok: true, taskId, scope }
}
