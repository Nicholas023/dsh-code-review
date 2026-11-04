// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * apply.test.ts —— 插件挂载的模拟验收。
 *
 * 这是本地能拿到的、最接近「DSH 真的加载了这个插件」的证据：
 * 用模拟的 Cordis 上下文调用 apply，验证工具/命令确实注册成功，
 * 并且注册出来的工具**真的能被调用**（不只是名字对）。
 *
 * 它不能替代实机验收（宿主行为、权限、会话注入都测不到），
 * 但能拦住「apply 抛错」「工具没注册」「执行路径断了」这类硬故障。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, SET_CONFIG_TOOL_NAME, STATUS_TOOL_NAME, TOOL_NAME, name as pluginName } from '../../src/plugin/index.js'

const roots: string[] = []
let savedHome: string | undefined

/** 每个用例用独立的 DSH_HOME，避免污染真实数据。 */
beforeEach(() => {
  savedHome = process.env.DSH_HOME
  const d = mkdtempSync(join(tmpdir(), 'dcr-apply-'))
  roots.push(d)
  process.env.DSH_HOME = d
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  while (roots.length > 0) {
    const d = roots.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

/**
 * 跨平台绝对路径。
 *
 * 'D:/some/repo' 在 Linux 上不是绝对路径（path.isAbsolute 为 false），
 * 提交会被 INPUT_REPO_PATH_NOT_ABSOLUTE 拒绝 —— 2026-11-04 首次跑 CI 时在
 * ubuntu-latest 上暴露。被测代码是对的，错的是测试输入。
 */
const ABS_REPO = process.platform === 'win32' ? 'D:/some/repo' : '/tmp/some/repo'

/** 模拟 Cordis 上下文，记录注册了什么。 */
function makeCtx() {
  const tools: Array<{ name: string; execute?: (...args: unknown[]) => Promise<unknown> }> = []
  const commands: Array<{ name: string }> = []
  const warnings: string[] = []
  // 宿主的 configEditor（假）：0.2.0 起配置由它写入，所以挂载测试必须提供它，
  // 否则 code_review_set_config 只能诚实地回「profile 不可写」。
  const written: Array<Record<string, unknown>> = []
  const configEditor = {
    documentPath: 'C:/fake/profile/cordis.yaml',
    entries: () => [{ options: { id: 'dsh-code-review' } }],
    async edit(
      _entry: unknown,
      change: (current: Record<string, unknown> | undefined) => Record<string, unknown>,
    ): Promise<void> {
      written.push(change({}))
    },
  }
  const ctx = {
    tools: {
      register: (tool: unknown) => {
        tools.push(tool as { name: string })
        return () => { /* dispose */ }
      },
    },
    commands: {
      register: (cmd: unknown) => {
        commands.push(cmd as { name: string })
        return () => { /* dispose */ }
      },
    },
    inject: (names: readonly string[], cb: (sctx: unknown) => void) => {
      if (names.includes('commands')) cb(ctx)
    },
    get: (serviceName: string) => (serviceName === 'configEditor' ? configEditor : undefined),
    logger: {
      info: () => { /* 静默 */ },
      warn: (m: string) => { warnings.push(m) },
    },
  }
  return { ctx, tools, commands, warnings, written }
}

describe('插件挂载', () => {
  it('插件名正确', () => {
    expect(pluginName).toBe('dsh-code-review')
  })

  it('注册了三个工具', () => {
    const { ctx, tools } = makeCtx()
    const dispose = apply(ctx as never)
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME, STATUS_TOOL_NAME, SET_CONFIG_TOOL_NAME])
    dispose()
  })

  it('注册了 /review 命令', () => {
    const { ctx, commands } = makeCtx()
    const dispose = apply(ctx as never)
    expect(commands.map((c) => c.name)).toContain('review')
    dispose()
  })

  it('apply 不抛错，且返回可调用的卸载函数', () => {
    const { ctx } = makeCtx()
    const dispose = apply(ctx as never)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('commands 服务不可用时只告警、不影响工具', () => {
    const { ctx, tools, warnings } = makeCtx()
    ctx.inject = () => { throw new Error('no commands service') }
    const dispose = apply(ctx as never)
    expect(tools).toHaveLength(3)
    expect(warnings.join()).toContain('commands')
    dispose()
  })
})

describe('工具可调用', () => {
  it('code_review 缺 repo_path 时返回可操作的错误', async () => {
    const { ctx, tools } = makeCtx()
    const dispose = apply(ctx as never)
    const review = tools.find((t) => t.name === TOOL_NAME)!
    const out = (await review.execute!({}, { session: undefined })) as { ok: boolean; text: string }
    expect(out.ok).toBe(false)
    expect(out.text).toContain('repo_path')
    dispose()
  })

  it('code_review 提交成功后返回 task_id', async () => {
    const { ctx, tools } = makeCtx()
    const dispose = apply(ctx as never)
    const review = tools.find((t) => t.name === TOOL_NAME)!
    const out = (await review.execute!({ repo_path: ABS_REPO }, {})) as { ok: boolean; task_id?: string }
    expect(out.ok).toBe(true)
    expect(typeof out.task_id).toBe('string')
    dispose()
  })

  it('code_review_status 空任务簿时给出引导', async () => {
    const { ctx, tools } = makeCtx()
    const dispose = apply(ctx as never)
    const status = tools.find((t) => t.name === STATUS_TOOL_NAME)!
    const out = (await status.execute!({})) as { ok: boolean; text: string }
    expect(out.ok).toBe(true)
    expect(out.text).toContain('任务簿为空')
    dispose()
  })

  it('提交后能被 status 查到', async () => {
    const { ctx, tools } = makeCtx()
    const dispose = apply(ctx as never)
    const review = tools.find((t) => t.name === TOOL_NAME)!
    const status = tools.find((t) => t.name === STATUS_TOOL_NAME)!
    const submitted = (await review.execute!({ repo_path: ABS_REPO }, {})) as { task_id: string }
    const listed = (await status.execute!({})) as { text: string }
    expect(listed.text).toContain(submitted.task_id)
    dispose()
  })

  it('code_review_set_config 把改动交给宿主并回显', async () => {
    const { ctx, tools, written } = makeCtx()
    const dispose = apply(ctx as never)
    const setCfg = tools.find((t) => t.name === SET_CONFIG_TOOL_NAME)!
    const out = (await setCfg.execute!({ patch: { 'review.model': 'deepseek-flash' } })) as { ok: boolean; text: string }
    expect(out.ok).toBe(true)
    expect(out.text).toContain('review.model')
    // 关键：确实走到了宿主，而不是自己写文件
    expect(written).toHaveLength(1)
    expect((written[0]!.review as { model: string }).model).toBe('deepseek-flash')
    dispose()
  })

  it('code_review_set_config 在宿主没有 configEditor 时明说不可写', async () => {
    const { ctx, tools } = makeCtx()
    // 抹掉 configEditor，模拟只读部署
    ;(ctx as { get?: unknown }).get = () => undefined
    const dispose = apply(ctx as never)
    const setCfg = tools.find((t) => t.name === SET_CONFIG_TOOL_NAME)!
    const out = (await setCfg.execute!({ patch: { 'review.model': 'x' } })) as { ok: boolean; text: string }
    expect(out.ok).toBe(false)
    expect(out.text).toContain('不可写')
    dispose()
  })

  it('code_review_set_config 拒绝非法 patch', async () => {
    const { ctx, tools } = makeCtx()
    const dispose = apply(ctx as never)
    const setCfg = tools.find((t) => t.name === SET_CONFIG_TOOL_NAME)!
    const out = (await setCfg.execute!({ patch: 'not-an-object' })) as { ok: boolean }
    expect(out.ok).toBe(false)
    dispose()
  })
})
