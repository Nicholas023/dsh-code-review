/**
 * src/model-provider.js —— 评审模型源（步骤 5 核心）。
 *
 * 职责：把「评审模型标识」解析成引擎 codecheck 需要的 LLM 端点喂参。
 * 取数优先级（逐级回退，任何一步失败都不抛异常）：
 *   1. ctx（DSH 运行态官方取数口：ctx.llm / ctx.agentDefaultModel）——尽力而为；
 *   2. profile 配置（cordis.patch.yml 的  /  段，js-yaml 只读）；
 *   3. 静态兜底（仅 DeepSeek 官方公开端点与公开模型名，零敏感）。
 *
 * 零敏感原则：
 *   - 不硬编码任何特定平台（等一律从 DSH 配置动态读入，用户自己配的）；
 *   - 静态兜底只含 api.deepseek.com + deepseek-flash/deepseek-v4-pro（官方公开信息）；
 *   - key 只返回「引用名」（apiKeyEnv），真实值由 src/credentials.js 解析，绝不落盘。
 *
 * 对外接口（createModelSource 返回）：
 *   - listCandidates(): 设置面板「评审模型」选择器候选（[session, ...各模型 id]）
 *   - currentSessionModel(): 会话当前模型 id（拿不到回 ''，由 resolveProvider 兜底）
 *   - resolveProvider(modelId): → { url, protocol, model, keyEnv, providerLabel, extraBody? }
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

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
  return 'openai'; // openai-completions / openai-responses / 缺省 → chat/completions 兼容
}

/** 读 profile 的 cordis.patch.yml（只读，js-yaml 从生产依赖层 createRequire）。 */
function loadProfileLlmConfig() {
  const require = createRequire(import.meta.url);
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    return null; // 开发环境若 junction 未建也能继续（走 ctx/静态兜底）
  }
  const profilesRoot = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(profilesRoot)) return null;
  const candidates = [];
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const patch = join(profilesRoot, entry.name, 'cordis.patch.yml');
    if (!existsSync(patch)) continue;
    try {
      const doc = yaml.load(readFileSync(patch, 'utf8'));
      const rows = Array.isArray(doc?.services) ? doc.services : Array.isArray(doc) ? doc : [];
      for (const row of rows) {
        if (typeof row?.id !== 'string') continue;
        if (row.id === '' || row.id === '') {
          candidates.push({ profile: entry.name, kind: 'deepseek', config: row.config ?? {} });
        } else if (row.id === '' || row.id === '') {
          candidates.push({ profile: entry.name, kind: 'pi-ai', config: row.config ?? {} });
        }
      }
    } catch {
      // 单个 profile 解析失败不影响其他。
    }
  }
  return candidates;
}

/**
 * 把 DSH 模型配置归一成统一路由表：
 * [{ modelId, displayLabel, providerLabel, url, keyEnv, protocol, thinkingFormat?, source }]
 * source: 'config-deepseek' | 'config-pi-ai' | 'fallback-deepseek'
 */
function buildModelRoutes() {
  const routes = [];
  const profiles = loadProfileLlmConfig() ?? [];

  const deep = profiles.find((p) => p.kind === 'deepseek');
  if (deep) {
    const m = deep.config.models;
    const models = Array.isArray(m) ? m : [];
    for (const mm of models) {
      const id = mm?.id ?? mm?.name;
      if (!id) continue;
      routes.push({
        modelId: String(id),
        displayLabel: mm?.name ?? String(id),
        providerLabel: 'DeepSeek 官方',
        url: DEEPSEEK_OFFICIAL_DEFAULT.url,
        keyEnv: DEEPSEEK_OFFICIAL_DEFAULT.keyEnv,
        protocol: 'openai',
        source: 'config-deepseek',
        thinkingFormat: mm?.thinkingFormat,
      });
    }
  }
  if (routes.length === 0) {
    // 配置缺失/未装官方适配器时的兜底（公开信息）。
    for (const id of DEEPSEEK_OFFICIAL_DEFAULT.models) {
      routes.push({
        modelId: id,
        displayLabel: id,
        providerLabel: DEEPSEEK_OFFICIAL_DEFAULT.providerLabel,
        url: DEEPSEEK_OFFICIAL_DEFAULT.url,
        keyEnv: DEEPSEEK_OFFICIAL_DEFAULT.keyEnv,
        protocol: DEEPSEEK_OFFICIAL_DEFAULT.protocol,
        source: 'fallback-deepseek',
      });
    }
  }

  const pi = profiles.find((p) => p.kind === 'pi-ai');
  if (pi) {
    const providers = pi.config.providers;
    if (providers && typeof providers === 'object') {
      for (const [pname, p] of Object.entries(providers)) {
        const baseURL = typeof p?.baseURL === 'string' ? p.baseURL : '';
        const keyEnv = typeof p?.apiKeyEnv === 'string' ? p.apiKeyEnv : '';
        const compat = p?.compat && typeof p.compat === 'object' ? p.compat : {};
        const models = Array.isArray(p?.models) ? p.models : [];
        for (const mm of models) {
          const id = mm?.id ?? mm?.name;
          if (!id) continue;
          routes.push({
            modelId: String(id),
            displayLabel: mm?.name ?? String(id),
            providerLabel: p?.displayName ?? pname,
            url: baseURL,
            keyEnv,
            protocol: engineProtocolOf(p?.api),
            thinkingFormat: compat.thinkingFormat,
            source: 'config-pi-ai',
          });
        }
      }
    }
  }
  return routes;
}

/**
 * 创建模型源（评审模型选项 + 端点解析）。
 *
 * @param {object} [ctx] DSH 会话上下文（apply 里的 ctx；无 ctx 时走配置/兜底，便于开发期测试）。
 * @param {object} [io] 可注入 IO（测试位）：{ env }。
 * @returns {{
 *   listCandidates: () => Array<{value:string, label:string, description?:string}>,
 *   currentSessionModel: () => string|'',
 *   resolveProvider: (modelId: string) => {url:string, protocol:string, model:string, keyEnv:string, providerLabel:string, extraBody?:object}|null,
 * }}
 */
export function createModelSource(ctx, io = {}) {
  const env = io.env ?? process.env;
  let routesCache = null;
  const routes = () => {
    if (!routesCache) routesCache = buildModelRoutes();
    return routesCache;
  };

  /** 会话当前模型：优先 ctx 官方取数口；拿不到回 ''（由 resolveProvider 兜底官方默认）。 */
  function currentSessionModel() {
    try {
      const sel = ctx?.agentDefaultModel?.currentSelection?.();
      if (sel?.model) return String(sel.model);
      const m = ctx?.llm?.listProviders?.().length >= 0 ? null : null; // 占位防误用
      void m;
    } catch {
      /* 尽力而为 */
    }
    return '';
  }

  /** 面板「评审模型」选择器候选（session 置顶，其余按 provider 分组去重）。 */
  function listCandidates() {
    const seen = new Set();
    const out = [{ value: SESSION_MODEL, label: '沿用会话模型', description: '默认：DSH 会话当前模型（官方 DeepSeek-V41-Flash）' }];
    for (const r of routes()) {
      const key = `${r.providerLabel}|${r.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        value: r.modelId,
        label: r.displayLabel,
        description: `${r.providerLabel}${r.protocol !== 'openai' ? `（${r.protocol}）` : ''}`,
      });
    }
    return out;
  }

  /**
   * 评审模型 → 引擎端点喂参。
   * modelId 缺省/'session'：先取会话当前模型，取不到回官方默认 deepseek-flash。
   * 找不到对应路由 → 回官方默认（deepseek-flash仍在官方路由里必有）。
   * @returns {{url, protocol, model, keyEnv, providerLabel, extraBody?, source, resolvedFrom}} 或 null（联路由都没有时）
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
        target = DEEPSEEK_OFFICIAL_DEFAULT.models[0]; // deepseek-flash
        resolvedFrom = 'fallback';
      }
    } else {
      resolvedFrom = 'explicit';
    }
    // 精确匹配 modelId；同 id 多 provider 时优先官方，其次配置序。
    const exact = routes().filter((r) => r.modelId === target);
    const chosen = exact[0] ?? null;
    if (!chosen) {
      // 选中的模型不存在（配置被删/改）/ session 兜底：一律回「沿用会话模型」语义
      // = 官方默认 deepseek-flash（config.js 的 review_model description 承诺：
      // 「选中的模型不可用时，运行时自动按沿用会话模型处理」）。
      return {
        url: DEEPSEEK_OFFICIAL_DEFAULT.url,
        protocol: DEEPSEEK_OFFICIAL_DEFAULT.protocol,
        model: DEEPSEEK_OFFICIAL_DEFAULT.models[0],
        keyEnv: DEEPSEEK_OFFICIAL_DEFAULT.keyEnv,
        providerLabel: DEEPSEEK_OFFICIAL_DEFAULT.providerLabel,
        source: 'fallback-deepseek',
        resolvedFrom: resolvedFrom === 'explicit' ? 'fallback-from-explicit' : 'fallback',
      };
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
