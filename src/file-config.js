/**
 * file-config.js —— 插件自有配置文件层（运行真源，不依赖宿主 entry 配置回传）。
 *
 * 背景（2026-10-13 实测定性）：0.2.0-rc.2 宿主「面板保存」对第三方 bundle 插件
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
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REVIEW_HOME } from './task-book.js';

/** 插件自有配置文件绝对路径。 */
export const PLUGIN_CONFIG_FILE = join(REVIEW_HOME, 'plugin-config.json');

/** 可写白名单：键 = DEFAULT_CONFIG 键，值 = 该键的合法类型（null = 允许删除/清空）。 */
const ALLOWED = {
  review_model: 'string',
  report_dir: 'string',
  engine_bin: 'string',
  first_run: 'boolean',
  review_timeout_ms: 'number',
};

/**
 * 过滤出白名单内且类型合法的字段（null/undefined 表示显式清空 → 保留 null 占位，
 * 读取方见到 null 直接跳过，效果 = 恢复默认）。
 *
 * @param {object} raw 待清洗对象。
 * @returns {object} 干净对象（仅白名单键，非法值剔除）。
 */
export function sanitizePatch(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, type] of Object.entries(ALLOWED)) {
    const v = raw[k];
    if (v === null || v === undefined) {
      if (v === null) out[k] = null; // 显式清空占位
      continue;
    }
    if (type === 'string') {
      if (typeof v === 'string') out[k] = v.trim();
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
    if (!existsSync(PLUGIN_CONFIG_FILE)) return {};
    const parsed = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return sanitizePatch(parsed);
  } catch {
    /* 损坏/不可读 → 视为无覆盖（绝不抛错中断） */
    return {};
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
    const tmp = `${PLUGIN_CONFIG_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, PLUGIN_CONFIG_FILE);
  } catch (error) {
    // 写失败不吞：调用方（工具 execute）负责把错误透出给用户。
    throw new Error(`插件配置写入失败（${PLUGIN_CONFIG_FILE}）：${String(error?.message ?? error)}`);
  }
  return next;
}
