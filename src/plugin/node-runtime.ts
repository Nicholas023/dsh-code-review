// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * node-runtime.ts —— 在内核/runner 之间统一「用什么可执行文件跑 JS」。
 *
 * 问题：插件跑在 DSH 的 Electron 进程里，`process.execPath` 指向的是
 * `DeepSeek Harness.exe`，不是 `node.exe`。直接拿它去跑 `kernel/main.js`
 * 会启动一个新的 DSH 窗口，而不是执行我们的脚本 —— 实机上表现为
 * 「发起评审后什么都没发生」。
 *
 * 解法：Electron 支持 `ELECTRON_RUN_AS_NODE=1`，设置后同一个可执行文件
 * 会以纯 Node 模式运行，argv 语义与 node 一致。这个变量对**真正的 node.exe
 * 完全无害**（它根本不看这个变量），所以可以无条件带上 ——
 * 不需要判断「我现在是不是在 Electron 里」，那反而会引入分叉。
 *
 * 结论：所有拉起 JS 子进程的地方都用 {@link nodeLaunchEnv}，不要各自拼 env。
 */

/** 让 Electron 可执行文件以 Node 模式运行的开关。 */
export const ELECTRON_NODE_FLAG = 'ELECTRON_RUN_AS_NODE'

/**
 * 构造「以 Node 模式启动某个 JS 文件」所需的环境变量。
 * @param base 基础环境（通常来自白名单，可为空对象）
 * @returns 合并了 Node 模式开关的新对象
 */
export function nodeLaunchEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [ELECTRON_NODE_FLAG]: '1' }
}
