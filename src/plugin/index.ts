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
 *
 * 0.2.0 的配置来源（关键约定，别改回去）：
 *  - 这里 **export const Config**，宿主据此生成设置命名空间，插件页才有配置表单；
 *  - 配置的唯一真源是宿主的 profile 行（cordis patch 的 config:）；
 *  - 宿主校验后把配置作为 apply 的第二个参数交回来，配置一改就重挂本行，天然热生效；
 *  - 内核**不读任何配置文件**：配置在提交时被拍进任务卡（见 store/task-store.ts），
 *    所以「改设置会影响已提交的任务」这件事不可能发生。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../config/schema.js'
import { configFilePath, resolveDshRoot } from '../store/paths.js'
import { listTasks, readTask, requestCancellation } from '../store/task-store.js'
import { settingsConfig, CONFIG_FIELDS, configObject } from '../settings/schema.js'
import { presentSubmitted, presentTask, presentTaskList } from './present.js'
import { ensureKernel } from './process.js'
import { submitReview, type ReviewArgs } from './submit.js'
import {
  planConfigPatch,
  presentSetConfigResult,
  writeConfigThroughHost,
  type ConfigEditorLike,
} from './set-config.js'

/** 插件名（Cordis 识别用）。 */
export const name = 'dsh-code-review'

/**
 * 设置描述：宿主靠它生成设置命名空间与表单。
 *
 * 导出的名字必须是 Config —— Cordis 只认这个名字。
 * 缺了它，插件页那一行永远拿不到 form（读不到值也存不了盘），且不会报错。
 */
export const Config = settingsConfig(
  (value) => normalizeConfig(configObject(value)).config,
  CONFIG_FIELDS,
)

/** 必需服务。 */
export const inject = ['tools']

/** 工具名。 */
export const TOOL_NAME = 'code_review'
export const STATUS_TOOL_NAME = 'code_review_status'
export const SET_CONFIG_TOOL_NAME = 'code_review_set_config'

/** 本插件在组合树里的行 id（与 cordis.patch.yml 一致）。 */
const ENTRY_ID = 'dsh-code-review'

/** Cordis 上下文的最小形状（避免依赖宿主类型包）。 */
interface Ctx {
  readonly tools: { register: (tool: unknown) => () => void }
  readonly commands?: { register: (cmd: unknown) => () => void }
  readonly inject: (names: readonly string[], cb: (sctx: Ctx) => void) => void
  /** 按名字取服务（缺失返回 undefined，不抛）。 */
  readonly get?: (serviceName: string) => unknown
  readonly logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

/** 解析 dist 根目录（插件产物与内核入口都在这里）。 */
function distRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/plugin/index.js 的父亲是 dist
  return resolve(here, '..')
}

/**
 * 把宿主传来的配置收敛成可用形状。
 *
 * 正常路径：Cordis 已经用我们的 Config 做过 resolveConfig，这里拿到的就是归一化结果。
 * 兜底路径：宿主没给（例如本地测试、或某些老版本装载器）时退回默认值并告警，
 *          而不是让整个插件挂掉 —— 评审功能不该因为配置层退化而不可用。
 */
export function resolvePluginConfig(raw: unknown, ctx?: Ctx): ReturnType<typeof normalizeConfig>['config'] {
  try {
    return normalizeConfig(configObject(raw)).config
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx?.logger?.warn?.('[dsh-code-review] 配置无效，已退回默认值：' + message)
    return normalizeConfig({}).config
  }
}

/** 旧版配置文件只做提示，不再读取（避免和宿主形成双真源）。 */
let legacyNoticeShown = false
function noticeLegacyConfigOnce(ctx: Ctx): void {
  if (legacyNoticeShown) return
  legacyNoticeShown = true
  try {
    const file = configFilePath(resolveDshRoot())
    if (existsSync(file)) {
      ctx.logger?.warn?.(
        '[dsh-code-review] 检测到旧版配置文件 ' + file +
        '：0.2.0 起配置改由 DSH 的设置页管理，该文件不再被读取。' +
        '请在「插件 → dsh-code-review」里重新填写（旧文件不会被删除或修改）。',
      )
    }
  } catch {
    // 读不到路径不影响插件运行
  }
}

/** 提交一次评审（工具与命令共用）。 */
export function doSubmit(
  args: ReviewArgs,
  ctx: Ctx,
  cwdHint: string | undefined,
  sessionId: string | null,
  config: ReturnType<typeof normalizeConfig>['config'],
): { ok: boolean; text: string; taskId: string | null } {
  const dshRoot = resolveDshRoot()
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

/** 从上下文里取宿主的配置编辑器（缺失返回 undefined）。 */
export function configEditorOf(ctx: Ctx): ConfigEditorLike | null {
  try {
    const service = ctx.get?.('configEditor')
    if (service === undefined || service === null) return null
    const candidate = service as Partial<ConfigEditorLike>
    if (typeof candidate.entries !== 'function' || typeof candidate.edit !== 'function') return null
    return service as ConfigEditorLike
  } catch {
    return null
  }
}

/** 创建 code_review 工具。 */
function createReviewTool(ctx: Ctx, config: ReturnType<typeof normalizeConfig>['config']) {
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
      const r = doSubmit(args ?? {}, ctx, cwdHint, sessionId, config)
      return r.taskId === null ? { ok: r.ok, text: r.text } : { ok: r.ok, text: r.text, task_id: r.taskId }
    },
  }
}

/** 创建 code_review_set_config 工具。 */
function createSetConfigTool(ctx: Ctx) {
  return {
    name: SET_CONFIG_TOOL_NAME,
    description: [
      '修改插件配置。传 { "review.endpoint": "...", "budget.maxAgentRounds": 3 } 这样的扁平键值对。',
      '字段会被逐条校验：未知字段、只读字段、类型不符都会被拒绝并回显原因。',
      '写入时只改动被点名的路径，配置里其他内容（含未知字段）原样保留。',
      '写的是 DSH 自己的 profile 配置，与设置页完全同一份，改完立即生效。',
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
      const plan = planConfigPatch(patch as Record<string, unknown>)
      const editor = configEditorOf(ctx)
      if (editor === null) {
        // 没有 configEditor 时不假装成功：写不进去就说写不进去
        const write = {
          ok: false,
          path: '（宿主未提供 configEditor 服务）',
          error: '当前 profile 不可写，无法保存配置；请在 DSH 的设置页里修改',
        }
        return { ok: false, text: presentSetConfigResult(plan, write) }
      }
      const write = plan.ok
        ? await writeConfigThroughHost(plan.changes, editor, ENTRY_ID)
        : { ok: false, path: editor.documentPath, error: plan.error ?? '补丁为空' }
      return { ok: plan.ok && write.ok, text: presentSetConfigResult(plan, write) }
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
        cancel: { type: 'boolean', description: '设为 true 时取消任务（排队中立即生效；执行中会在内核检查点停下）' },
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

/**
 * Cordis apply 入口。
 * @param ctx       宿主上下文
 * @param rawConfig 宿主按 Config 校验后交回来的配置（配置一改就重挂这里）
 */
export function apply(ctx: Ctx, rawConfig?: unknown): () => void {
  const config = resolvePluginConfig(rawConfig, ctx)
  noticeLegacyConfigOnce(ctx)

  const disposers: Array<() => void> = []
  const register = (tool: unknown, label: string): void => {
    try {
      disposers.push(ctx.tools.register(tool))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-code-review] ' + label + ' 注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  register(createReviewTool(ctx, config), TOOL_NAME)
  register(createStatusTool(), STATUS_TOOL_NAME)
  register(createSetConfigTool(ctx), SET_CONFIG_TOOL_NAME)

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
            const r = doSubmit({ repo_path: cwd }, ctx, cwd, sid, config)
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
