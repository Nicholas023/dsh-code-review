// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * types.ts —— 浏览器端与宿主之间的最小契约。
 *
 * 为什么不直接 import DSH 的客户端包：那些包是宿主构建图的一部分，
 * 插件若在运行时 import 它们，会让打包器把宿主代码也打进来（体积爆炸 + 版本耦合）。
 * 宿主通过 slot 把 form 对象**传进来**，所以这里只需要它的形状。
 *
 * 形状来源：@deepseek-ai/dsh-client-ui-settings 的 ConfigForm / ConfigFormSnapshot
 * 与 @deepseek-ai/dsh-client-ui-plugin-manager 的 PluginConfigViewProps（v0.2.1）。
 * 宿主改这两处形状时，本文件要跟着改 —— 它是一份显式的兼容声明。
 */

/** 客户端看到的配置快照。 */
export interface ConfigFormSnapshot {
  /** loading = 还在等宿主；ready = 可用；unavailable = 该命名空间未暴露给本客户端。 */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** 宿主校验后的当前值。 */
  readonly value: Record<string, unknown> | undefined
  /** 组合层（字段被清空时回退到它）。 */
  readonly base: unknown
  /** 用户层原始存储（字段存在即表示被覆盖过）。 */
  readonly user: unknown
  /** 写入使用的修订号。 */
  readonly revision: number | undefined
  /** 宿主是否接受写入。 */
  readonly writable: boolean
}

/** 一次配置写入的操作描述。 */
export interface SettingsPathOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/**
 * 宿主为某一行注入的表单对象。
 *
 * state 是快照；set/unset/mutate 是写入。写入是**串行排队**的：
 * 连续 set 会按顺序落地，每次带上最新修订号 —— 所以不要并发等返回值再 set。
 */
export interface ConfigPageForm {
  readonly state: ConfigFormSnapshot
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
}

/** 宿主传给配置组件（plugins.row.config）的属性。 */
export interface PluginConfigViewProps {
  /** summary = 行摘要（几个字）；page = 带保存控制的完整表单。 */
  readonly view: 'summary' | 'page'
  readonly form?: ConfigPageForm | undefined
  /** 宿主的翻译函数（可选，缺失时用内置中文）。 */
  readonly t?: ((key: string) => string) | undefined
}

/** 宿主的 slot 注册契约（只取我们用到的那部分）。 */
export interface SlotsService {
  register(
    options: { readonly name: string; readonly key?: string; readonly locale?: string },
    component: (props: PluginConfigViewProps) => unknown,
  ): () => void
}

/** 客户端 Cordis 上下文的最小形状。 */
export interface ClientContext {
  readonly slots: SlotsService
  readonly logger?: { info?: (m: string) => void; warn?: (m: string) => void }
  readonly effect?: (fn: () => unknown) => unknown
}
