/**
 * config.js —— dsh-code-review 配置模型：默认值、归一化、宿主 volatile 解包。
 *
 * 设计要点（与 宿主既有插件范式 的 config.js 同范式）：
 *  - 键名统一 snake_case（YAML 无嵌套歧义，宿主设置命名空间扁平字段）；
 *  - 插件所有可调项在这里集中声明，settings-schema.js 的字段与之一一对应；
 *  - normalizeConfig 是唯一合法化入口：合并默认、校验范围、洗掉未知键，
 *    工具/命令执行时都经它拿到的快照做决策（来源：设置 > 参数覆盖）。
 *
 * 零敏感：不硬编码任何平台内部标识；报告目录默认值用 ~ 展开（用户态），
 * 不写死任何绝对路径。
 */

/** 设置命名空间（与 settings-schema.js 的 SETTINGS_NS 保持一致）。 */
export const SETTINGS_NS = 'dsh-code-review';

/**
 * 默认配置。
 * review_model 语义：
 *   - "session"（默认）= 沿用会话模型（DSH 账户体系的 DeepSeek-V41-Flash）；
 *   - 其他值 = 用户在设置面板显式另选的评审模型（选项动态来自 DSH 模型
 *     配置，见 settings-schema.js 与 runner.js 的 provider 注入）。
 */
export const DEFAULT_CONFIG = {
  // 评审模型：'session' 或用户在设置面板选定的模型标识。
  review_model: 'session',
  // 报告目录：默认 ~/dsh-code-review-reports，按日期/仓库分子目录落盘。
  report_dir: '~/dsh-code-review-reports',
  // 引擎二进制路径：空 = 插件包内 bin/codecheck(.exe)，再回退 PATH 中 codecheck。
  engine_bin: '',
  // 首启引导标记：true 表示尚未引导确认，apply 时输出引导消息。
  first_run: true,
  // 评审进程级兜底（毫秒）：后台任务语义（2026-10-13 起）——**不再设严格时限**。
  // 前台不阻塞、会话无超时；评审慢模型/大仓库跑多久都行，此值只防引擎死循环
  // 把 serve 单例占死，故放宽到 6 小时（仅兜底，不截断正常评审）。
  // 引擎侧 OCR_LLM_TIMEOUT（**单请求**超时）已与任务整体解耦，独立默认 600s
  // 防 LLM 端点悬挂，见 review-exec.js 的 OCR_REQUEST_TIMEOUT_MS。
  review_timeout_ms: 6 * 60 * 60 * 1000,
};

/**
 * 宿主传入的配置可能带 volatile 热更新包装对象（Vision 插件实测踩坑：
 * 直接把包装对象交给合法化会以「实际: [object Object]」导致启用失败）。
 * 这里把这类字段解包成原值再走 normalizeConfig。
 *
 * @param {object} [raw] 宿主传入的配置快照。
 * @returns {object} 已解包的普通对象（可能仍是原始字段）。
 */
export function pickOverrides(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    // volatile 字段本身是对象且带 value 字段时取其 value；否则原样保留。
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v;
  }
  return out;
}

/** 数值范围与枚举的合法化常量（与 settings-schema.js 的约束保持一致）。 */
// 评审模型不做白名单校验：选项动态来自 DSH 模型配置，「选中模型不可用 → 按
// 沿用会话模型处理」的回退语义由步骤 5 的 runner provider 注入期完成。这里
// 只保证类型正确、字符串非空。 

/**
 * 归一化配置：默认值兜底 + 类型/范围校验 + 未知键剔除。
 * 任何非法/越界值一律回退默认，绝不抛错中断插件启用（插件骨架期韧性优先）。
 *
 * @param {object} [raw] 配置快照（可能不完整或含未知键）。
 * @returns {object} 合法化后的完整配置对象。
 */
export function normalizeConfig(raw) {
  const src = pickOverrides(raw);
  const cfg = { ...DEFAULT_CONFIG };

  if (typeof src.review_model === 'string' && src.review_model.trim() !== '') {
    cfg.review_model = src.review_model.trim();
  }
  if (typeof src.report_dir === 'string' && src.report_dir.trim() !== '') {
    cfg.report_dir = src.report_dir.trim();
  }
  if (typeof src.engine_bin === 'string') {
    cfg.engine_bin = src.engine_bin.trim();
  }
  if (typeof src.first_run === 'boolean') {
    cfg.first_run = src.first_run;
  }
  if (Number.isFinite(src.review_timeout_ms) && src.review_timeout_ms > 0) {
    cfg.review_timeout_ms = src.review_timeout_ms;
  }
  return cfg;
}
