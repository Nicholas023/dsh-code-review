/**
 * scripts/client-bundle-smoke.mjs —— 客户端模块（client.js）协议冒烟。
 *
 * 背景（client.js 若没按宿主协议调用
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
  // TasksCard 的轮询 useEffect 依赖
  // setInterval/clearInterval——vm 沙箱默认没有这些全局，缺了直接
  // ReferenceError。
  // client.js 实际使用的超时全局是
  // { setInterval, clearInterval, setTimeout, clearTimeout } 四件套——轮询
  // (setInterval) + 8s 轮询逃生定时器 (setTimeout)
  // 在 fetch 超时路径**无条件**建立，即使宿主无 AbortController 也走定时器
  // 兜底放行 inflight)。旧注释「setTimeout 从未被触达」已被该次修复推翻——
  // 真实契约就是四个，沙箱按契约注入。
  // 注入永真 stub：返回假 id、绝不回调，冒烟期轮询/逃生定时器不真跑（真跑会
  // 挂住进程/开异步缺口）；回调逻辑由「渲染不抛 + effectErrors 为空」覆盖。
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
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
/** useEffect 副作用抛出的异常收集：原实现 catch 后
 *  静默吞掉——副作用错误（订阅/轮询回调炸）会让「渲染不抛」假绿；改为收进
 *  effectErrors，汇总前统一断言。 */
const effectErrors = [];
/** useState 可写槽位：原 setter 是空函数 `() => {}`，
 *  组件内 setXxx(...) 全部静默消失，「编辑字段 → dirty → 保存」路径无法被任何
 *  测试表达。现为每个槽位建 box，setter 真实更新（兼容函数式更新 prev => ...）；
 *  槽位登记进 useStateBoxes 供断言「setter 真的改变了值」。
 *  局限注明：本 stub 不做重渲染（组件闭包读到的是首次渲染的引用），跨渲染
 *  状态保持仍需宿主环境；此处只保证「调用 setter 有真实可观察的更新」，
 *  消除「调用被吞」这层假象。 */
const useStateBoxes = [];
const fakeReact = {
  useState(init) {
    const box = { value: typeof init === 'function' ? init() : init, set: null };
    box.set = (next) => { box.value = typeof next === 'function' ? next(box.value) : next; };
    useStateBoxes.push(box);
    return [box.value, box.set];
  },
  useEffect(create) {
    let cleanup = null;
    try { cleanup = create(); } catch (err) { effectErrors.push(err); }
    if (typeof cleanup === 'function') try { cleanup(); } catch (err) { effectErrors.push(err); }
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
/** 假 configForms 表单：getSnapshot 返回「Host 就绪可写」快照；set/unset 返回 true。
 *  - 删除无消费方的 writes 痕迹数组（没有任何断言
 *  读它，留着只是自我安慰）；- get/subscribe 改为计数——get 供「configForms 命中
 *  插件条目」真断言（原断言硬编码 true），subscribe 供「设置卡真的订阅了表单」真
 *  断言（SettingsCard 的 useEffect 每渲染订阅一次）。 */
const fakeForm = {
  snapshot: { status: 'ready', mode: 'host', writable: true, revision: 0, value: {} },
  gets: 0,      // configForms.get 命中计数
  lastId: null, // 最近一次 get 收到的插件条目 id（
  subscribes: 0, // form.subscribe 消费计数
  getSnapshot() { return this.snapshot; },
  subscribe() {
    // listener 参数此前存进 this.listener 却从无
    // 消费方读取（写而不读）——subscribe 契约只是「订阅并返回退订函数」。
    // 现在只计数（供「设置卡真的订阅了表单」断言），listener 直接忽略。
    this.subscribes += 1;
    return () => {};
  },
  async set() { return true; },
  async unset() { return true; },
  dispose() { return Promise.resolve(); },
};
const fakeCtx = {
  effect(cb, label) { cb(); return () => {}; },
  slots: {
    inject(slot, getter) { if (slot === 'plugins.item') getter(); return () => {}; },
    register(meta, render) { cards.push({ meta, render }); return () => {}; },
  },
  configForms: { get(id) { fakeForm.gets += 1; fakeForm.lastId = id; return fakeForm; } },
};
let applyError = null;
try {
  loaded.apply(fakeCtx);
} catch (error) {
  applyError = error;
}
check('apply 执行不抛（slots + configForms 注册成功）', !applyError,
  applyError ? String(applyError?.message ?? applyError) : 'OK');
// 原断言硬编码 true（无论 get 是否命中都通过），
// 改为计数断言——configForms.get 未被调用 = 卡片拿不到表单 = 设置页白屏。
// 计数之外再断言 get 收到的条目 id 就是插件条目
// id（计数通过但传错 id 同样拿不到表单，属「写而读」的完整闭环）。
check('configForms.get 收到了插件条目 id', fakeForm.gets >= 1 && fakeForm.lastId === 'dsh-code-review',
  `get 命中 ${fakeForm.gets} 次，lastId=${fakeForm.lastId ?? '(无)'}`);
/** 设置卡（id=插件条目）与任务卡（id=.tasks）分列断言；slots.register 多次调用互相独立。 */
const settingsCard = cards.find((c) => c.meta.id === 'dsh-code-review');
const tasksCard = cards.find((c) => c.meta.id === 'dsh-code-review.tasks');
check('注册了 plugins.item 设置卡', Boolean(settingsCard),
  settingsCard ? `id=${settingsCard.meta.id} label=${typeof settingsCard.meta.label === 'function' ? settingsCard.meta.label() : settingsCard.meta.label}` : '(未注册)');
check('注册了 .tasks 任务卡（第二层 GUI 实时刷新）', Boolean(tasksCard),
  tasksCard ? `id=${tasksCard.meta.id} order=${tasksCard.meta.order}` : '(未注册)');

/* ── ④ 两种视图渲染不抛（form 随 props 注入） ── */
/** 循环引用/不可序列化对象会让 JSON.stringify 抛异常
 *  炸掉整个冒烟且带不出上下文——统一走 safeText：失败给显式标记（断言必失败并
 *  带标记），而不是进程崩溃。 */
const safeText = (v) => {
  try { return JSON.stringify(v) ?? ''; } catch { return '<不可序列化：疑似循环引用>'; }
};
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
check('全卡含保存操作（保存按钮文案在产物中）', safeText(renderFull).includes('保存'),
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
check('任务卡产物含「后台任务」标题', Boolean(tasksRender) && safeText(tasksRender).includes('后台任务'),
  'OK');
// components 计数此前只写不读——渲染痕迹必须真被
// 断言消费（组件函数一次都没被调用 = 卡片渲染是空壳，「渲染不抛」全假绿）。
const renderedNames = Object.keys(components);
check('组件函数真实被调用（渲染痕迹非空）', renderedNames.length > 0,
  renderedNames.join(',') || '(没有任何组件被调用)');
// SettingsCard 的 useEffect 每渲染一次就订阅一次
// 表单（client.js 的 form.subscribe(take)，这里不写死行号——组件增删字段会让
// 行号漂移）——fake useEffect 立即执行 create()，两种视图各订阅一次；断言真实
// 消费路径，subscribe 永远不触发 = 实时刷新静默失效。
check('设置卡渲染订阅了表单（subscribe 真实消费）', fakeForm.subscribes >= 2,
  `subscribe 调用 ${fakeForm.subscribes} 次`);

/* ── ④b 并发字段条件展开（开关开启 → 展开「并发广度」 ──
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
const offText = safeText(renderFull);
const onText = safeText(renderOn ?? '');
// 断言用渲染结构标识（concurrency-input = 并发广度数字输入的 DOM key），
// 不用字段文案——卡片底部 note 也含「并发广度」字样，文案断言会误伤。
check('并发开关开启：并发广度数字输入已渲染', !renderOnError && onText.includes('concurrency-input'),
  renderOnError ? String(renderOnError?.message ?? renderOnError) : (onText.includes('concurrency-input') ? '产物含 concurrency-input' : '产物未含 concurrency-input'));
check('并发开关关闭（默认单线）：并发广度数字输入不渲染', !offText.includes('concurrency-input'),
  offText.includes('concurrency-input') ? '默认关时不该渲染并发广度输入' : '开关关时广度输入不渲染 ✓');

/* ── ⑤ 界面字段 ≡ schema 键 双向一致性 ── */
/**
 * 字段真源改为 client.js 导出的 __fields__
 * （factory 返回对象上的附加键，宿主只消费 inject/apply 不受影响）——
 * 源码正则抽取对字段改名/结构调整零防护（正则依然匹配旧字面量），
 * 导出缺失时本断言直接失败并回落正则（带告警），保证「client 字段 ≡
 * Config 键」的比对对象是运行时真值而非源码文本巧合。
 */
const exportedFields = Array.isArray(loaded?.__fields__)
  ? loaded.__fields__.map((f) => (f && typeof f.key === 'string' ? f.key : null)).filter(Boolean)
  : [];
check('client.js 导出 __fields__（字段真源，非正则抽取）', exportedFields.length > 0,
  exportedFields.length > 0 ? `导出 ${exportedFields.length} 个字段` : '未导出 __fields__（已回落正则兜底）');
// 兜底：仅当导出缺失时用正则（此时上一条已判失败，这里保证比对仍能出对比细节）。
const fieldKeys = exportedFields.length > 0
  ? exportedFields
  : [...clientSrc.matchAll(/\{\s*key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
// 降级显式化：__fields__ 缺失时后续「字段一致性」断言实际是拿正则抽取值比对，
// 结果不可靠——单独记一条失败，避免「关键断言失败但下游断言仍通过」的混乱结果。
if (exportedFields.length === 0) {
  check('字段一致性断言已降级（__fields__ 缺失，回落正则——结论不可靠）', false,
    '正则抽取键=' + fieldKeys.join(','));
}
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

/* ── ④c hooks 副作用与槽位健康 ── */
check('useEffect 副作用无异常（订阅/轮询回调不抛）', effectErrors.length === 0,
  effectErrors.length ? effectErrors.map((e) => String((e && e.message) || e)).join(' | ') : 'OK');
// 可写槽位：挑第一个数值/任意槽位验证 setter 真实更新（函数式更新语法也要成立）。
const slot = useStateBoxes[0];
if (slot) {
  const before = slot.value;
  slot.set((prev) => (typeof prev === 'number' ? prev + 1 : 'touched'));
  const changed = slot.value !== before;
  check('useState 槽位可写（setter 真实更新，非空函数）', changed,
    changed ? `槽值 ${safeText(before)} → ${safeText(slot.value)}` : 'setter 未改变槽值');
} else {
  check('useState 槽位可写（setter 真实更新，非空函数）', false, '渲染未产生任何 useState 槽位');
}

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
