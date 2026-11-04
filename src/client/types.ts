// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * types.ts —— 浏览器端与宿主之间的最小契约。
 *
 * 为什么不直接 import DSH 的客户端包：那些包是宿主构建图的一部分，
 * 插件若在运行时 import 它们，会让打包器把宿主代码也打进来（体积爆炸 + 版本耦合）。
 * 宿主通过 slot 把 form 对象**传进来**，所以这里只需要它的形状。
 *
 * 形状来源（0.2.x 源码逐行核对过，不是猜的）：
 *  - ConfigFormSnapshot  ← @deepseek-ai/dsh-client-ui-settings 里表单 store 的初值；
 *  - ConfigPageForm      ← @deepseek-ai/dsh-client-ui-plugin-manager 的 formFor()，
 *                          它只把 set/unset/mutate 里的 **mutate** 递出来；
 *  - SettingsPathOp      ← dsh-settings 的 applyPathOp()。
 *
 * 两个必须记住的坑（都踩过）：
 *  1. 宿主给前端的 form **没有 set / unset**，只有 state + mutate。
 *     写成 form.set(...) 会在点保存时抛 TypeError。
 *  2. op 的 path 是**分段数组**（[review, endpoint]），不是点号串（review.endpoint）。
 *
 * 宿主改这两处形状时，本文件要跟着改 —— 它是一份显式的兼容声明。
 */

/** 客户端看到的配置快照（宿主 store 的初值 + 派生结果）。 */
export interface ConfigFormSnapshot {
  /** loading = 还在等宿主；ready = 可用；unavailable = 该命名空间没暴露给本客户端。 */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** 宿主校验后的当前值（status=ready 时才有）。 */
  readonly value?: Record<string, unknown> | undefined
  /** 组合层基线（字段被清空时回退到它）。 */
  readonly base?: unknown
  /** 用户层原始存储（字段存在即表示被覆盖过）。 */
  readonly user?: unknown
  /** 写入使用的修订号。 */
  readonly revision?: number | undefined
  /** 宿主是否接受写入。 */
  readonly writable: boolean
}

/** 一次配置写入的操作描述（与宿主 applyPathOp 对齐）。 */
export interface SettingsPathOp {
  /** set = 写入该路径；unset = 清掉该路径（回退到基线值）。 */
  readonly op: 'set' | 'unset'
  /** 分段路径，如 ['review', 'endpoint']。 */
  readonly path: readonly string[]
  /** op=set 时的值。 */
  readonly value?: unknown
}

/**
 * 宿主为某一行注入的表单对象（**只有这两个成员**）。
 *
 * mutate 的写入是串行排队的：每次带最新修订号，失败会自动重读。
 * 所以不要并发地等返回值再发下一次，按顺序构造 op 数组一次提交即可。
 */
export interface ConfigPageForm {
  readonly state: ConfigFormSnapshot
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
  /**
   * 注册一个 slot 条目。
   * @returns 卸载函数
   */
  register(
    options: { readonly name: string; readonly key?: string; readonly locale?: string },
    component: (props: PluginConfigViewProps) => unknown,
  ): () => void
  /**
   * 等某个 slot 被声明之后再执行注册。
   *
   * 为什么必须用它：插件页的 slot 由宿主的「插件管理器」在打开插件页时才声明，
   * 关掉就拆。我们的模块在 DSH 启动时就被求值，此时 slot 还不存在，
   * 直接 register 会抛「slot is not declared」（而且会被 try/catch 吞掉，
   * 表现为「面板就是不出现，也没有报错」）。
   * @param name slot 名
   * @param mount 声明到位后执行的挂载函数，返回值被当作卸载函数
   */
  inject(name: string, mount: () => (() => void) | void): () => void
}

/** 客户端 Cordis 上下文的最小形状。 */
export interface ClientContext {
  readonly slots: SlotsService
  readonly logger?: { info?: (m: string) => void; warn?: (m: string) => void }
  readonly effect?: (fn: () => unknown) => unknown
}
