// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scripts/settings-register-repro.mjs —— 宿主等价复现：settings.register 链路冒烟。
 *
 * 背景（生产实装排障）：插件激活成功后 DSH 设置页不出现
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
// register 与 toJSON 复用同一个 schema 实例——原实现
// 各自 new 一个实例，「注册的 schema」与「序列化验证的 schema」不是同一个
// 对象（生产里宿主对 register 到的引用做 toJSON，两实例若有过期缓存/闭包
// 状态差异会测不出来）；且 register 返回的 scope 必须可核验。
const schema = createSettingsSchema([]);
let scope = null;
let registerError = null;
try {
  scope = provider.register(SETTINGS_NS, schema, {});
} catch (error) {
  registerError = error;
}
// 宿主 register 实际返回 { get, watch, update, replace }
// 四个方法的对象（读宿主 dsh-settings 包的 register 实现实锤），**没有 ns
// 字段**——此前 `scope.ns === undefined || scope.ns === SETTINGS_NS` 的
// `ns === undefined` 分支恒真，命名空间归属疑似校验实际是空转。校准为：
// ① 判据 = 对象 + 四个方法齐全（= 注册生效、scope 可用）；
// ② 命名空间归属宿主未在 scope 暴露，唯一真源是下面的 ② describe 命中，
//    不再在 ① 假装能验 ns。
// 注释不再写宿主内部包路径（dsh-settings/lib/index.js
// 属于宿主实现细节，随宿主版本会漂移），只保留结论。
const scopeShapeOk = scope !== null && typeof scope === 'object'
  && ['get', 'watch', 'update', 'replace'].every((k) => typeof scope[k] === 'function');
// 失败路径只报方法名清单，不 JSON.stringify scope（评审复查：含闭包/宿主
// 引用的对象可能循环引用，异常时把简单报错变成二次崩溃）。
const scopeKeys = scope && typeof scope === 'object' ? Object.keys(scope).join(',') : String(scope);
// 原 `registerError ? … : scopeShapeOk ? … : …` 是嵌套三元，
// 违反项目规约（src/task-api.js 明示「if/else 取代嵌套三元」）——改 if/else 链。
let registerOutcome;
if (registerError) {
  registerOutcome = `抛错 ✘ — ${String(registerError?.message ?? registerError)}`;
} else if (scopeShapeOk) {
  registerOutcome = 'OK ✔';
} else {
  registerOutcome = `返回异常 ✘ — 方法缺失（keys=${scopeKeys}）`;
}
console.log(`① register(${SETTINGS_NS}) : ${registerOutcome}`);
if (registerError || !scopeShapeOk) process.exit(1);

/* ── ② describe：设置页分区的数据源 ── */
const described = provider.describe({ redactSecrets: true });
const ns = described.find((d) => d.ns === SETTINGS_NS);
console.log(`② describe 命名空间数 : ${described.length}；含 "${SETTINGS_NS}" ? ${ns ? '是 ✔' : '否 ✘'}`);
if (ns) console.log(`   describe.ns=${ns.ns} revision=${ns.revision} value=${JSON.stringify(ns.value)} applies=${ns.applies}`);

/* ── ③ schema.toJSON()：客户端渲染表单的 wire 形态（复用 ① 的同一实例） ── */
let toJson = null;
let toJsonError = null;
try {
  toJson = schema.toJSON();
} catch (error) {
  toJsonError = error;
}
console.log(`③ schema.toJSON() : ${toJsonError ? `抛错 ✘ — ${String(toJsonError?.message ?? toJsonError)}` : 'OK ✔'}`);
if (toJson) console.log(`   type=${toJson.type} 顶层键=${Object.keys(toJson.properties ?? {}).join(',')}`);

const failed = registerError || !ns || toJsonError;
console.log(failed ? '\n✘ 链路断裂：设置分区不会出现' : '\n✔ 全部通过：register/describe/toJSON 链路健康，生产无分区问题不在本链路');
process.exit(failed ? 1 : 0);
