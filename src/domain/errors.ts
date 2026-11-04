// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * errors.ts —— 全内核的稳定错误码与错误分类。
 *
 * 为什么必须集中定义：错误一旦散落成字符串，上层就只能靠匹配英文文本判断，
 * 改一个措辞就悄悄改变控制流（0.1.x 的自检脚本就吃过这个亏）。
 * 所以这里的 code 是**契约**：机器分支只认 code，人只看 message。
 *
 * 分类维度（三个正交轴，不要混成一个字符串）：
 *  - category：错误属于哪一层（输入/配置/仓库/运行时/模型/存储/内部）
 *  - retryable：在同一输入下重试是否有意义（网络抖动=是；参数非法=否）
 *  - effectState：这次失败对外部世界留下了什么（无副作用/部分生效/未知）
 */

/** 错误分层类别。 */
export type ErrorCategory =
  | 'input'      // 调用方参数不合法（路径、模式、SHA 等）
  | 'config'     // 配置缺失或非法（端点、模型、凭据引用）
  | 'repository' // Git/文件系统层面的问题（非仓库、读不了、越界）
  | 'runtime'    // 执行环境问题（子进程崩溃、超时、内存）
  | 'model'      // LLM 端点返回错误（4xx/5xx、限流、结构不合规）
  | 'storage'    // 任务簿/报告落盘问题（权限、磁盘、并发冲突）
  | 'internal'   // 程序自身缺陷（不该发生，一旦发生要暴露）

/** 失败对外部世界的影响面。宁可说 unknown，也不要谎称 none。 */
export type EffectState =
  | 'none'    // 确认没有产生任何外部副作用
  | 'partial' // 产生了部分副作用（如报告写了一半）
  | 'unknown' // 无法确认（如子进程被强杀，不确定是否已写文件）

/** 重试策略。after-input-change 表示只有输入变了才值得重试。 */
export type RetryPolicy = 'never' | 'safe' | 'after-input-change'

/**
 * 稳定错误码。命名规则：<层>_<具体原因>，全大写。
 * 新增错误码时同批更新 test/domain/errors.test.ts 的穷尽断言，防止漏登记。
 */
export const ERROR_CODES = [
  // —— input ——
  'INPUT_INVALID_ARGUMENT',
  'INPUT_MISSING_COMMIT_SHA',
  'INPUT_REPO_PATH_REQUIRED',
  'INPUT_REPO_PATH_NOT_ABSOLUTE',
  'INPUT_MODE_CONFLICT',
  // —— config ——
  'CONFIG_FILE_CORRUPT',
  'CONFIG_VERSION_UNSUPPORTED',
  'CONFIG_MODEL_ENDPOINT_MISSING',
  'CONFIG_MODEL_NOT_CONFIGURED',
  'CONFIG_CREDENTIAL_MISSING',
  'CONFIG_REPORT_DIR_INVALID',
  // —— repository ——
  'REPO_NOT_A_GIT_REPOSITORY',
  'REPO_PATH_OUTSIDE_ROOT',
  'REPO_READ_FAILED',
  'REPO_DIFF_PARSE_FAILED',
  // —— runtime ——
  'RUNTIME_RUNNER_TIMEOUT',
  'RUNTIME_RUNNER_CRASHED',
  'RUNTIME_RUNNER_MEMORY_EXCEEDED',
  'RUNTIME_RUNNER_OUTPUT_LIMIT',
  'RUNTIME_RUNNER_PROTOCOL_ERROR',
  'RUNTIME_PATH_FENCE_VIOLATION',
  'RUNTIME_PROGRAM_INVALID',
  // —— model ——
  'MODEL_HTTP_ERROR',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_RESPONSE_INVALID',
  'MODEL_USAGE_UNAVAILABLE',
  // —— storage ——
  'STORAGE_WRITE_FAILED',
  'STORAGE_CONCURRENT_MODIFICATION',
  'STORAGE_TASK_NOT_FOUND',
  // —— internal ——
  'INTERNAL_INVARIANT_VIOLATED',
  'INTERNAL_UNEXPECTED',
] as const

/** 错误码类型（从常量数组推导，新增码自动进入联合类型）。 */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** 每个错误码的静态分类元数据：重试策略与影响面默认值。 */
const CATALOG: Record<ErrorCode, { category: ErrorCategory; retry: RetryPolicy; effect: EffectState }> = {
  INPUT_INVALID_ARGUMENT: { category: 'input', retry: 'after-input-change', effect: 'none' },
  INPUT_MISSING_COMMIT_SHA: { category: 'input', retry: 'after-input-change', effect: 'none' },
  INPUT_REPO_PATH_REQUIRED: { category: 'input', retry: 'after-input-change', effect: 'none' },
  INPUT_REPO_PATH_NOT_ABSOLUTE: { category: 'input', retry: 'after-input-change', effect: 'none' },
  INPUT_MODE_CONFLICT: { category: 'input', retry: 'after-input-change', effect: 'none' },
  CONFIG_FILE_CORRUPT: { category: 'config', retry: 'after-input-change', effect: 'none' },
  CONFIG_VERSION_UNSUPPORTED: { category: 'config', retry: 'after-input-change', effect: 'none' },
  CONFIG_MODEL_ENDPOINT_MISSING: { category: 'config', retry: 'after-input-change', effect: 'none' },
  CONFIG_MODEL_NOT_CONFIGURED: { category: 'config', retry: 'after-input-change', effect: 'none' },
  CONFIG_CREDENTIAL_MISSING: { category: 'config', retry: 'after-input-change', effect: 'none' },
  CONFIG_REPORT_DIR_INVALID: { category: 'config', retry: 'after-input-change', effect: 'none' },
  REPO_NOT_A_GIT_REPOSITORY: { category: 'repository', retry: 'after-input-change', effect: 'none' },
  REPO_PATH_OUTSIDE_ROOT: { category: 'repository', retry: 'never', effect: 'none' },
  REPO_READ_FAILED: { category: 'repository', retry: 'safe', effect: 'none' },
  REPO_DIFF_PARSE_FAILED: { category: 'repository', retry: 'after-input-change', effect: 'none' },
  RUNTIME_RUNNER_TIMEOUT: { category: 'runtime', retry: 'safe', effect: 'unknown' },
  RUNTIME_RUNNER_CRASHED: { category: 'runtime', retry: 'safe', effect: 'unknown' },
  RUNTIME_RUNNER_MEMORY_EXCEEDED: { category: 'runtime', retry: 'after-input-change', effect: 'unknown' },
  RUNTIME_RUNNER_OUTPUT_LIMIT: { category: 'runtime', retry: 'never', effect: 'none' },
  RUNTIME_RUNNER_PROTOCOL_ERROR: { category: 'runtime', retry: 'safe', effect: 'unknown' },
  RUNTIME_PATH_FENCE_VIOLATION: { category: 'runtime', retry: 'never', effect: 'none' },
  RUNTIME_PROGRAM_INVALID: { category: 'runtime', retry: 'after-input-change', effect: 'none' },
  MODEL_HTTP_ERROR: { category: 'model', retry: 'safe', effect: 'none' },
  MODEL_RATE_LIMITED: { category: 'model', retry: 'safe', effect: 'none' },
  MODEL_TIMEOUT: { category: 'model', retry: 'safe', effect: 'none' },
  MODEL_RESPONSE_INVALID: { category: 'model', retry: 'safe', effect: 'none' },
  MODEL_USAGE_UNAVAILABLE: { category: 'model', retry: 'never', effect: 'none' },
  STORAGE_WRITE_FAILED: { category: 'storage', retry: 'safe', effect: 'partial' },
  STORAGE_CONCURRENT_MODIFICATION: { category: 'storage', retry: 'safe', effect: 'none' },
  STORAGE_TASK_NOT_FOUND: { category: 'storage', retry: 'never', effect: 'none' },
  INTERNAL_INVARIANT_VIOLATED: { category: 'internal', retry: 'never', effect: 'unknown' },
  INTERNAL_UNEXPECTED: { category: 'internal', retry: 'never', effect: 'unknown' },
}

/** 内核统一错误。上层只依据 code 分支，message 仅供人读。 */
export class KernelError extends Error {
  readonly code: ErrorCode
  readonly category: ErrorCategory
  readonly retry: RetryPolicy
  readonly effectState: EffectState
  /** 用户可执行的下一步建议（可空）。不得包含凭据。 */
  readonly nextAction?: string
  /** 底层原因，仅用于诊断与日志。覆盖 ES2022 Error 自带的 cause。 */
  override readonly cause?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options: { nextAction?: string; cause?: unknown; effectState?: EffectState } = {},
  ) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    const meta = CATALOG[code]
    this.category = meta.category
    this.retry = meta.retry
    // 影响面允许调用方上调（只能更保守，不能更乐观）
    this.effectState = options.effectState ?? meta.effect
    if (options.nextAction !== undefined) this.nextAction = options.nextAction
    if (options.cause !== undefined) this.cause = options.cause
  }

  /** 序列化给任务卡/报告用：绝不含 stack 与 cause 原文。 */
  toJSON(): { code: ErrorCode; message: string; retry: RetryPolicy; effectState: EffectState; nextAction?: string } {
    return {
      code: this.code,
      message: this.message,
      retry: this.retry,
      effectState: this.effectState,
      ...(this.nextAction === undefined ? {} : { nextAction: this.nextAction }),
    }
  }
}

/** 把任意抛出物归一为 KernelError（未知错误一律 INTERNAL_UNEXPECTED）。 */
export function toKernelError(error: unknown): KernelError {
  if (error instanceof KernelError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new KernelError('INTERNAL_UNEXPECTED', message, { cause: error })
}
