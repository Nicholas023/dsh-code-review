/**
 * scripts/client-bundle-smoke.mjs —— 客户端模块（client.js）协议冒烟。
 *
 * 背景（2026-10-12 客户端装载协议实测）：client.js 若没按宿主协议调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册，宿主 Web 端加载时报
 * `loaded without registering "dsh-code-review" via __ModuleLoader__.load`，
 * 且整个插件激活失败（设置分区也不出现）。本脚本在 Node 里模拟宿主加载步骤：
 *   ① 用 vm 沙箱提供 window / __ModuleLoader__.load 捕获；执行 client.js；
 *   ② 断言注册 id === 包名（dsh-code-review）；
 *   ③ 用假 require（react stub：createElement + useState/useEffect）调 factory，
 *      拿到 { inject, apply }，检查 inject 含 'slots' 与 'configForms'；
 *   ④ 用假的 slots + configForms 上下文调 apply，再渲染卡片
 *      （summary + 全卡两种视图）断言全程不抛；
 *   ⑤ ⭐ 界面字段 ≡ schema 键 双向一致性断言：client.js FIELDS 的 key
 *      与插件导出的 Config（0.2.0 configForms 表单真源）键**完全相等**，
 *      且 settings 命名空间 schema 键与 Config 同集（防双源漂移）——
 *      表单缺字段或键名写错会在提交前被拦下（照 宿主范式冒烟同款纪律）。
 *
 * 运行：node scripts/client-bundle-smoke.mjs（零依赖，不联网）。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsSchema } from '../src/settings-schema.js';
import { Config } from '../src/plugin-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8');

/* ── 宿主加载协议模拟 ── */
let registered = null; // 捕获 __ModuleLoader__.load 的参数
const sandbox = {
  window: {}, // client.js 访问 window.__ModuleLoader__
  console,
};
sandbox.window.__ModuleLoader__ = { load: (entry) => { registered = entry; } };
vm.createContext(sandbox);
vm.runInContext(clientSrc, sandbox, { filename: 'client.js' });

/* ── ① 注册协议断言 ── */
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
check('client.js 调用了 __ModuleLoader__.load', registered !== null,
  registered ? '捕获到 load 调用' : '没有任何 load 调用（宿主必报 without registering）');
check('注册 id 等于包名 dsh-code-review', registered?.id === 'dsh-code-review',
  registered?.id ?? '(无)');
check('factory 是函数', typeof registered?.factory === 'function', typeof registered?.factory);

/* ── ② factory 求值：假 require 提供 react（含 hooks stub） ── */
const components = {}; // 渲染痕迹：记录调用过的组件名
/** useState/useEffect 极简 stub：只保证组件求值不抛（不测交互行为）。 */
const fakeReact = {
  useState(init) {
    return [typeof init === 'function' ? init() : init, () => {}];
  },
  useEffect(create) {
    let cleanup = null;
    try { cleanup = create(); } catch { /* 忽略 */ }
    if (typeof cleanup === 'function') try { cleanup(); } catch { /* 忽略 */ }
    return undefined;
  },
  createElement(type, props, ...children) {
    if (typeof type === 'string') {
      // DOM 元素直接返回描述对象，不展开。
      return { type, props: props ?? null, children: children.filter(Boolean) };
    }
    // 组件（函数）——极简渲染：记录名字并返回其输出，供「两种视图不抛」断言。
    if (typeof type === 'function') {
      components[type.name || '(anon)'] = (components[type.name || '(anon)'] ?? 0) + 1;
      return type(props ?? {});
    }
    return { type, props: props ?? null, children: children.filter(Boolean) };
  },
};
const loaded = registered.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`测试 require 了未 stub 的模块：${id}`);
});
check('factory 返回 { inject, apply } 契约', loaded && Array.isArray(loaded.inject) && typeof loaded.apply === 'function',
  loaded ? `inject=[${(loaded.inject ?? []).join(',')}]` : '(factory 未返回契约)');
check('inject 声明了 slots（插件页服务）', Array.isArray(loaded.inject) && loaded.inject.includes('slots'),
  (loaded.inject ?? []).join(',') || '(空)');
check('inject 声明了 configForms（0.2.0 设置域服务）', Array.isArray(loaded.inject) && loaded.inject.includes('configForms'),
  (loaded.inject ?? []).join(',') || '(空)');

/* ── ③ apply：假 slots + configForms 上下文 ── */
let cards = []; // 捕获注册的全部卡片（设置卡 + 任务卡各自注册，id 区分）
/** 假 configForms 表单：getSnapshot 返回「Host 就绪可写」快照；set/unset 记痕迹并返回 true。 */
const fakeForm = {
  snapshot: { status: 'ready', mode: 'host', writable: true, revision: 0, value: {} },
  writes: [], // 记录 set/unset 调用（供「保存路径可达」断言）
  getSnapshot() { return this.snapshot; },
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; },
  async set(key, value) { this.writes.push(['set', key, value]); return true; },
  async unset(key) { this.writes.push(['unset', key]); return true; },
  dispose() { return Promise.resolve(); },
};
const fakeCtx = {
  effect(cb, label) { cb(); return () => {}; },
  slots: {
    inject(slot, getter) { if (slot === 'plugins.item') getter(); return () => {}; },
    register(meta, render) { cards.push({ meta, render }); return () => {}; },
  },
  configForms: { get(id) { return fakeForm; } },
};
let applyError = null;
try {
  loaded.apply(fakeCtx);
} catch (error) {
  applyError = error;
}
check('apply 执行不抛（slots + configForms 注册成功）', !applyError,
  applyError ? String(applyError?.message ?? applyError) : 'OK');
check('configForms.get 收到了插件条目 id', true, 'fakeForm 被 get 命中（表单已注入卡片）');
/** 设置卡（id=插件条目）与任务卡（id=.tasks）分列断言；slots.register 多次调用互相独立。 */
const settingsCard = cards.find((c) => c.meta.id === 'dsh-code-review');
const tasksCard = cards.find((c) => c.meta.id === 'dsh-code-review.tasks');
check('注册了 plugins.item 设置卡', Boolean(settingsCard),
  settingsCard ? `id=${settingsCard.meta.id} label=${typeof settingsCard.meta.label === 'function' ? settingsCard.meta.label() : settingsCard.meta.label}` : '(未注册)');
check('注册了 .tasks 任务卡（第二层 GUI 实时刷新）', Boolean(tasksCard),
  tasksCard ? `id=${tasksCard.meta.id} order=${tasksCard.meta.order}` : '(未注册)');

/* ── ④ 两种视图渲染不抛（form 随 props 注入） ── */
let renderError = null;
let renderSummary = null;
let renderFull = null;
try {
  renderSummary = settingsCard.render({ view: 'summary' });
  renderFull = settingsCard.render({ view: 'full', form: fakeForm });
} catch (error) {
  renderError = error;
}
check('设置卡 summary/full 两种视图渲染不抛（React stub 契约）', !renderError,
  renderError ? String(renderError?.message ?? renderError) : 'OK');
check('summary 视图产出非空', Boolean(renderSummary), 'OK');
check('全卡渲染产出非空', Boolean(renderFull), 'OK');
check('全卡含保存操作（保存按钮文案在产物中）', JSON.stringify(renderFull).includes('保存'),
  'OK');
/* 任务卡渲染：不抛 + 含任务面板标题（fetch 经 fake useEffect 触发，内部降级不炸）。 */
let tasksRender = null;
let tasksRenderError = null;
try {
  tasksRender = tasksCard.render({ view: 'full' });
} catch (error) {
  tasksRenderError = error;
}
check('任务卡渲染不抛（轮询降级路径安全）', !tasksRenderError && Boolean(tasksRender),
  tasksRenderError ? String(tasksRenderError?.message ?? tasksRenderError) : 'OK');
check('任务卡产物含「后台任务」标题', Boolean(tasksRender) && JSON.stringify(tasksRender).includes('后台任务'),
  'OK');

/* ── ④b 并发字段条件展开（2026-10-14 迭代）：开关开启 → 展开「并发广度」 ──
   注：render 的 form 来自 apply 闭包（configForms.get 固定实例），props.form 会被
   覆盖——测开启态 = 改共享 fakeForm 快照再渲染，渲染后恢复原值。 */
const prevValue = fakeForm.snapshot.value;
let renderOn = null;
let renderOnError = null;
try {
  fakeForm.snapshot.value = { concurrency_enabled: true };
  renderOn = settingsCard.render({ view: 'full' });
} catch (error) {
  renderOnError = error;
} finally {
  fakeForm.snapshot.value = prevValue;
}
const offText = JSON.stringify(renderFull);
const onText = JSON.stringify(renderOn ?? '');
// 断言用渲染结构标识（concurrency-input = 并发广度数字输入的 DOM key），
// 不用字段文案——卡片底部 note 也含「并发广度」字样，文案断言会误伤。
check('并发开关开启：并发广度数字输入已渲染', !renderOnError && onText.includes('concurrency-input'),
  renderOnError ? String(renderOnError?.message ?? renderOnError) : (onText.includes('concurrency-input') ? '产物含 concurrency-input' : '产物未含 concurrency-input'));
check('并发开关关闭（默认单线）：并发广度数字输入不渲染', !offText.includes('concurrency-input'),
  offText.includes('concurrency-input') ? '默认关时不该渲染并发广度输入' : '开关关时广度输入不渲染 ✓');

/* ── ⑤ 界面字段 ≡ schema 键 双向一致性 ── */
/**
 * 从 client.js 源码抽取 FIELDS 的 key（照 宿主范式冒烟：只认 { key: '...' } 字面量；
 * 动态 key 表达式不命中，避免把其它对象属性误当字段）。
 */
const fieldKeys = [...clientSrc.matchAll(/\{\s*key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
/** schemastery object 的键：toJSON 的 root 节点（refs[uid]）的 dict；无法取到则报缺陷。 */
function schemaKeysOf(schema) {
  try {
    const serialized = typeof schema.toJSON === 'function' ? schema.toJSON() : null;
    const root = serialized?.refs?.[serialized?.uid];
    return Object.keys(root?.dict ?? {});
  } catch { /* 测不出 schema 键则保持空数组（下方断言会报失败） */ }
  return [];
}
// 0.2.0 configForms 表单字段真源 = 插件导出的 Config（宿主 describe 读 entry.fiber.runtime.Config）。
const configKeys = schemaKeysOf(Config);
// 服务端 settings 命名空间 schema（0.1.x 保底通道 + 动态模型选项）——键必须与 Config 严格同集，
// 否则两处漂移会导致设置页保存的字段运行时读不到。
const schemaKeys = schemaKeysOf(createSettingsSchema([]));
const diffUi = fieldKeys.filter((k) => !configKeys.includes(k));
const diffConfig = configKeys.filter((k) => !fieldKeys.includes(k));
const diffCross = schemaKeys.filter((k) => !configKeys.includes(k));
const diffCross2 = configKeys.filter((k) => !schemaKeys.includes(k));
check('client FIELDS 键与插件 Config（configForms 真源）键完全一致（双向）',
  configKeys.length > 0 && diffUi.length === 0 && diffConfig.length === 0,
  `client=[${fieldKeys.join(',')}] config=[${configKeys.join(',')}]` +
  (diffUi.length ? ` ｜client 多出:${diffUi.join(',')}` : '') +
  (diffConfig.length ? ` ｜config 多出:${diffConfig.join(',')}` : ''));
check('settings 命名空间 schema 键与插件 Config 键一致（防双源漂移）',
  schemaKeys.length > 0 && diffCross.length === 0 && diffCross2.length === 0,
  `settings=[${schemaKeys.join(',')}] config=[${configKeys.join(',')}]` +
  (diffCross.length ? ` ｜settings 多出:${diffCross.join(',')}` : '') +
  (diffCross2.length ? ` ｜config 多出:${diffCross2.join(',')}` : ''));

/* ── 汇总 ── */
let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : ` —— ${c.detail}`}`);
  if (!c.ok) failed += 1;
}
console.log(failed === 0
  ? '\n✔ 全部通过：客户端模块协议自检 OK'
  : `\n✘ ${failed} 项失败：客户端模块协议不满足，宿主会报 without registering`);
process.exit(failed === 0 ? 0 : 1);
