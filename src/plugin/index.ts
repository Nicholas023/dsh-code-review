// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * index.ts —— 0.2.0 插件入口（Cordis apply）。
 *
 * 这一层刻意很薄：只做「参数 → 任务卡 → 拉起内核」和「读任务卡 → 呈现」。
 * 真正的评审在内核进程里，插件崩了也不影响已提交的任务。
 *
 * 与 0.1.3 的差异：
 *  - 不再 spawn codecheck.exe，改为拉起 Node 内核；
 *  - 不再把引擎输出当结果，改为读任务卡的 summary；
 *  - 参数校验只有一处（plugin/submit.ts），工具和命令共用。
 */

import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLegacyMigrated } from '../config/migrate-legacy.js'
import { readConfigFile } from '../config/store.js'
import { configFilePath, resolveDshRoot } from '../store/paths.js'
import { listTasks, readTask, requestCancellation } from '../store/task-store.js'
import { presentSubmitted, presentTask, presentTaskList } from './present.js'
import { ensureKernel } from './process.js'
import { submitReview, type ReviewArgs } from './submit.js'
import { applyConfigPatch, presentSetConfigResult } from './set-config.js'

/** 插件名（Cordis 识别用）。 */
export const name = 'dsh-code-review'

/** 必需服务。 */
export const inject = ['tools']

/** 工具名。 */
export const TOOL_NAME = 'code_review'
export const STATUS_TOOL_NAME = 'code_review_status'
export const SET_CONFIG_TOOL_NAME = 'code_review_set_config'

/** Cordis 上下文的最小形状（避免依赖宿主类型包）。 */
interface Ctx {
  readonly tools: { register: (tool: unknown) => () => void }
  readonly commands?: { register: (cmd: unknown) => () => void }
  readonly inject: (names: readonly string[], cb: (sctx: Ctx) => void) => void
  readonly logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

/** 解析 dist 根目录（插件产物与内核入口都在这里）。 */
function distRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/plugin/index.js 的父亲是 dist
  return resolve(here, '..')
}

/** 读取当前配置（每次调用重读，热生效）。 */
function currentConfig(dshRoot: string) {
  // 幂等：只有「新文件不存在且旧文件存在」时才真的搬，搬完再读
  ensureLegacyMigrated(dshRoot)
  return readConfigFile(configFilePath(dshRoot)).config
}

/** 提交一次评审（工具与命令共用）。 */
export function doSubmit(
  args: ReviewArgs,
  ctx: Ctx,
  cwdHint: string | undefined,
  sessionId: string | null,
): { ok: boolean; text: string; taskId: string | null } {
  const dshRoot = resolveDshRoot()
  const config = currentConfig(dshRoot)
  const result = submitReview(args, {
    dshRoot,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    config,
    requestor: sessionId === null ? null : { sessionId },
    cwdHint,
  })
  if (!result.ok) {
    const hint = result.error.nextAction === undefined ? '' : '\n\n建议：' + result.error.nextAction
    return { ok: false, text: '❌ ' + result.error.message + hint, taskId: null }
  }
  // 拉起内核（失败不阻塞：任务已入队，下次提交还会再拉）
  const launched = ensureKernel({
    nodePath: process.execPath,
    entryPath: resolve(distRoot(), 'kernel', 'main.js'),
    dshRoot,
  })
  if (!launched.alive && launched.reason !== null) {
    ctx.logger?.warn?.('[dsh-code-review] 内核拉起失败：' + launched.reason)
  }
  return { ok: true, text: presentSubmitted(result.taskId, 'queued'), taskId: result.taskId }
}

/** 查询任务状态。 */
export function statusPayload(taskId: string | undefined): string {
  const dshRoot = resolveDshRoot()
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  if (id === '') {
    return presentTaskList(listTasks(dshRoot, 10))
  }
  const record = readTask(id, dshRoot)
  if (record === null) {
    return '未找到任务 ' + id + '。用 code_review_status（不传 task_id）查看最近任务。'
  }
  return presentTask(record)
}

/** 取消任务并返回回执。 */
export function cancelPayload(taskId: string | undefined): string {
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  if (id === '') return '取消需要指定 task_id。'
  const dshRoot = resolveDshRoot()
  try {
    const next = requestCancellation(id, new Date().toISOString(), dshRoot)
    if (next.stage === 'cancelled') return '🚫 任务 ' + id + ' 已取消。'
    return '⏳ 已请求取消任务 ' + id + '，内核会在下一个检查点停止。当前阶段：' + next.stage
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return '❌ 取消失败：' + message
  }
}

/** 创建 code_review 工具。 */
function createReviewTool(ctx: Ctx) {
  return {
    name: TOOL_NAME,
    description: [
      '对一个仓库执行代码评审：安全与脱敏、找 bug、冗余与无关代码三个固定视角。',
      '发起后立即返回任务 id，评审在独立后台进程执行，不阻塞会话；用 code_review_status 查询进度与结果。',
      '参数：repo_path（仓库绝对路径）；mode（uncommitted / branch / commit / scan）；',
      'base_ref（branch 模式的基线）；head_ref（branch 模式的目标）；commit（commit 模式的 SHA）；',
      'focus（本次重点）；exclude_paths / pending_paths（排除与待提交清单）。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        repo_path: { type: 'string', description: '仓库绝对路径' },
        mode: { type: 'string', enum: ['uncommitted', 'branch', 'commit', 'scan'], description: '评审模式' },
        base_ref: { type: 'string', description: 'branch 模式基线' },
        head_ref: { type: 'string', description: 'branch 模式目标' },
        commit: { type: 'string', description: 'commit 模式提交号' },
        focus: { type: 'string', description: '本次重点领域' },
        exclude_paths: { type: 'array', items: { type: 'string' }, description: '排除路径' },
        pending_paths: { type: 'array', items: { type: 'string' }, description: '待提交文件清单' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, task_id: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args: unknown, value: { text?: string }) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: ReviewArgs, exec: { session?: { id?: string; header?: { cwd?: string } } }) {
      const session = exec?.session
      const cwdHint = session?.header?.cwd
      const sessionId = typeof session?.id === 'string' ? session.id : null
      const r = doSubmit(args ?? {}, ctx, cwdHint, sessionId)
      return r.taskId === null ? { ok: r.ok, text: r.text } : { ok: r.ok, text: r.text, task_id: r.taskId }
    },
  }
}

/** 创建 code_review_set_config 工具。 */
function createSetConfigTool() {
  return {
    name: SET_CONFIG_TOOL_NAME,
    description: [
      '修改插件配置。传 { "review.endpoint": "...", "budget.maxAgentRounds": 3 } 这样的扁平键值对。',
      '字段会被逐条校验：未知字段、只读字段、类型不符都会被拒绝并回显原因。',
      '写入时只改动被点名的路径，配置文件里的其他内容（含未知字段）原样保留。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: '扁平键值对，键形如 section.key',
          additionalProperties: true,
        },
      },
      required: ['patch'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args: unknown, value: { text?: string }) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: { patch?: Record<string, unknown> }) {
      const patch = args?.patch
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return { ok: false, text: '❌ patch 必须是对象，形如 { "review.model": "deepseek-flash" }' }
      }
      const dshRoot = resolveDshRoot()
      const result = applyConfigPatch(patch, dshRoot)
      return { ok: result.ok, text: presentSetConfigResult(result) }
    },
  }
}

/** 创建 code_review_status 工具。 */
function createStatusTool() {
  return {
    name: STATUS_TOOL_NAME,
    description: '查询评审任务状态与结果。不传 task_id 时列出最近任务；传 cancel=true 可取消指定任务。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id' },
        cancel: { type: 'boolean', description: '设为 true 时取消该任务（排队中立即生效；执行中会在内核检查点停下）' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args: unknown, value: { text?: string }) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { task_id?: string; cancel?: boolean }) {
      if (args?.cancel === true) {
        return { ok: true, text: cancelPayload(args?.task_id) }
      }
      return { ok: true, text: statusPayload(args?.task_id) }
    },
  }
}

/** Cordis apply 入口。 */
export function apply(ctx: Ctx): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: unknown, label: string): void => {
    try {
      disposers.push(ctx.tools.register(tool))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-code-review] ' + label + ' 注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  register(createReviewTool(ctx), TOOL_NAME)
  register(createStatusTool(), STATUS_TOOL_NAME)
  register(createSetConfigTool(), SET_CONFIG_TOOL_NAME)

  // 斜杠命令（可选服务，缺失不阻塞工具）
  try {
    ctx.inject(['commands'], (sctx) => {
      try {
        const commands = sctx.commands
        if (commands === undefined) return
        disposers.push(commands.register({
          name: 'review',
          description: '发起一次代码评审（等于 code_review 工具）',
          input: 'repo_path [mode] [focus]',
          handler: async (invocation: { agent?: { session?: { id?: string; header?: { cwd?: string } } } }) => {
            const raw = invocation?.agent?.session
            const cwd = raw?.header?.cwd
            const sid = typeof raw?.id === 'string' ? raw.id : null
            const r = doSubmit({ repo_path: cwd }, ctx, cwd, sid)
            return r.text
          },
        }))
      } catch (error) {
        ctx.logger?.warn?.('[dsh-code-review] /review 注册失败：' + (error instanceof Error ? error.message : String(error)))
      }
    })
  } catch (error) {
    ctx.logger?.warn?.('[dsh-code-review] commands 服务不可用，/review 跳过：' + (error instanceof Error ? error.message : String(error)))
  }

  return () => {
    for (const d of disposers) {
      try { d() } catch { /* 忽略 */ }
    }
  }
}
