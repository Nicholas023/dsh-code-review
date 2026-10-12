/**
 * scripts/link-deps.mjs —— 开发期依赖连接（junction）。
 *
 * 背景：插件依赖 @deepseek-ai/schemastery（设置 schema）。生产装载时插件根
 * 被 junction 进 profile node_modules，Node 依赖解析沿 插件根/node_modules →
 * profile/node_modules 向上命中；但**开发期**（仓库不在 profile 树下）npm i
 * 需要访问 registry（npmjs.org 可达性不稳、且骨架期不想引入网络差异）。
 * 本脚本把本机 profile node_modules 里已就绪的 schema 依赖以 junction 方式
 * 连进仓库 node_modules，使本地 `node --check` 无依赖、smoke 可离线直跑。
 *
 * 零敏感（自举评审发现，2026-10-12 修复）：依赖根默认取「用户主目录下的
 * DSH 依赖层」（home/.dsh/profiles/desktop），运行时由 homedir() 推导，
 * 不硬编码本机绝对路径；用户可改——优先级从高到低：
 *   1. 环境变量 DSH_NODE_MODULES（完整绝对路径，临时/CI 用）；
 *   2. 用户级配置文件 ~/.dsh/dsh-code-review-dev.json 的 dependenciesRoot
 *      字段（默认文件夹的持久改法）；
 *   3. 环境变量 DSH_PROFILE（改默认 profile 名，自动匹配 profiles 根）。
 *
 * 用法：node scripts/link-deps.mjs（幂等：目标已存在即跳过）。
 * 说明：junction 是目录链接（非提权 symlink），Windows 可用；node_modules/
 * 与 junction 内容提交时 gitignore。正式发布不依赖本脚本（npm i 装依赖）。
 */
import { existsSync, symlinkSync, mkdirSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');

/**
 * 用户级配置（~/.dsh/dsh-code-review-dev.json）——「默认文件夹」的持久改法。
 * 支持字段：dependenciesRoot（依赖层根目录绝对路径）。
 */
function readUserConfig() {
  try {
    const p = join(homedir(), '.dsh', 'dsh-code-review-dev.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return typeof raw.dependenciesRoot === 'string' && raw.dependenciesRoot ? raw : null;
  } catch {
    return null; // 配置损坏视同未配置，走默认
  }
}

/**
 * 推得本机 DSH profile 依赖层根目录（只读引用，绝不修改）。
 * 默认 = 全局依赖层根 `~/.dsh/profiles`（其 node_modules 是宿主/插件的
 * 根级依赖层：schemastery 等与 js-yaml 均在此），**不硬编码机器路径**。
 * 用户可改（优先级从高到低）：
 *   1. 环境变量 DSH_NODE_MODULES —— 完整依赖层绝对路径（其下要求直接有 node_modules/）；
 *   2. 用户配置文件 dependenciesRoot（~/.dsh/dsh-code-review-dev.json）；
 *   3. 环境变量 DSH_PROFILE —— profile 名，指向 ~/.dsh/profiles/<名> 的依赖层
 *      （自动匹配带平台后缀的目录，如 desktop → desktop）。
 */
function resolveProfileRoot() {
  const env = process.env.DSH_NODE_MODULES;
  if (env) return env;
  const userCfg = readUserConfig();
  if (userCfg) return userCfg.dependenciesRoot;
  const profilesRoot = join(homedir(), '.dsh', 'profiles');
  const profile = process.env.DSH_PROFILE;
  if (profile) {
    const direct = join(profilesRoot, profile);
    if (existsSync(direct)) return direct;
    const hit = (readdirSync(profilesRoot, { withFileTypes: true }) ?? [])
      .filter((d) => d.isDirectory() && (d.name === profile || d.name.startsWith(profile + '-')))
      .map((d) => d.name)
      .sort()[0];
    if (hit) return join(profilesRoot, hit);
    console.log(`⚠ 未找到 profile「${profile}」，fallback 到默认根。`);
  }
  return profilesRoot;
}

/**
 * 依赖源候选列表（按顺序取第一个存在的）。
 * ① 当前选定的依赖层根（默认 ~/.dsh/profiles、或用户配置/环境覆盖）；
 * ② 根级依赖层 ~/.dsh/profiles（部分包只装在根级，如 js-yaml；
 *    其名取自宿主依赖解析链的稳定锚点，由 homedir() 推导、不硬编码）。
 */
function depCandidates(profileRoot, scope, name) {
  const rel = join('node_modules', scope ?? '', name);
  const cands = [join(profileRoot, rel), join(homedir(), '.dsh', 'profiles', rel)];
  return cands.filter((p) => pathExists(p));
}

/** 判断路径是否真实存在：lstat 不跟随链接，能识别 dangling junction 为「存在」。 */
function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return existsSync(p);
  }
}

/** 顶层入口：连接依赖（幂等）。 */
function main() {
  const profileRoot = resolveProfileRoot();
  // 本地 schema 依赖来源（[scope|null, name]；scope 为 null 表示裸包）。
  const sources = [
    ['@deepseek-ai', 'schemastery'],
    ['@deepseek-ai', 'cosmokit'],
    ['@standard-schema', 'spec'],
    [null, 'js-yaml'],
  ];
  console.log(`依赖源根：${profileRoot}\n`);

  let linked = 0;
  let skipped = 0;
  for (const [scope, name] of sources) {
    const label = scope ? `${scope}/${name}` : name;
    const cands = depCandidates(profileRoot, scope, name);
    const dest = scope ? join(NM, scope, name) : join(NM, name);
    // 源包必须存在才算数（缺一个就明确报出来，不静默）。
    if (cands.length === 0) {
      console.log(`✘ 源缺失（跳过，运行时将以 npm i 安装）：${label}`);
      continue;
    }
    if (pathExists(dest)) {
      console.log(`• 已存在（跳过）：${label}`);
      skipped += 1;
      continue;
    }
    try {
      if (scope) mkdirSync(join(NM, scope), { recursive: true });
      symlinkSync(cands[0], dest, 'junction');
    } catch (error) {
      console.log(`✘ 连接失败（跳过）：${label} —— ${error?.message ?? error}`);
      continue;
    }
    console.log(`✔ 已连接：${label}`);
    linked += 1;
  }

  console.log(`\n完成：新建 ${linked} 个 junction，跳过 ${skipped} 个。`);
  if (linked === 0 && skipped === 0) {
    console.log('⚠ 没有任何依赖被连接——请检查 profile node_modules 路径是否变化（可用 DSH_NODE_MODULES 覆盖）。');
    process.exit(1);
  }
}

main();
