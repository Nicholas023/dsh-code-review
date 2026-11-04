// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * index.tsx —— 插件浏览器端入口（由 DSH 的 client-modules 加载）。
 *
 * 加载机制（v0.2.1 源码确认）：
 *  - package.json 声明 `dsh.client.platform = 'web'`；
 *  - 必须提供 `exports["./client"]`，产物必须是经典脚本并调用
 *    `window.__ModuleLoader__.load({id, factory})`（ESM 会让 web boot 整体失败）；
 *  - `dsh.client.inject` 列的包，它们的 factory 必须先到位，本模块才会实例化 ——
 *    列错一个，apply 就永远不会执行，且不会有任何报错。
 *
 * 正因为最后那条的失败是静默的，这里刻意保留两行 console 输出：
 * 排查「面板没出现」时，先在开发者工具控制台确认这两行走没走。
 */

import { CodeReviewSettings } from './page.js'
import type { ClientContext, PluginConfigViewProps } from './types.js'

/** 插件名（与宿主端一致）。 */
export const name = 'dsh-code-review-client'

/**
 * 需要的 Cordis 服务。
 * 只声明 slots —— 配置读写走 slot props 传进来的 form，不依赖 settings/remote。
 */
export const inject = ['slots']

/** slot 名：插件页里「某一行」的配置区。 */
const SLOT_NAME = 'plugins.row.config'

/** 注册用的 key，规则是 `包名#rowId`（宿主 plugins 页按这个查配置）。 */
const SLOT_KEY = 'dsh-code-review#dsh-code-review'

/**
 * 挂载设置面板。
 * @param ctx 浏览器 Cordis 上下文
 */
export function apply(ctx: ClientContext): () => void {
  // 诊断：模块被实例化（若控制台看不到这行，说明本模块没被加载，问题在 inject/入口声明）
  console.info('[dsh-code-review] 客户端模块已实例化')

  if (ctx.slots === undefined || typeof ctx.slots.register !== 'function') {
    // 诊断：服务形状不对（比静默失败强得多）
    console.warn('[dsh-code-review] ctx.slots 不可用，设置面板未注册')
    return () => { /* 无可释放 */ }
  }

  try {
    // 不声明 locale：本插件没有自己的词条表，声明一个不存在的命名空间只会多一个失败点。
    const dispose = ctx.slots.register(
      { name: SLOT_NAME, key: SLOT_KEY },
      (props: PluginConfigViewProps) => CodeReviewSettings(props),
    )
    // 诊断：注册成功（能走到这里但面板仍不出现，问题就在宿主的渲染条件，不在本插件）
    console.info('[dsh-code-review] 设置面板已注册：' + SLOT_NAME + ' key=' + SLOT_KEY)
    return () => {
      try {
        dispose()
      } catch {
        // 卸载阶段失败不阻断宿主
      }
    }
  } catch (error) {
    console.warn('[dsh-code-review] 设置面板注册失败：' + (error instanceof Error ? error.message : String(error)))
    return () => { /* 无可释放 */ }
  }
}
