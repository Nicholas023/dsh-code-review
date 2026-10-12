/**
 * scripts/client-bundle-smoke.mjs —— 客户端模块（client.js）协议冒烟。
 *
 * 背景（2026-10-12 生产实装踩坑）：client.js 若没按宿主协议调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册，宿主 Web 端加载时报
 * `loaded without registering "dsh-code-review" via __ModuleLoader__.load`，
 * 且整个插件激活失败（设置分区也不出现）。本脚本在 Node 里模拟宿主加载步骤：
 *   ① 用 vm 沙箱提供 window / __ModuleLoader__.load 捕获；执行 client.js；
 *   ② 断言注册 id === 包名（dsh-code-review）；
 *   ③ 用假 require 调 factory，拿到 { inject, apply }，检查 inject 含 'slots'；
 *   ④ 用假的 slots 上下文调 apply，再渲染一次卡片（summary + 全卡两种视图）
 *      断言全程不抛（React 由假 require 返回极简 stub）。
 *
 * 运行：node scripts/client-bundle-smoke.mjs（零依赖，不联网）。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ── ② factory 求值：假 require 提供 react ── */
const components = {}; // 渲染痕迹：记录调用过的组件名
const fakeReact = {
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
check('inject 声明了 slots（宿主插件页服务）', Array.isArray(loaded.inject) && loaded.inject.includes('slots'),
  (loaded.inject ?? []).join(',') || '(空)');

/* ── ③ apply：假 slots 上下文 ── */
let cardProps = null; // 捕获注册的卡片渲染函数
const fakeCtx = {
  effect(cb, label) { cb(); return () => {}; },
  slots: {
    inject(slot, getter) { if (slot === 'plugins.item') getter(); return () => {}; },
    register(meta, render) { cardProps = { meta, render }; return () => {}; },
  },
};
let applyError = null;
try {
  loaded.apply(fakeCtx);
} catch (error) {
  applyError = error;
}
check('apply 执行不抛（slots 注册成功）', !applyError, applyError ? String(applyError?.message ?? applyError) : 'OK');
check('注册了 plugins.item 卡片', cardProps?.meta?.id === 'dsh-code-review',
  cardProps ? `id=${cardProps.meta.id} label=${typeof cardProps.meta.label === 'function' ? cardProps.meta.label() : cardProps.meta.label}` : '(未注册)');

/* ── ④ 两种视图渲染不抛 ── */
let renderError = null;
try {
  cardProps.render({ view: 'summary' });
  cardProps.render({ view: 'full' });
} catch (error) {
  renderError = error;
}
check('卡片 summary/full 两种视图渲染不抛（React stub 契约）', !renderError,
  renderError ? String(renderError?.message ?? renderError) : 'OK');
check('全卡渲染产出非空', (() => {
  try {
    return Boolean(cardProps.render({ view: 'full' }));
  } catch {
    return false;
  }
})(), 'OK');

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
