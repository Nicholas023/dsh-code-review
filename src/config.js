// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * config.js —— dsh-code-review 配置模型：默认值、归一化、宿主 volatile 解包。
 *
 * 设计要点：
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
 * 并发广度取值域（用户拍板）：
 *   - 默认 8 = 8 个会话并行审查（与引擎 agent.go `MaxConcurrency<=0 → 8` 对齐）；
 *   - 下限 1、上限 32：1 等价单线；上限防误填把 token 成本与端点压力打爆
 *     （vLLM 类平台并发过高会触发限流，成本控制权在用户侧设置）。
 */
export const CONCURRENCY_DEFAULT = 8;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 32;

/**
 * 评审超时上界（毫秒）：与默认值同为 6 小时（用户拍板取消严格超时后，
 * 此值只防引擎死循环把 serve 单例占死，正常评审不受限）。
 * 语义：进程级兜底「只防挂死」——不设上界则用户可填任意大值（如
 * Number.MAX_SAFE_INTEGER）让兜底形同失效，故显式钳制。
 */
export const REVIEW_TIMEOUT_MAX = 6 * 60 * 60 * 1000;

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
  // 评审进程级兜底（毫秒）：后台任务语义——**不再设严格时限**。
  // 前台不阻塞、会话无超时；评审慢模型/大仓库跑多久都行，此值只防引擎死循环
  // 把 serve 单例占死，故放宽到 6 小时（仅兜底，不截断正常评审）。
  // 引擎侧 OCR_LLM_TIMEOUT（**单请求**超时）已与任务整体解耦，独立默认 600s
  // 防 LLM 端点悬挂，见 review-exec.js 的 OCR_REQUEST_TIMEOUT_MS。
  // 上界 = REVIEW_TIMEOUT_MAX（同一常量，钳制入口见 normalizeConfig）。
  review_timeout_ms: REVIEW_TIMEOUT_MAX,
  // 并发评审开关：false = 单线顺序审查（默认，引擎显式
  // --concurrency 1）；true = 并行审查（引擎 --concurrency <concurrency>）。
  // ⚠ 开启并发会显著增加 token 消耗——这是用户侧成本控制问题，控制权交回用户
  // （默认关，用户明确开才开）。
  concurrency_enabled: false,
  // 并发广度：并行审查的会话数（1..32，默认 8）。仅 concurrency_enabled=true
  // 时生效；引擎 agent.go 默认 ≤0 → 8，插件层显式传值，不依赖引擎默认。
  concurrency: CONCURRENCY_DEFAULT,
};

/**
 * 宿主传入的配置可能带 volatile 热更新包装对象（实测：
 * 直接把包装对象交给合法化会以「实际: [object Object]」导致启用失败）。
 * 这里把这类字段解包成原值再走 normalizeConfig。
 *
 * @param {object} [raw] 宿主传入的配置快照。
 * @returns {object} 已解包的普通对象（可能仍是原始字段）。
 */
export function pickOverrides(raw) {
  if (!raw || typeof raw !== 'object') return Object.create(null);
  // 用无原型对象承接宿主键：普通对象字面量的 `out['__proto__'] = v` 会走
  // Object.prototype 的 setter 改写 out 的原型链，后续 normalizeConfig 沿
  // 原型链属性查找就会被注入值污染——null 原型对象没有该 setter，天然免疫。
  const out = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    // 危险键名一律跳过（__proto__ / constructor / prototype 不入配置）。
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    // volatile 字段本身是对象且【自有】value 字段时取其 value；否则原样保留。
    // hasOwnProperty 判定避免命中原型链上继承来的 value 属性（'value' in v
    // 会连继承属性一起算，带 value 字段的对象型设置会被无条件误解包）。
    const isWrapper =
      v && typeof v === 'object' && !Array.isArray(v) &&
      Object.prototype.hasOwnProperty.call(v, 'value');
    out[k] = isWrapper ? v.value : v;
  }
  return out;
}

// 合法化策略说明（原 JSDoc 误称下方有「数值范围与枚举的合法化
// 常量」，实际常量都定义在本文件顶部：CONCURRENCY_MIN/MAX、REVIEW_TIMEOUT_MAX）。
// review_model 不做白名单校验：选项动态来自 DSH 模型配置，「选中模型不可用 → 按
// 沿用会话模型处理」的回退语义由步骤 5 的 runner provider 注入期完成。这里
// 只保证类型正确、字符串非空。

/**
 * 归一化配置：默认值兜底 + 类型/范围校验 + 未知键剔除。
 *
 * 口径（与 file-config.js sanitizePatch 钳制逻辑
 * 对齐，禁止再出现「一边剔除一边钳制」的分叉）：
 *  - 非数值 / NaN / Infinity / ≤0 → 回退默认（0/负值没有「放宽/收窄」语义）；
 *  - review_timeout_ms / concurrency 越界 → **钳制**到合法区间（用户意图的
 *    「更大/更小」被保留，仅封顶/抬底）——判据：文件写入侧能钳、此处也必须
 *    钳，否则「面板写入 800s → 读回 600s」两头口径打架；非有限/非正值一律
 *    不采纳（写入侧同样剔除，两处同为「非法值不落地」）；
 *  - 字符串 trim 后为空 → 回退默认；未知键剔除。
 * 绝不抛错中断插件启用（插件骨架期韧性优先）。
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
    // 钳制上界 REVIEW_TIMEOUT_MAX（防「防挂死兜底」被超大值架空）+ 钳制下界 1ms
    // （面板路径的分数值如 0.5 会被 Math.min 放行成 0.5ms → 评审立即失败；
    // file-config.sanitizePatch 走 [1, MAX] 钳制，两个入口口径必须一致）。
    // 注意：钳制而非回落默认——用户意图（放宽超时）被保留，仅封顶/封底。
    cfg.review_timeout_ms = Math.min(REVIEW_TIMEOUT_MAX, Math.max(1, src.review_timeout_ms));
  }
  // 并发开关：仅接受布尔（面板/工具可能传 {value} 包装，pickOverrides 已解包）。
  if (typeof src.concurrency_enabled === 'boolean') {
    cfg.concurrency_enabled = src.concurrency_enabled;
  }
  // 并发广度：非有限或 ≤0 回退默认；有限正值先 Math.round 再钳制到
  // [CONCURRENCY_MIN, CONCURRENCY_MAX]——越界取极值而非回落默认（用户意图
  // 的「更大/更小」被保留）。
  // 此前的实现把 0/负值也钳成 CONCURRENCY_MIN=1
  // 落盘——「≤0 回退默认」只写在 JSDoc/注释里，实现实际是钳制；而面板写入
  // 侧 file-config.sanitizePatch 对非正值是剔除（读取方回读默认 8），同一
  // 输入两个入口两个结果。统一为「≤0 不采纳（回退默认）、越界钳制」：
  // 0/负值没有「放宽/收窄」意图可言，与 review_timeout_ms 的 >0 门槛同口径。
  // 注意顺序：钳制在「是否开启」之外独立完成——开启与否由开关决定，广度始终合法。
  if (Number.isFinite(src.concurrency) && src.concurrency > 0) {
    const n = Math.round(src.concurrency);
    cfg.concurrency = Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, n));
  }
  return cfg;
}
