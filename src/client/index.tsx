// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * index.tsx —— 插件浏览器端入口（由 DSH 的 client-modules 加载）。
 *
 * 加载机制（0.2.x 源码确认）：
 *  - package.json 声明 dsh.client.platform = "web"；
 *  - 必须提供 exports["./client"]，产物必须是经典脚本并调用
 *    window.__ModuleLoader__.load({id, factory})（ESM 会让 web boot 整体失败）；
 *  - dsh.client.inject 列的包，它们的 factory 必须先到位，本模块才会实例化 ——
 *    列错一个，apply 就永远不会执行，且不会有任何报错。
 *
 * 挂载时机（0.2.0 修，之前是错的）：
 *  plugins.row.config 不是常驻 slot，它由宿主「插件管理器」那一行在挂载时才声明，
 *  关掉插件页就拆掉。我们的模块在 DSH 启动时就求值，那时 slot 还不存在，
 *  直接 register 会抛：
 *    slot "plugins.row.config" is not declared (a parent entry's children table ...)
 *  所以必须用 ctx.slots.inject 等声明到位再注册。
 *
 * 正因为「没等」和「等不到」两种失败都可能静默，这里刻意保留 console 输出：
 * 排查「面板没出现」时，先在开发者工具控制台确认这几行走没走。
 */

import { CodeReviewPanel } from './panel.js'
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
export const SLOT_NAME = 'plugins.row.config'

/**
 * 注册用的 key，规则是「包名#rowId」（宿主插件页按这个查配置）。
 * 两个名字都必须是 dsh-code-review：前者是包名，后者是 cordis.patch.yml 里的行 id。
 */
export const SLOT_KEY = 'dsh-code-review#dsh-code-review'

/** 左侧栏「全局面板」列表 slot（宿主 dsh-client-ui-sidebar 声明）。 */
const SIDEBAR_SLOT = 'sidebar.panellist'
/** 主区内容 slot（宿主按 activePanelId 选 key）。 */
const MAIN_SLOT = 'main'
/** 面板 id：侧栏条目与主区 key 必须一致。 */
export const PANEL_ID = 'dsh-code-review'

/** 空卸载函数（失败路径统一返回它，别让调用方处理 undefined）。 */
function noop(): void {
  /* 无可释放 */
}

/**
 * 挂载设置面板。
 * @param ctx 浏览器 Cordis 上下文
 */
export function apply(ctx: ClientContext): () => void {
  console.info('[dsh-code-review] 客户端模块已实例化')

  if (ctx.slots === undefined || typeof ctx.slots.register !== 'function') {
    console.warn('[dsh-code-review] ctx.slots 不可用，设置面板未注册')
    return noop
  }
  if (typeof ctx.slots.inject !== 'function') {
    console.warn('[dsh-code-review] ctx.slots.inject 不可用，无法等待 slot 声明，设置面板未注册')
    return noop
  }

  try {
    // ── 侧栏入口 ──
    // 宿主 sidebar 读 'sidebar.panellist' 的 { id, order, label } 生成左侧栏行；
    // 点击时调用 layout.selectPanel(id)，主区再按这个 id 渲染 'main' 槽。
    // 两处 id 必须一致，否则点进去是空白。
    ctx.slots.inject(SIDEBAR_SLOT, () => {
      const drop = ctx.slots.register(
        { name: SIDEBAR_SLOT, id: PANEL_ID, order: 60, label: '代码审查' },
        () => null,
      )
      return drop
    })

    // ── 主区面板 ──
    ctx.slots.inject(MAIN_SLOT, () => {
      const drop = ctx.slots.register(
        { name: MAIN_SLOT, key: PANEL_ID },
        () => CodeReviewPanel(),
      )
      return drop
    })

    // 等宿主把 plugins.row.config 声明出来（打开插件页时）再注册。
    // 不声明 locale：本插件没有自己的词条表，声明一个不存在的命名空间只会多一个失败点。
    const dispose = ctx.slots.inject(SLOT_NAME, () => {
      const drop = ctx.slots.register(
        { name: SLOT_NAME, key: SLOT_KEY },
        (props: PluginConfigViewProps) => CodeReviewSettings(props),
      )
      console.info('[dsh-code-review] 设置面板已注册：' + SLOT_NAME + ' key=' + SLOT_KEY)
      return drop
    })
    return () => {
      try {
        dispose()
      } catch {
        // 卸载阶段失败不阻断宿主
      }
    }
  } catch (error) {
    console.warn('[dsh-code-review] 设置面板注册失败：' + (error instanceof Error ? error.message : String(error)))
    return noop
  }
}
