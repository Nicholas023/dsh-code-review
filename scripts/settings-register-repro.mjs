/**
 * scripts/settings-register-repro.mjs —— 宿主等价复现：settings.register 链路冒烟。
 *
 * 背景（2026-10-12 生产实装排障）：插件激活成功后 DSH 设置页不出现
 * 「智能代码审查」分区。宿主设置页靠 `ctx.remote.settings.describe()`
 * 列出**所有已注册命名空间**（dsh-api-settings-controller →
 * `settings.describe({redactSecrets:true})`）。只要 `register` 真跑通，
 * describe 必然带着该命名空间。因此复现点 = 用宿主同款 SettingsProvider
 * （生产依赖树 @deepseek-ai/dsh-settings）注册我们的 schema：
 *   ① register 是否抛（同步 resolve 求值，schema 不兼容会当场炸）；
 *   ② describe 是否列出该命名空间；
 *   ③ schema.toJSON()（客户端渲染源）是否可序列化。
 *
 * 运行：node scripts/settings-register-repro.mjs
 * （零网络；依赖仓库 node_modules 的 schemastery + 生产依赖树的 dsh-settings。
 *   生产依赖树路径不硬编码：由 resolveHostEntry 动态探测，可用环境变量
 *   DSH_PROD_NODE_MODULES 显式指定——便于在本机之外的机器上复现。）
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析「宿主依赖树」（生产 DSH 安装）中某个 @deepseek-ai 子包的入口文件。
 *
 * 公开仓库不硬编码任何本机绝对路径：按候选根目录顺序探测，命中即用；
 * 全不命中时抛出带指引的错误（提示用 DSH_PROD_NODE_MODULES 显式指定）。
 * 候选来源：
 *   ① 环境变量 DSH_PROD_NODE_MODULES（显式覆盖，最优先）；
 *   ② Windows npm 全局：%APPDATA%/npm/node_modules；
 *   ③ *nix 用户级 npm 全局：~/.npm-global/lib/node_modules；
 *   ④ DSH profile 依赖层：~/.dsh/profiles/node_modules（含指向全局包的 junction）。
 * 每个根下再尝试两种布局：`@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`
 * （嵌套在生产包内）与 `@deepseek-ai/<pkg>`（直接挂载）。
 */
function resolveHostEntry(pkgName) {
  const candidates = [];
  if (process.env.DSH_PROD_NODE_MODULES) {
    candidates.push(process.env.DSH_PROD_NODE_MODULES);
  }
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules'));
  candidates.push(join(homedir(), '.dsh', 'profiles', 'node_modules'));

  for (const root of candidates) {
    const nested = join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', pkgName, 'lib', 'index.js');
    if (existsSync(nested)) return nested;
    const flat = join(root, '@deepseek-ai', pkgName, 'lib', 'index.js');
    if (existsSync(flat)) return flat;
  }
  throw new Error(
    `找不到宿主依赖树中的 @deepseek-ai/${pkgName}。` +
      '请设置环境变量 DSH_PROD_NODE_MODULES 指向生产依赖树的 node_modules 根目录（其下应有 @deepseek-ai/dsh）。' +
      `\n已尝试的候选根：\n  ${candidates.join('\n  ')}`
  );
}

/* ── 宿主同款运行环境（生产依赖树装载，同一棵 cordis/schemastery） ── */
const CORDIS_URL = pathToFileURL(resolveHostEntry('cordis')).href;
const PROVIDER_URL = pathToFileURL(resolveHostEntry('dsh-settings')).href;
const { Context } = await import(CORDIS_URL);
const { SettingsProvider } = await import(PROVIDER_URL);

/* ── 本插件的 schema（与 apply 同款工厂） ── */
const { createSettingsSchema, SETTINGS_NS } = await import('./../src/settings-schema.js');

/* ── 真实 Cordis Context（Service 基类构造需要 ctx.reflect） ── */
const ctx = new Context();
ctx.logger = console;
const provider = new SettingsProvider(ctx);

/* ── ① register：同步 resolve 求值，抛错即 schema 不兼容/命名空间冲突 ── */
let scope = null;
let registerError = null;
try {
  scope = provider.register(SETTINGS_NS, createSettingsSchema([]), {});
} catch (error) {
  registerError = error;
}
console.log(`① register(${SETTINGS_NS}) : ${registerError ? `抛错 ✘ — ${String(registerError?.message ?? registerError)}` : 'OK ✔'}`);
if (registerError) process.exit(1);

/* ── ② describe：设置页分区的数据源 ── */
const described = provider.describe({ redactSecrets: true });
const ns = described.find((d) => d.ns === SETTINGS_NS);
console.log(`② describe 命名空间数 : ${described.length}；含 "${SETTINGS_NS}" ? ${ns ? '是 ✔' : '否 ✘'}`);
if (ns) console.log(`   describe.ns=${ns.ns} revision=${ns.revision} value=${JSON.stringify(ns.value)} applies=${ns.applies}`);

/* ── ③ schema.toJSON()：客户端渲染表单的 wire 形态 ── */
let json = null;
let jsonError = null;
try {
  json = scope ?? (await Promise.resolve());
  // toJSON 是 schemastery schema 实例方法，先取回 schema 引用。
} catch (error) {
  jsonError = error;
}
let toJson = null;
let toJsonError = null;
try {
  toJson = createSettingsSchema([]).toJSON();
} catch (error) {
  toJsonError = error;
}
console.log(`③ schema.toJSON() : ${toJsonError ? `抛错 ✘ — ${String(toJsonError?.message ?? toJsonError)}` : 'OK ✔'}`);
if (toJson) console.log(`   type=${toJson.type} 顶层键=${Object.keys(toJson.properties ?? {}).join(',')}`);

const failed = registerError || !ns || toJsonError;
console.log(failed ? '\n✘ 链路断裂：设置分区不会出现' : '\n✔ 全部通过：register/describe/toJSON 链路健康，生产无分区问题不在本链路');
process.exit(failed ? 1 : 0);
