// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * index.tsx —— 插件浏览器端入口（由 DSH 的 client-modules 加载）。
 *
 * 加载机制（v0.2.1 实测约定）：
 *  - package.json 声明 `dsh.client.platform = 'web'`；
 *  - 且必须提供 `exports["./client"]` 指向浏览器 bundle ——
 *    缺失会让宿主直接报错「declares dsh.client but exports no ./client bundle」；
 *  - 宿主读这个 bundle 作为该包的「浏览器半边」，按 Cordis 插件调用 apply()。
 *
 * 与宿主端的差异：这里拿不到 node 能力，只有 slots / locale 这类浏览器服务。
 * 配置的读写也不走 ctx，而是宿主通过 slot props 传进来的 form 对象。
 */

import { CodeReviewSettings } from './page.js'
import type { ClientContext, PluginConfigViewProps } from './types.js'

/** 插件名（与宿主端一致）。 */
export const name = 'dsh-code-review-client'

/**
 * 需要的浏览器服务。
 * 只声明 slots —— 配置读写走 slot props，不依赖 settings/remote 服务。
 */
export const inject = ['slots']

/** slot 名：插件页里「某一行」的配置区。 */
const SLOT_NAME = 'plugins.row.config'

/**
 * 挂载设置面板。
 * @param ctx 浏览器 Cordis 上下文
 */
export function apply(ctx: ClientContext): () => void {
  try {
    // 不声明 locale：本插件没有注册自己的词条表，
    // 声明一个不存在的命名空间只会给宿主多一个解析失败点。
    const dispose = ctx.slots.register(
      { name: SLOT_NAME, key: 'dsh-code-review#dsh-code-review' },
      (props: PluginConfigViewProps) => CodeReviewSettings(props),
    )
    return () => {
      try {
        dispose()
      } catch {
        // 卸载阶段失败不阻断宿主
      }
    }
  } catch (error) {
    // 注册失败不能让整个插件页崩掉：只告警，工具入口仍然可用
    ctx.logger?.warn?.('[dsh-code-review] 设置面板注册失败：' + (error instanceof Error ? error.message : String(error)))
    return () => { /* 无可释放 */ }
  }
}
