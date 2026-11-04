// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * credentials.ts —— 在宿主进程里解析凭据引用。
 *
 * 背景（实机踩到的，别再踩第二次）：
 *   DSH 的凭据存在它自己的仓库里（~/.dsh/.credentials.yaml），由宿主进程通过
 *   ctx.credentials 服务提供。它**不会**把值写进 process.env —— dsh-credentials-local
 *   的实现里一次 process.env 都没有出现过。
 *   而我们的内核是独立进程，原本只认环境变量，于是「配置里填了正确的引用名，
 *   第一次评审却报凭据未配置」。
 *
 * 所以解析放在宿主进程做，顺序与 DSH 保持一致：
 *   先查 DSH 凭据库（它内部还会退回环境变量与 .env），再退回本地 process.env。
 *   解析到的值交给 store/credential-cache 落成 0600 文件，供内核读取。
 *
 * 为什么不能直接把值塞进内核的 spawn 环境：内核是常驻单例，spawn 之后环境就
 * 固定了；那样「改一次 key 就得重启整个 DSH」。
 */

import { isValidCredentialRef } from '../store/credential-cache.js'

// 引用名语法的唯一实现在 store/credential-cache.ts（内核也用那份），这里转出给调用方
// 与测试用，避免同一个正则被抄成两份。
export { isValidCredentialRef }

/** 凭据服务的形状（@deepseek-ai/dsh-credentials 的 resolve 契约）。 */
export interface CredentialsServiceLike {
  /**
   * 解析一个引用。
   * @param ref 形如 COMMANDCODE_API_KEY 的引用名
   * @returns 命中时带 value；未配置时返回 undefined
   */
  resolve(ref: string): Promise<{ readonly value?: string | null } | undefined | null>
}

/** 值的来源，用于回显与排查。 */
export type CredentialSource = 'credentials' | 'env' | 'none'

/** 一次解析的结果。 */
export interface ResolvedCredential {
  /** 解析到的值；没解析到时为 null。 */
  readonly value: string | null
  /** 从哪来的。 */
  readonly source: CredentialSource
  /** 失败时给人看的原因（成功时为 null）。 */
  readonly detail: string | null
}

/** 从服务返回值里取出非空字符串（服务可能返回 {value} 或直接返回字符串）。 */
function pickValue(response: unknown): string | null {
  if (typeof response === 'string') {
    return response.trim() === '' ? null : response.trim()
  }
  if (typeof response === 'object' && response !== null) {
    const value = (response as { value?: unknown }).value
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * 解析一个凭据引用。
 * @param getService 按名字取 Cordis 服务（缺失必须返回 undefined，不能抛）
 * @param ref        引用名（来自配置的 review.credentialRef）
 * @param env        环境变量来源（测试可注入）
 */
export async function resolveCredentialFromHost(
  getService: (name: string) => unknown,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCredential> {
  const key = ref.trim()
  if (key === '') {
    return { value: null, source: 'none', detail: '配置里的凭据引用为空' }
  }

  const wellFormed = isValidCredentialRef(key)
  let hostFailure: string | null = null

  // ① 先问 DSH 凭据服务。名字不合法时跳过它：DSH 的 credentialRef() 会直接抛
  //    TypeError，我们不该用一次必然的失败去换一条日志。
  if (wellFormed) {
    try {
      const service = getService('credentials') as Partial<CredentialsServiceLike> | undefined
      if (service !== undefined && service !== null && typeof service.resolve === 'function') {
        const value = pickValue(await service.resolve(key))
        if (value !== null) return { value, source: 'credentials', detail: null }
      }
    } catch (error) {
      hostFailure = error instanceof Error ? error.message : String(error)
    }
  }

  // ② 再退回进程环境变量（DSH 的契约里引用名本来就是环境变量名）
  const fromEnv = env[key]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), source: 'env', detail: null }
  }

  if (!wellFormed) {
    return {
      value: null,
      source: 'none',
      detail:
        '凭据引用名不合法："' + key + '" 必须像 COMMANDCODE_API_KEY —— ' +
        '字母或下划线开头、只含字母数字下划线，不能含短横线',
    }
  }
  return {
    value: null,
    source: 'none',
    detail:
      '凭据引用 "' + key + '" 既不在 DSH 凭据库里，也不在环境变量里' +
      (hostFailure === null ? '' : '（凭据服务报错：' + hostFailure + '）'),
  }
}
