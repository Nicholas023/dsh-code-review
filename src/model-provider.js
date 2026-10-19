// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * src/model-provider.js —— 评审模型源（步骤 5 核心）。
 *
 * 职责：把「评审模型标识」解析成引擎 codecheck 需要的 LLM 端点喂参。
 * 取数优先级（逐级回退，任何一步失败都不抛异常）：
 *   1. ctx（DSH 运行态官方取数口：ctx.agentDefaultModel；ctx.llm 未接入）——尽力而为；
 *   2. profile 配置（cordis.patch.yml 的 providers 段，js-yaml 只读；按 id/结构启发式识别）；
 *   3. 静态兜底已移除（红线：官方付费 API key 通道不得隐式存在——
 *      路由表为空时返回 null，由调用方明确报错并提示配置，绝不静默外呼）。
 *
 * 零敏感原则：
 *   - 不硬编码任何特定平台（一切平台/模型信息从 DSH 配置动态读入，用户自己配的）；
 *   - DEEPSEEK_OFFICIAL_DEFAULT 常量仅作「profile 缺省字段的回退引用」，不再用于
 *     生成任何路由（官方付费端点不参与隐式选路）；
 *   - key 只返回「引用名」（apiKeyEnv），真实值由 src/credentials.js 解析，绝不落盘。
 *
 * 对外接口（createModelSource 返回）：
 *   - listCandidates(): 设置面板「评审模型」选择器候选。value 为唯一路由标识
 *     routeKey（providerLabel|modelId，去重键与 value 合一）；
 *     首页固定为 'session'（沿用会话模型）。'source' 字段标记路由来源，
 *     取值见 routes() 的 JSDoc：'config-deepseek' | 'config-alternate'
 *     （候选遍历只来自 routes()，session 首项不带 source）。
 *     createSettingsSchema 会把候选拼进设置描述文本（value/label/description）。
 *   - currentSessionModel(): 会话当前模型 id（拿不到回 ''，由 resolveProvider
 *     回退至用户配置首条路由，路由表空则返回 null）
 *   - resolveProvider(modelId): → { url, protocol, model, keyEnv, providerLabel, extraBody? }
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolveDshRoot } from './config.js';

/** 评审模型「沿用会话模型」的保留标识（与 settings-schema / config 一致）。 */
export const SESSION_MODEL = 'session';

/** 静态兜底：DeepSeek 官方 OpenAI 兼容端点（公开信息，非敏感）。 */
export const DEEPSEEK_OFFICIAL_DEFAULT = {
  providerLabel: 'DeepSeek 官方',
  url: 'https://api.deepseek.com',
  keyEnv: 'DEEPSEEK_API_KEY',
  protocol: 'openai', // engine 协议：openai = chat/completions
  models: ['deepseek-flash', 'deepseek-v4-pro'],
};

/** 引擎可识别的协议名（与引擎 internal/llm/protocol.go 对齐）。 */
function engineProtocolOf(dshApi /* DSH 配置的 api 字段，如 openai-completions */) {
  const api = String(dshApi ?? '').toLowerCase();
  if (api.includes('anthropic')) return 'anthropic';
  // openai-responses 与 chat/completions 的请求体/端点并不
  // 互通（引擎 protocol.go 中 ProtocolOpenAIResponses 与 ProtocolOpenAIChatCompletions
  // 是两个独立协议）——此前被静默归一成 'openai'，对仅支持 responses 的端点
  // 产生静默不可用请求。返回独立协议名：引擎支持则正确走 responses，不支持则
  // 显式报错，而不是静默降级。
  if (api.includes('responses')) return 'openai-responses';
  return 'openai'; // openai-completions / 缺省 → chat/completions 兼容
}

/** 读 profile 的 cordis.patch.yml（只读，js-yaml 从生产依赖层 createRequire）。 */
function loadProfileLlmConfig() {
  const require = createRequire(import.meta.url);
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    return null; // 开发环境若 junction 未建也能继续（路由表可能为空，resolveProvider 返回 null）
  }
  // 根目录统一走 resolveDshRoot：优先 DSH_HOME，回退 ~/.dsh（issue #13）。
  const profilesRoot = join(resolveDshRoot(), 'profiles');
  // readdirSync 包 try/catch——目录无读权限（EACCES）或
  // existsSync 后被删的竞态不再一路抛到调用方（文件头约定「任何一步失败都
  // 不抛异常」）；目录名排序使多 profile 时「取第一个 deepseek/alternate」的
  // 结果确定（不再依赖 OS 返回序）。
  let entries;
  try {
    // sort comparator 拆平嵌套三元（风格红线）。
    entries = readdirSync(profilesRoot, { withFileTypes: true }).sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const patch = join(profilesRoot, entry.name, 'cordis.patch.yml');
    if (!existsSync(patch)) continue;
    try {
      const doc = yaml.load(readFileSync(patch, 'utf8'));
      let rows = Array.isArray(doc) ? doc : [];
      if (Array.isArray(doc?.services)) rows = doc.services;
      for (const row of rows) {
        if (typeof row?.id !== 'string') continue;
        const cfg = row.config ?? {};
        // DeepSeek 为公开公司名，按 id 启发式识别官方模型段（不绑定任何特定插件 id）；
        // 其余带 providers 结构的段作为备选模型源。
        if (row.id.toLowerCase().includes('deepseek')) {
          candidates.push({ profile: entry.name, kind: 'deepseek', config: cfg });
        } else if (cfg.providers && typeof cfg.providers === 'object' && !cfg.models) {
          candidates.push({ profile: entry.name, kind: 'alternate', config: cfg });
        }
      }
    } catch {
      // 单个 profile 解析失败不影响其他。
    }
  }
  return candidates;
}

/**
 * 判定端点 URL 是否指向 DeepSeek 官方付费 API（红线过滤用）。
 *
 * 用 **hostname 比较**而非字符串全等：YAML 里 `https://api.deepseek.com/`（尾
 * 斜杠）、`https://api.deepseek.com:443`（显式端口）、`http://api.deepseek.com`
 * 都指向同一官方付费端点，字符串比较会让红线过滤被这些常见写法绕过。
 *
 * @param {string} u 端点 URL。
 * @returns {boolean} true = 官方付费端点（不得生成路由）。
 */
function isOfficialPaidUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    return new URL(u).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    // 非法 URL：退回子串判断——宁可误拦（最坏结果 = 该路由不生成，调用方
    // 明确报错），也不能因解析失败放行一个可能指向官方付费通道的地址。
    return u.includes('api.deepseek.com');
  }
}

/**
 * 转义 routeKey 中的分隔符 `|`：routeKey 形如 `${providerLabel}|${modelId}`，
 * 显示名含 `|` 会让键含歧义（无法唯一还原 label/modelId）。label 侧转义为 `\|`。
 * @param {string} label 显示名。
 * @returns {string} 转义后的 label。
 */
function escapeRouteLabel(label) {
  return String(label).replace(/\|/g, '\\|');
}

/**
 * 把 DSH 模型配置归一成统一路由表：
 * [{ modelId, displayLabel, providerLabel, url, keyEnv, protocol, thinkingFormat?, source }]
 * source: 'config-deepseek' | 'config-alternate'
 */
function buildModelRoutes() {
  const routes = [];
  const profiles = loadProfileLlmConfig() ?? [];

  const deep = profiles.find((p) => p.kind === 'deepseek');
  if (deep) {
    // deep 分支：profile 提供 baseURL/apiKeyEnv/api 时优先采用——否则会把
    // profile 里配置的端点与凭证引用（企业代理、第三方 DeepSeek 兼容网关）
    // 静默丢弃（用户配了 baseURL/apiKeyEnv 却被发往 api.deepseek.com + 用
    // DEEPSEEK_API_KEY）。**配置缺失时不再生成路由**：缺省 url 即官方付费
    // 端点，整组路由由 isOfficialPaidUrl 判掉（见下方），绝不会因缺配置而
    // 悄悄走官方通道。宿主官方适配器只配 models（账号体系认证），故其路由
    // 在此被整体拦下。
    const deepCfg = deep.config;
    // providerLabel 此前无条件写死「DeepSeek 官方」——
    // profile 若配置了 displayName（指向企业代理/第三方兼容网关），显示名与
    // 真实端点不符会误导用户。配置了 displayName 则用配置值（routeKey 同步
    // 跟随，保持「显示与端点一致」；旧 routeKey 值由 resolveProvider 的裸 id
    // 兼容与表首回退兜底降级，不会硬失败）。
    // 无配置时的兜底显示名改引常量——硬编码
    // 'DeepSeek 官方' 与 DEEPSEEK_OFFICIAL_DEFAULT.providerLabel 是同一真源，
    // 手写一份后常量改名/加前缀语境时容易漂移成两处不同文案。
    const deepLabel = typeof deepCfg?.displayName === 'string' && deepCfg.displayName.trim()
      ? deepCfg.displayName.trim()
      : DEEPSEEK_OFFICIAL_DEFAULT.providerLabel;
    // 判定用 trim、返回也 trim：配置值带首尾空白时「判定通过」但原样下发，
    // 端点字符串里混入空格会让 HTTP 层拼出坏 URL。判定与产出必须同一清洗口径。
    const hasBaseURL = typeof deepCfg?.baseURL === 'string' && deepCfg.baseURL.trim();
    const url = typeof deepCfg?.baseURL === 'string' && deepCfg.baseURL.trim() ? deepCfg.baseURL.trim() : DEEPSEEK_OFFICIAL_DEFAULT.url;
    // 官方付费通道红线（用户拍板）：baseURL 未配置 → 落到官方默认
    // 端点（api.deepseek.com + DEEPSEEK_API_KEY），整组 deep 路由**不生成**。
    // 账号体系适配器只配 models（serve 无会话上下文时账号体系不可复用），
    // 留下这批路由等于给「解析失败回退表首」埋官方付费入口。第三方兼容网关
    // 显式配了非官方 baseURL 的照常生成，不受影响。
    // 判定提前短路：未配 baseURL 或端点为官方付费默认时直接跳过——
    // keyEnv/protocol 只在确认非官方后才计算，避免 isOfficialPaid 一旦被绕过
    // 时用官方默认 keyEnv（DEEPSEEK_API_KEY）拼出一条可用付费路由。
    if (hasBaseURL && !isOfficialPaidUrl(url)) {
      const keyEnv = typeof deepCfg?.apiKeyEnv === 'string' && deepCfg.apiKeyEnv.trim() ? deepCfg.apiKeyEnv.trim() : DEEPSEEK_OFFICIAL_DEFAULT.keyEnv;
      const protocol = engineProtocolOf(deepCfg?.api);
      // DSH 0.2.1：deepseek-account 路由不再接受 `models` 目录（模型改由账号
      // GET /models 端点列出，条目里残留 models 会让该路由插件加载即失败），
      // 单模型调整迁到 `modelOverrides.<id>`。这里对两种形态都做尽力解析——
      // 数组 models（旧/第三方兼容网关）优先，缺失时回退 modelOverrides 的键集
      // （仅有被覆盖过的模型，非全量目录；全量目录在账号侧，配置里拿不到）。
      const m = deepCfg.models;
      const models = Array.isArray(m)
        ? m
        : (deepCfg.modelOverrides && typeof deepCfg.modelOverrides === 'object'
          ? Object.keys(deepCfg.modelOverrides).map((id) => ({ id }))
          : []);
      for (const mm of models) {
        const id = mm?.id ?? mm?.name;
        if (!id) continue;
        routes.push({
          modelId: String(id),
          displayLabel: mm?.name ?? String(id),
          providerLabel: deepLabel,
          url,
          keyEnv,
          protocol,
          source: 'config-deepseek',
          thinkingFormat: mm?.thinkingFormat,
          routeKey: `${escapeRouteLabel(deepLabel)}|${String(id)}`,
        });
      }
    }
  }

  const alt = profiles.find((p) => p.kind === 'alternate');
  if (alt) {
    const providers = alt.config.providers;
    if (providers && typeof providers === 'object') {
      for (const [pname, p] of Object.entries(providers)) {
        const baseURL = typeof p?.baseURL === 'string' ? p.baseURL.trim() : '';
        // 无端点（baseURL 为空/缺失）的 provider 不生成路由：它会在候选列表中
        // 以「可选模型」出现，用户选中却拿到 url:'' 的断端点，静默回落到引擎
        // 自身配置（或官方付费通道）且无明确报错。deepseek 分支同样滤掉不可用
        // 端点，两个分支保持一致。
        if (!baseURL) continue;
        const keyEnv = typeof p?.apiKeyEnv === 'string' ? p.apiKeyEnv.trim() : '';
        const compat = p?.compat && typeof p.compat === 'object' ? p.compat : {};
        const models = Array.isArray(p?.models) ? p.models : [];
        for (const mm of models) {
          const id = mm?.id ?? mm?.name;
          if (!id) continue;
          const label = typeof p?.displayName === 'string' && p.displayName.trim() ? p.displayName.trim() : pname;
          routes.push({
            modelId: String(id),
            displayLabel: mm?.name ?? String(id),
            providerLabel: label,
            url: baseURL,
            keyEnv,
            protocol: engineProtocolOf(p?.api),
            thinkingFormat: compat.thinkingFormat,
            source: 'config-alternate',
            routeKey: `${escapeRouteLabel(label)}|${String(id)}`,
          });
        }
      }
    }
  }
  // 官方兜底路由：**不再生成**（用户红线）。
  // 历史行为：routes 为空时补 DEEPSEEK_OFFICIAL_DEFAULT 两条官方路由
  // （api.deepseek.com + DEEPSEEK_API_KEY 付费 API key 通道）——任何解析失败
  // 都会悄悄落到官方付费端点，serve 后台一轮评审跑几分钟、轮轮烧钱，用户
  // 一觉醒来账单见底。红线：**任何路径（兜底/显式/回退）都不得走官方付费
  // 通道**；routes 空就保持空，由 resolveProvider 返回 null，调用方明确失败
  // 并提示配置评审模型，而不是静默花钱。
  // 补充拦截：deep 分支（profile 的 deepseek 适配器）同样滤掉官方默认端点——
  // 账号体系适配器只配 models 不给 baseURL，能走的只有官方付费 API key 通道，
  // 该场景下整组官方路由不生成；用户显式配置的第三方 DeepSeek 兼容网关
  // （baseURL 非官方默认）不受影响。
  return routes;
}

/**
 * 创建模型源（评审模型选项 + 端点解析）。
 *
 * @param {object} [ctx] DSH 会话上下文（apply 里的 ctx；无 ctx 时走配置，路由表为空则 resolveProvider 返回 null）。
 * @returns {{
 *   listCandidates: () => Array<{value:string, label:string, description?:string, source?:string}>,
 *   currentSessionModel: () => string|'',
 *   resolveProvider: (modelId: string) => {url:string, protocol:string, model:string, keyEnv:string, providerLabel:string, extraBody?:object}|null,
 * }}
 * 注：listCandidates 的 value 是 routeKey（providerLabel|modelId，与去重键
 * 合一），不是裸 modelId；source 字段标记路由来源（'config-deepseek' |
 * 'config-alternate'），消费方（settings-schema 等）
 * 只用 value/label/description，source 为增量透传——且只有**带配置来源的
 * 路由**才有该字段（session 首候选无配置来源，不带 source）。
 * 注：io 注入位已删除——env 声明从未被引用（resolveProvider 只返回
 * keyEnv 引用名，真实值由 credentials.js 解析），属死代码。
 */
export function createModelSource(ctx) {
  let routesCache = null;
  const routes = () => {
    if (!routesCache) routesCache = buildModelRoutes();
    return routesCache;
  };

  /** 会话当前模型：优先 ctx 官方取数口；拿不到回 ''（由 resolveProvider 回退至用户配置首条路由，路由表空则返回 null）。 */
  function currentSessionModel() {
    // 未声明的可选服务必须经 ctx.get(name) 读取，不能直接属性访问
    // （docs/cordis-api/context.md：`ctx.<name>` 的 shadow 遍历对未注入服务可能抛错；
    // agentDefaultModel 不在本插件静态 inject 内）。旧写法 `ctx?.agentDefaultModel`
    // 在 0.2.1 上按未注入服务处理，会静默落空导致会话模型透传失效。
    try {
      const defaultModel = ctx?.get?.('agentDefaultModel');
      const sel = defaultModel?.currentSelection?.();
      if (sel?.model) return String(sel.model);
    } catch {
      /* 尽力而为 */
    }
    return '';
  }

  /** 面板「评审模型」选择器候选（session 置顶，其余按 provider 分组去重）。 */
  function listCandidates() {
    const seen = new Set();
    const out = [{ value: SESSION_MODEL, label: '沿用会话模型', description: '默认：DSH 会话当前模型；后台无会话上下文时回退用户配置首条路由' }];
    for (const r of routes()) {
      // value 改为唯一路由标识 routeKey（providerLabel|modelId）
      // ——此前 value 只有 modelId 而去重键才是 provider|modelId，两个不同
      // provider 存在同名模型时会同时展示两条，用户选其一也解析到 routes 里
      // 第一条（选择 A 实际走 B 的端点/凭证）。resolveProvider 兼容旧格式裸 id。
      const key = r.routeKey;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        value: r.routeKey,
        label: r.displayLabel,
        description: `${r.providerLabel}${r.protocol !== 'openai' ? `（${r.protocol}）` : ''}`,
        // source 增量透传给消费方（switch-model-e2e
        // 需要区分「用户配置路由」与其他来源；settings-schema 等公共
        // 消费方只用 value/label/description，加字段不破坏）。
        source: r.source,
      });
    }
    return out;
  }

  /**
   * 评审模型 → 引擎端点喂参。
   * modelId 缺省/'session'：先取会话当前模型；取不到则回退至用户配置首条路由，
   * 路由表为空则返回 null（官方付费兜底已移除，由调用方明确报错并提示配置）。
   * 找不到对应路由
   * → 回退表内第一条可用路由（表序 = 用户配置优先，保持用户
   * 配置的端点/凭证/协议语义）。与 settings-schema 的用户面承诺同一口径。
   * @returns {{url, protocol, model, keyEnv, providerLabel, extraBody?, source, resolvedFrom}} 或 null（连路由都没有时）
   */
  function resolveProvider(modelId) {
    let target = modelId && modelId !== SESSION_MODEL ? String(modelId) : '';
    let resolvedFrom = '';
    if (!target) {
      const sess = currentSessionModel();
      if (sess) {
        target = sess;
        resolvedFrom = 'session';
      } else {
        // 会话模型拿不到（serve 后台无会话上下文）且未显式指定模型：
        // 不再回退官方付费默认模型（红线——隐式官方兜底已整体
        // 移除）。保持 target 空串走下方 chosen-null 路径：routes 表首 =
        // 用户配置的第一条路由；routes 全空则由调用方失败并提示配置。
        resolvedFrom = 'fallback';
      }
    } else {
      resolvedFrom = 'explicit';
    }
    // 精确匹配：先按唯一路由标识 routeKey（新格式），再兼容旧格式裸 modelId
    // （同 id 多 provider 时不再「选 A 走 B」）。
    const chosen = routes().find((r) => r.routeKey === target) ?? routes().find((r) => r.modelId === target) ?? null;
    if (!chosen) {
      // 选中模型不存在（配置被删/改）/ session 兜底时，
      // 不再无条件回官方付费端点——优先在既有路由中挑第一条（表序 =
      // 用户配置优先，保持用户配置的端点/凭证/协议语义）；路由表全空才
      // 返回 null（官方付费兜底已于 移除：隐式调用官方 API key
      // 通道 = 未知账单，属红线。解析失败由调用方明确报错并提示配置评审
      // 模型，而不是悄悄花钱）。resolvedFrom 仍标 fallback，调用方可看到
      // 回退事实。
      const first = routes().find((r) => r.url) ?? null;
      if (!first) return null;
      const ep = {
        url: first.url,
        protocol: first.protocol,
        model: first.modelId,
        keyEnv: first.keyEnv,
        providerLabel: first.providerLabel,
        source: first.source,
        resolvedFrom: resolvedFrom === 'explicit' ? 'fallback-from-explicit' : 'fallback',
      };
      // vLLM 兼容端点（chat-template）：回退命中的 alternate 路由同样携带
      // 关闭思维链的 extraBody——与正常命中行为一致，不再静默丢失。
      if (first?.thinkingFormat === 'chat-template') {
        ep.extraBody = { chat_template_kwargs: { enable_thinking: false } };
      }
      return ep;
    }
    const ep = {
      url: chosen.url,
      protocol: chosen.protocol,
      model: chosen.modelId,
      keyEnv: chosen.keyEnv,
      providerLabel: chosen.providerLabel,
      source: chosen.source,
      resolvedFrom,
    };
    // vLLM 兼容端点（DSH 配 thinkingFormat=chat-template）：引擎评审不需要思维链，
    // 若直连端点支持 chat_template_kwargs 则随端点携带（引擎环境注入位据此生成 extra_body）。
    if (chosen.thinkingFormat === 'chat-template') {
      ep.extraBody = { chat_template_kwargs: { enable_thinking: false } };
    }
    return ep;
  }

  return { listCandidates, currentSessionModel, resolveProvider };
}
