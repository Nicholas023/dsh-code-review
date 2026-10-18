// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * file-config.js —— 插件自有配置文件层（运行真源，不依赖宿主 entry 配置回传）。
 *
 * 背景（定性）：0.2.0-rc.2 宿主「面板保存」对第三方 bundle 插件
 * 只写 cordis.yml / cordis.patch.yml（文件持久化），**不把 entry config 回传给
 * apply 的 configRaw，也不建 settings 快照文件**——面板选的模型值永远进不了运行层
 * （任务 config 一直是插件全默认）。
 *
 * 本模块提供替代正道：
 *   - 配置文件 = `~/.dsh/dsh-code-review/plugin-config.json`（与任务簿同域，
 *     DSH_HOME 下，不进公开仓库；DSH_REVIEW_HOME 环境变量可覆盖目录，对齐任务簿）；
 *   - 写入口 = code_review_set_config 工具（会话/AI 程序改，见 set-config-tool.js）
 *     或人工编辑该 JSON；
 *   - 读入口 = readFileConfig()，getConfig() 每次调用都重新读取（热生效，无需重启）；
 *   - 优先级：文件覆盖层 > 宿主 entry（configRaw）> settings 快照 > DEFAULT_CONFIG。
 *
 * 键名与 DEFAULT_CONFIG 完全对齐（snake_case）；写时只收白名单键、值做基础类型
 * 校验；JSON 损坏时读返回 {}（绝不抛错中断插件），下次写会全量覆盖修复。
 *
 * 零敏感：文件在用户态 DSH_HOME；代码不硬编码任何平台标识。
 *
 * @module dsh-code-review/file-config
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REVIEW_HOME } from './task-book.js';
// 白名单与范围校验的单一真源（无循环依赖：config.js 无本地导入）。
import { DEFAULT_CONFIG, CONCURRENCY_MIN, CONCURRENCY_MAX, REVIEW_TIMEOUT_MAX } from './config.js';

/** 插件自有配置文件绝对路径。 */
export const PLUGIN_CONFIG_FILE = join(REVIEW_HOME, 'plugin-config.json');

/**
 * 可写白名单：键 = DEFAULT_CONFIG 键，值 = 该键的合法类型（null 表示该键类型
 * 不受支持、不允许写入）。
 *
 * 从 DEFAULT_CONFIG 派生（不再手工维护字面量）：新增/重命名默认键时
 * 自动同步，杜绝「DEFAULT_CONFIG 加了键、这里忘了加 → 覆盖层被静默丢弃」。
 *
 * @param {unknown} v 默认配置中某键的默认值。
 * @returns {string|null} 允许写入的 JS 类型名；不支持的类型返回 null。
 */
function typeNameOfDefault(v) {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  return null;
}
const ALLOWED = Object.fromEntries(
  Object.entries(DEFAULT_CONFIG).map(([k, v]) => [k, typeNameOfDefault(v)])
);
// 注：concurrency 是用户侧成本控制旋钮，集合里虽允许写，但常规写入口仅设置面板
// （经 /api/code-review/config 路由），code_review_set_config 工具不提供该字段
// （控制权交回用户）。

/**
 * 过滤出白名单内且类型合法的字段（null/undefined 表示显式清空 → 保留 null 占位，
 * 读取方见到 null 直接跳过，效果 = 恢复默认）。
 *
 *  - 字符串字段 trim 后为空 → 按「显式清空」写 null 占位（而不是把空格串/空串
 *    当合法覆盖落盘——engine_bin 之类接受空串的键会从「未设置」变成「显式空路径」）；
 *  - 数值字段必须 Number.isFinite（拒绝 NaN/Infinity——否则 JSON.stringify 会
 *    把 NaN/Infinity 序列化成 null，内存值与盘上值不一致）**且为正数**：非正值
 *    一律不落盘（读取方回退默认，与 normalizeConfig 的「>0 才采纳」同口径——
 *    0/负值没有「放宽/收窄」语义，写成 1ms 反而把非法输入变成合法极小值）；
 *  - 合法有限值进入钳制：review_timeout_ms 钳 [1, REVIEW_TIMEOUT_MAX]、
 *    concurrency 先取整再钳 [CONCURRENCY_MIN, CONCURRENCY_MAX]，
 *    与 normalizeConfig 同口径。
 *
 * @param {object} raw 待清洗对象。
 * @returns {object} 干净对象（仅白名单键，非法值剔除）。
 */
export function sanitizePatch(raw) {
  if (!raw || typeof raw !== 'object') return Object.create(null);
  // 与 config.js pickOverrides 一致用无原型对象：防御原型污染（若文件被篡改成
  // 含 __proto__ 键，普通 {} 上赋值会污染原型链），两个出口对象口径统一。
  const out = Object.create(null);
  for (const [k, type] of Object.entries(ALLOWED)) {
    const v = raw[k];
    if (v === null || v === undefined) {
      // type === null 的键（未来新增的对象/数组型
      // 默认值）即使显式传 null 也不写占位——ALLOWED 从 DEFAULT_CONFIG 自动
      // 派生，不给这个门槛的话，任何新默认键都会静默获得「仅 null 可写」
      // 的入口（写面随常量自动扩张，无人显式评审）。可写集合的扩张必须
      // 显式过目，而不是隐式放宽。
      if (v === null && type !== null) out[k] = null; // 显式清空占位
      continue;
    }
    if (type === 'string') {
      if (typeof v === 'string') {
        const trimmed = v.trim();
        // trim 后为空 = 显式清空（写 null 占位，读取方回退默认），不落空串。
        out[k] = trimmed === '' ? null : trimmed;
      }
    } else if (type === 'number') {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        // 越界值改**钳制**、非正值**剔除**——与
        // normalizeConfig 的「>0 采纳 + 越界钳制」处理完全同口径（此前 0/负值
        // 被钳成 1ms 落盘，「写入即生效」反而把非法输入变成合法极小值；
        // 钳制语义：用户意图的「更大/更小」被保留，仅封顶/抬底）。
        let n = k === 'concurrency' ? Math.round(v) : v;
        if (k === 'review_timeout_ms') {
          n = Math.min(REVIEW_TIMEOUT_MAX, Math.max(1, n));
        }
        if (k === 'concurrency') {
          n = Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, n));
        }
        out[k] = n;
      }
      // NaN / Infinity / 非正值：剔除（非法态与钳制无关，不写入文件）。
    } else if (typeof v === type) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 读取插件自有配置文件（热读取：每次调用都重新落盘读）。
 *
 * @returns {object} 存活的覆盖字段（白名单内）；文件缺失/损坏/无覆盖 → {}。
 */
export function readFileConfig() {
  try {
    // 三个出口都返回无原型对象：与 sanitizePatch 的成功路径同一形态，
    // 保持「file-config 输出恒无原型」的不变量（防御原型污染）。
    if (!existsSync(PLUGIN_CONFIG_FILE)) return Object.create(null);
    const parsed = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return Object.create(null);
    return sanitizePatch(parsed);
  } catch (error) {
    // 不再空 catch 全吞。文件不存在 / 未写入不是错误（= 全默认）；
    // 其余 IO/解析错误（权限不足、目录不可读、JSON 损坏）记一条 warn 便于定位，
    // 同时保持「绝不抛错中断插件」的语义——读不到配置就回落默认继续跑。
    if (error?.code !== 'ENOENT') {
      console.warn(
        `[dsh-code-review] 读取插件配置文件失败，已回落默认配置（${PLUGIN_CONFIG_FILE}）：${String(error?.message ?? error)}`
      );
    }
    return Object.create(null); // 与另外两个出口同形态（恒无原型）
  }
}

/**
 * 写入/清空插件自有配置（merge 语义），原子落盘（临时文件 + rename，防并发半写）。
 *
 * @param {object} patch 要写入的字段（传 null 清空该字段；空对象 = 无改动）。
 * @returns {object} 落盘后的完整覆盖对象（sanitize 后，含 null 占位）。
 */
export function writeFileConfig(patch = {}) {
  const clean = sanitizePatch(patch);
  const next = { ...readFileConfig(), ...clean };
  try {
    mkdirSync(dirname(PLUGIN_CONFIG_FILE), { recursive: true });
    // 临时文件名带 进程号 + 时间戳 + 随机后缀——面板路由与
    // code_review_set_config 工具（可能分属不同进程/上下文）并发写同一个配置时，
    // 不再共用同一个 .tmp（旧实现固定 `${PLUGIN_CONFIG_FILE}.tmp`：一个写者
    // rename 后另一个写者会弄丢/覆盖对方的半成品）；失败时清理残留 tmp。
    const tmp = `${PLUGIN_CONFIG_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, PLUGIN_CONFIG_FILE);
    } catch (e) {
      // 写/改名失败：清理本次临时文件（文件名带本进程唯一后缀，不会误删他人），
      // 再把错误透出给调用方（工具 execute 负责展示给用户）。
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 清理失败也忽略，不掩盖原始错误 */
      }
      throw e;
    }
  } catch (error) {
    // 写失败不吞：调用方（工具 execute）负责把错误透出给用户。
    throw new Error(`插件配置写入失败（${PLUGIN_CONFIG_FILE}）：${String(error?.message ?? error)}`);
  }
  return next;
}
