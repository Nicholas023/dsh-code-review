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
 * （零网络；依赖仓库 node_modules 的 schemastery + 生产依赖树的 dsh-settings）
 */
import { pathToFileURL } from 'node:url';

/* ── 宿主同款运行环境（生产依赖树装载，同一棵 cordis/schemastery） ── */
const CORDIS_URL = pathToFileURL(
  'C:/Users/HP/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
).href;
const PROVIDER_URL = pathToFileURL(
  'C:/Users/HP/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js'
).href;
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
