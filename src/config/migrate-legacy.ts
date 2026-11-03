// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * migrate-legacy.ts —— 0.1.x 配置的一次性自动迁移。
 *
 * 为什么需要显式一步：用户从 0.1.3 升级上来时，设置存在
 * plugin-config.json 里；0.2.0 读的是 config.json。如果不自动搬，「升级后设置全丢」
 * 就会真实发生 —— 那正是用户最不能接受的情况。
 *
 * 触发条件很保守：
 *  - 新文件 config.json **不存在**（存在就说明已经用上新版本，绝不覆盖）；
 *  - 旧文件 plugin-config.json **存在**。
 * 迁移前会备份旧文件（store.ts 里已实现）。
 */

import { existsSync } from 'node:fs'
import { readConfigFile, updateConfigFile } from '../config/store.js'
import { configFilePath, legacyConfigFilePath } from '../store/paths.js'

/** 迁移结果。 */
export interface LegacyMigration {
  readonly performed: boolean
  readonly reason: string;
}

/**
 * 确保旧配置已迁移到新格式。
 * @returns 是否发生了迁移（供日志与诊断）
 */
export function ensureLegacyMigrated(dshRoot: string): LegacyMigration {
  const next = configFilePath(dshRoot)
  const legacy = legacyConfigFilePath(dshRoot)

  if (existsSync(next)) {
    return { performed: false, reason: '新配置已存在，跳过迁移' }
  }
  if (!existsSync(legacy)) {
    return { performed: false, reason: '无旧配置，使用默认值' }
  }

  // 读旧文件（readConfigFile 会对它做 v1→v2 迁移），再整体写到新路径
  const migrated = readConfigFile(legacy)
  if (migrated.corrupt) {
    return { performed: false, reason: '旧配置损坏，未自动迁移（避免把坏数据写进新文件）：' + String(migrated.corruptReason) }
  }

  try {
    // 关键：写入 readConfigFile 返回的 raw —— 它已经是「迁移后的 v2 结构 + 原样保留的未知字段」。
    // 不能用 .config：那是归一化后的规范结构，会丢掉未知键（正是要去掉的缺陷）。
    // 也不能用旧文件的原始内容：那是 v1 字段，下次读取会被当成 v2 缺分区而回退默认。
    updateConfigFile(next, migrated.raw, { skipBackup: true });
    return { performed: true, reason: '已从 plugin-config.json 迁移到 config.json' };
  } catch (error) {
    return { performed: false, reason: '迁移写入失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}
