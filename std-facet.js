/**
 * std-facet.js —— dsh-code-review 的 dsh-std 标准形态 host facet 入口。
 *
 * 双形态（与 宿主既有插件范式 一致）：
 *   ① Cordis bundle 形态（main = src/index.js，生产实例 实际装载路径）；
 *   ② dsh-std 标准形态（本文件，等宿主内置 dsh-std 装载器后启用）。
 * 两者并存互不干扰：本文件只做「标准形态下转发到同一套逻辑」，全部实现
 * 仍集中在 src/（index.js 的 apply 是唯一事实来源）。
 *
 * 零敏感：无任何平台内部标识。
 */
import { apply as coreApply } from './src/index.js';

/**
 * dsh-std host facet 入口：按标准形态的运行时协议调用核心 apply。
 * 参数形态与 Cordis 形态一致（ctx + configRaw），宿主差异由调用方归一。
 *
 * @param {object} ctx   - 宿主上下文（提供 tools/settings 等服务）。
 * @param {object} [raw] - 配置快照（可 undefined）。
 * @returns {Function}   卸载函数（转发核心 apply 的 dispose，若存在）。
 */
export function mount(ctx, raw) {
  return coreApply(ctx, raw);
}
