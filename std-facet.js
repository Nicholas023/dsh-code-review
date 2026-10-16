/**
 * std-facet.js —— dsh-code-review 的 dsh-std 标准形态 host facet 入口。
 *
 * 双形态：
 *   ① Cordis bundle 形态（main = src/index.js，线上环境实际装载路径）；
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
  // 入参校验（作为 dsh-std 宿主入口，核心 apply 会立即解引用
  // ctx（inject/effect 等服务）。实参形态与 Cordis 形态不一致或 ctx 缺失
  // 时，此前会在核心内部抛出难以定位的 TypeError——这里显式拦下，带插件名前缀。
  // tools 不强制要求——核心 apply 对工具注册失败
  // 有降级路径（try/catch + 提示，会话自然语言触发不可用但插件其余能力正常）；
  // 此处只拦「核心必然解引用且无降级」的 inject/effect 形状错误。
  if (!ctx || typeof ctx.inject !== 'function' || typeof ctx.effect !== 'function') {
    throw new TypeError('[dsh-code-review] std-facet mount: 需要合法的宿主 ctx（缺少 inject/effect 能力）');
  }
  // 返回兜底（JSDoc 承诺返回卸载函数。核心 apply 若在中途抛错
  // 或上游改为返回 void，宿主卸载阶段会拿到 undefined 而非可调用对象——锁定
  // 契约：始终返回函数。
  const dispose = coreApply(ctx, raw);
  return typeof dispose === 'function' ? dispose : () => {};
}
