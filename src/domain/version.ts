// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * version.ts —— 0.2.0 全部协议的版本真源。
 *
 * 为什么单独抽出：任务卡、配置文件、报告、内核 RPC 四套协议各自独立演进，
 * 但它们的"当前版本"必须只有一处定义。任何模块需要判断兼容性时都从这里读，
 * 禁止在代码里散落魔法数字。
 *
 * 版本号含义（读法：本版本写入方 = 当前代码）：
 *  - taskSchemaVersion  任务卡 JSON 结构版本。插件写入、内核读取、插件回读。
 *  - configVersion      配置文件版本。迁移链 migrate() 的起点依据。
 *  - reportSchemaVersion 机器可读报告 JSON 版本。随包发布 schema。
 *  - kernelProtocolVersion 插件与内核进程之间的 RPC/握手协议版本。
 *
 * 兼容策略：读方遇到比自己高的版本必须显式拒绝并报错，不得静默降级——
 * 静默降级会让"未知字段保留"的安全网失效（旧代码可能覆盖新字段）。
 */

/** 任务卡结构版本（0.1.x 无版本字段，视作 v1；0.2.0 为 v2）。 */
export const TASK_SCHEMA_VERSION = 2 as const

/** 配置文件版本（0.1.x 的 plugin-config.json 视作 v1；0.2.0 的 config.json 为 v2）。 */
export const CONFIG_VERSION = 2 as const

/** 机器可读报告结构版本。 */
export const REPORT_SCHEMA_VERSION = 1 as const

/** 插件↔内核进程协议版本。 */
export const KERNEL_PROTOCOL_VERSION = 1 as const

/** 一次性拿全四套版本，用于写入任务卡/报告元数据或握手校验。 */
export const PROTOCOL_VERSIONS = {
  task: TASK_SCHEMA_VERSION,
  config: CONFIG_VERSION,
  report: REPORT_SCHEMA_VERSION,
  kernel: KERNEL_PROTOCOL_VERSION,
} as const
