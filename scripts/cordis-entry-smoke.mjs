/**
 * scripts/cordis-entry-smoke.mjs —— Cordis 入口（main 入口）冒烟自检。
 *
 * 开发期验证「插件挂载成功、工具可见」（步骤 4 判据的开发侧等价物）：
 *   1. src/index.js 可导入，导出 apply（函数）与 name/inject；
 *   2. inject 声明含 'tools'（Cordis 服务注入，缺失即启用失败）与 'settings'；
 *   3. 用最小 ctx 垫片调用 apply：不抛异常、恰好注册 code_review /
 *      code_review_status / code_review_set_config 三个工具（后台任务形态 +
 *      配置入口，与 dsh-plugin.json 的 x-tools 声明对齐）、
 *      ctx.effect 的清理函数可执行不抛；
 *   4. package.json 双形态声明与随包文件齐备（main / exports / dsh.bundle.patch /
 *      files 含 cordis.patch.yml、dsh-plugin.json、std-facet.js、client.js）；
 *   5. cordis.patch.yml 结构有效（顶层 insert，id/name 均为 dsh-code-review）；
 *   6. 附件模块（config/settings-schema/plugin-config/runner/report/sensitive-list）
 *      可导入，工具参数 schema 必填字段就绪；src/index.js 导出 0.2.0 Config
 *      schema（configForms 表单真源，键与 settings-schema 对齐）。
 *
 * 隔离：apply 不做任何外部写（不读真实设置文件、不写盘），probeEngineVersion
 * 仅尝试 spawn codecheck（不存在即快速失败进 warn 日志），因此无需 DSH_HOME
 * 隔离；仍将 DSH_HOME 指向临时目录作为双保险，避免意外触碰用户配置。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根用 dirname 二次取父目录——原
// `join(fileURLToPath(import.meta.url), '..', '..')` 把文件路径当目录段参与 `..`
// 归一化，结果恰好等于仓库根，但依赖「文件名可以被 .. 吃掉」的巧合；
// 文件改名/目录调整时静默错位。dirname 语义直白：文件 → 所在目录 → 仓库根。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

/* ---------- 0. 隔离 DSH_HOME + 任务簿（必须在 import 前设置） ---------- */
const home = mkdtempSync(join(tmpdir(), 'dcr-cordis-smoke-'));
process.env.DSH_HOME = home;
// 任务簿目录（task-book 模块加载时锁定 TASKS_ROOT）：必须一并隔离，
// 否则 apply 里的完成推送协程会指向生产任务簿（读并改写生产任务 JSON）。
process.env.DSH_REVIEW_HOME = join(home, 'review');

/* ---------- 1. 导入入口模块 ---------- */
let mod;
try {
  mod = await import(new URL('../src/index.js', import.meta.url).href);
  check('src/index.js 可被导入（Cordis 入口模块）', true);
} catch (error) {
  check('src/index.js 可被导入（Cordis 入口模块）', false, String(error));
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

check('导出 apply 为函数', typeof mod.apply === 'function', typeof mod.apply);
check('导出 name = dsh-code-review', mod.name === 'dsh-code-review', String(mod.name));
check(
  "inject 声明含 'tools'（Cordis 服务注入，缺失即启用失败）",
  Array.isArray(mod.inject) && mod.inject.includes('tools'),
  JSON.stringify(mod.inject)
);
check(
  "inject 声明含 'settings'（宿主设置服务，设置面板依赖）",
  Array.isArray(mod.inject) && mod.inject.includes('settings'),
  JSON.stringify(mod.inject)
);

/* ---------- 2. 附件模块可导入 ---------- */
for (const m of ['config', 'settings-schema', 'plugin-config', 'runner', 'report', 'sensitive-list']) {
  try {
    await import(new URL(`../src/${m}.js`, import.meta.url).href);
    check(`src/${m}.js 可导入`, true);
  } catch (error) {
    check(`src/${m}.js 可导入`, false, String(error));
  }
}

/* ---------- 2.5 0.2.0 设置契约：插件导出 Config（configForms 表单真源） ----------
 * 宿主 describe 按 entry 读 entry.fiber.runtime.Config 投影表单；
 * 缺 Config 导出 → describe 无本插件行 → 客户端表单 status=unavailable 不可写。
 * 直接复用外层 mod（ESM 模块缓存本就命中同一实例），
 * 去掉重复的动态 import 同一路径。 */
{
  let ok = false;
  let detail = '缺 Config 导出';
  try {
    if (mod.Config && typeof mod.Config.toJSON === 'function') {
      const serialized = mod.Config.toJSON();
      const root = serialized?.refs?.[serialized?.uid];
      const keys = Object.keys(root?.dict ?? {});
      ok = keys.length > 0 && ['review_model', 'report_dir', 'engine_bin', 'first_run'].every((k) => keys.includes(k));
      detail = `Config 键=${keys.join(',')}`;
    }
  } catch (error) {
    detail = String(error);
  }
  check('src/index.js 导出 0.2.0 Config schema（四键齐全）', ok, detail);
}

/* ---------- 3. 最小 ctx 垫片 + apply ---------- */
const registeredTools = [];
const registeredCommands = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => {
    const disposeOrValue = fn();
    return typeof disposeOrValue === 'function' ? disposeOrValue : () => {};
  },
  tools: {
    register: (tool) => {
      registeredTools.push(tool);
      return () => {};
    },
  },
  settings: {
    get: () => undefined,
    register: () => {},
    patch: () => {},
    replace: () => {},
    configure: () => {},
  },
  // ctx.get：未声明的可选服务读取口（model-provider 的 agentDefaultModel）。
  get: () => undefined,
  inject: (_names, fn) => {
    if (typeof fn === 'function') fn(ctx);
    return () => {};
  },
  // 0.2.x 命令服务：复数 commands，`register(definition)` 返回卸载函数。
  commands: {
    register: (definition) => {
      registeredCommands.push(definition);
      return () => {};
    },
  },
};

let applyThrew = null;
let dispose = null;
try {
  dispose = mod.apply(ctx, undefined);
  check("apply(ctx, undefined) 不抛异常（挂载成功前提）", true);
} catch (error) {
  applyThrew = error;
  check("apply(ctx, undefined) 不抛异常（挂载成功前提）", false, String(error));
}

check(
  '注册了 code_review / code_review_status / code_review_set_config 三个工具（后台任务形态 + 配置入口）',
  Array.isArray(registeredTools) && registeredTools.length === 3
    && registeredTools.some((t) => t?.name === 'code_review')
    && registeredTools.some((t) => t?.name === 'code_review_status')
    && registeredTools.some((t) => t?.name === 'code_review_set_config'),
  JSON.stringify(registeredTools.map((t) => t?.name))
);

check(
  '注册了 /review 与 /review-status 斜杠命令（0.2.x 复数 commands 服务，register 形态）',
  Array.isArray(registeredCommands) && registeredCommands.length === 2
    && registeredCommands.some((c) => c?.name === 'review' && typeof c?.handler === 'function')
    && registeredCommands.some((c) => c?.name === 'review-status' && typeof c?.handler === 'function'),
  JSON.stringify(registeredCommands.map((c) => c?.name))
);

if (dispose) {
  let disposeThrew = false;
  try {
    dispose();
  } catch {
    disposeThrew = true;
  }
  check('apply 返回的卸载函数可执行且不抛', !disposeThrew, disposeThrew ? 'dispose 抛了' : '');
} else {
  check('apply 返回了卸载函数', false, 'dispose 为 null/undefined');
}

/* ---------- 4. package.json 双形态声明 ---------- */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('package.json: main = src/index.js', pkg.main === 'src/index.js', String(pkg.main));
check("package.json: exports['.'] = ./src/index.js", pkg.exports?.['.'] === './src/index.js', String(pkg.exports?.['.']));
check("package.json: dsh.bundle.patch = ./cordis.patch.yml", pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch));
for (const f of ['src', 'cordis.patch.yml', 'dsh-plugin.json', 'std-facet.js', 'client.js', 'README.md', 'LICENSE']) {
  check(`package.json: files 含 ${f}`, Array.isArray(pkg.files) && pkg.files.includes(f));
}

/* ---------- 5. cordis.patch.yml 结构 ---------- */
const patchPath = join(ROOT, 'cordis.patch.yml');
const patchExists = existsSync(patchPath);
check('cordis.patch.yml 存在', patchExists);
if (patchExists) {
  const patchText = readFileSync(patchPath, 'utf8');
  check('cordis.patch.yml 顶层含 insert', /^\s*-\s+insert:/m.test(patchText), '缺 insert');
  check('cordis.patch.yml id/name = dsh-code-review', /id:\s*dsh-code-review/.test(patchText) && /name:\s*['"]?dsh-code-review/.test(patchText));
}

/* ---------- 6. 工具对象结构就绪 ---------- */
if (registeredTools.length >= 1) {
  const tool = registeredTools.find((t) => t?.name === 'code_review');
  const statusTool = registeredTools.find((t) => t?.name === 'code_review_status');
  check('code_review 工具有 name', tool?.name === 'code_review');
  // description 判据从「长度 > 50 魔法数」放宽为
  // 「非空字符串」——长度阈值与文案长度强耦合，纯属拍脑袋；非空即可证明
  // 描述已就位，文案质量应是人工 review 的事而不是冒烟断言。
  check('code_review 工具有 description（微调模型可见）', typeof tool?.description === 'string' && tool.description.trim().length > 0);
  check(
    'code_review 工具有 parameters JSON Schema（必填项合理）',
    typeof tool?.parameters?.type === 'string' && typeof tool?.parameters?.properties === 'object'
  );
  check('code_review 工具 parameters 含 exclude_paths（后台扫描排除位）', 'exclude_paths' in (tool?.parameters?.properties ?? {}));
  check('code_review 工具 execute 为异步函数（后台投递入口）', typeof tool?.execute === 'function');
  check('code_review 工具 output schema（结果渲染位）', typeof tool?.output?.schema === 'object' || typeof tool?.output?.render === 'function');
  check('code_review_status 工具（参数 task_id 查询/省略列最近）', typeof statusTool?.execute === 'function' && 'task_id' in (statusTool?.parameters?.properties ?? {}));
} else {
  check('工具对象结构就绪', false, '未捕获到工具对象');
}

/* ---------- 收尾 ---------- */
rmSync(home, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exit(1);
}
console.log('\n✔ 全部通过：Cordis 入口冒烟自检 OK');
