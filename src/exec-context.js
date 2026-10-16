/**
 * exec-context.js —— 宿主工具调用上下文解析（会话工作目录等）。
 *
 * 供需要「调用方视角」多个入口共用（index.js 的 repo_path 兜底、set-config-tool
 * 的相对 engine_bin 解析）：宿主进程自身的 cwd 恒为安装 profile 目录，凡是
 * 「相对用户目录」的入参都必须以调用上下文为准，否则会解析到宿主目录。
 *
 * 零敏感：不包含任何平台标识。
 */

/**
 * 从工具调用上下文解析会话工作目录。
 *
 * 宿主协议没有统一的 cwd 字段，不同会话形态把它放在不同位置；这里按常见
 * 键名逐个尝试，取到第一个非空字符串即返回。取不到返回 null，由调用方决定
 * 兜底策略（提示补参，而不是猜宿主目录）。
 *
 * @param {object|null} exec 宿主工具调用上下文。
 * @returns {string|null} 解析到的目录；取不到返回 null。
 */
export function cwdOfExec(exec) {
  if (!exec || typeof exec !== 'object') return null;
  for (const cand of [
    exec.cwd,
    exec.workspace,
    exec.session?.cwd,
    exec.session?.workspace,
    exec.session?.workdir,
    exec.meta?.cwd,
    exec.address?.cwd,
  ]) {
    if (typeof cand === 'string' && cand.trim()) return cand;
  }
  return null;
}
