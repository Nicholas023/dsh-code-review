// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

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
 * 零敏感（自举评审发现）：依赖根默认取「用户主目录下的
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
// rmdirSync 用于 Windows junction 重建（unlinkSync 对
// DIRECTORY 属性抛 EPERM），但此前未在 import 里导入——ESM 无全局 rmdirSync，
// Windows 上会抛 ReferenceError 并被外层 catch 吞成「连接失败」误报（重建
// 逻辑在目标平台从未生效）。补导入。
import { existsSync, symlinkSync, mkdirSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, isAbsolute, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
/** 平台判定单点（本项目规约：不散落内联 process.platform 比较）。 */
const IS_WIN = process.platform === 'win32';

/**
 * 删除 junction/符号链接本身（不跟随目标）。
 * - Windows：junction 是带 DIRECTORY 属性的目录 reparse point，unlinkSync 会
 *   返回 EPERM，必须用 rmdirSync（只删链接、不删目标内容）。
 * - POSIX：目录链接用 unlinkSync。
 * 平台分流收敛到这一处，两个调用点（清理残留、重建前清理）共用，
 * 避免同一分支拷贝两份而漂移。
 * @param {string} p 待删链接路径。
 */
function removeJunction(p) {
  // 只删链接：函数自身先确认目标确为符号链接/junction。调用点虽已由
  // destUsable 把关，但此处不能依赖调用者——rmdirSync 对真实目录会连内容
  // 一起删，独立调用时风险太大。
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  if (IS_WIN) rmdirSync(p);
  else unlinkSync(p);
}

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
  if (env) {
    // 环境变量/用户配置里的依赖根必须是绝对路径——
    // 相对路径被 join 到 cwd 静默错位（cwd 取决于谁来执行脚本），
    // junction 会连到错误目录且后期极难排查，直接报错退出。
    if (!isAbsolute(env)) {
      console.error('✘ DSH_NODE_MODULES 必须是绝对路径（当前：' + env + '）。');
      process.exit(1);
    }
    return env;
  }
  const userCfg = readUserConfig();
  // readUserConfig 返回整个配置对象——这里先解包
  // dependenciesRoot 字段再校验；（既往缺陷：直接 isAbsolute(userCfg) 对对象
  // 抛 TypeError、且把对象当路径 join 到荒谬根（该问题已修，此处注释留档）
  // 描述现状，不再保留「必须先解包」的告诫口吻。）
  const userRoot = userCfg ? userCfg.dependenciesRoot : null;
  if (userRoot) {
    if (!isAbsolute(userRoot)) {
      console.error(`✘ ~/.dsh/dsh-code-review-dev.json 的 dependenciesRoot 必须是绝对路径（当前：${userRoot}）。`);
      process.exit(1);
    }
    return userRoot;
  }
  const profilesRoot = join(homedir(), '.dsh', 'profiles');
  const profile = process.env.DSH_PROFILE;
  if (profile) {
    const direct = join(profilesRoot, profile);
    if (existsSync(direct)) return direct;
    // profilesRoot 可能整体不存在（未跑过宿主/被清理），
    // readdirSync 会抛 ENOENT 未捕获崩溃——先 existsSync 守卫，缺失时直接
    // 回落默认根并提示，而不是异常退出。
    if (existsSync(profilesRoot)) {
      const hit = (readdirSync(profilesRoot, { withFileTypes: true }) ?? [])
        .filter((d) => d.isDirectory() && (d.name === profile || d.name.startsWith(profile + '-')))
        .map((d) => d.name)
        .sort()[0];
      if (hit) return join(profilesRoot, hit);
    }
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
  // profileRoot 恰为默认根时两个候选是同一路径，去重
  // 防重复尝试（保序去重，避免 Set 打乱「按顺序取第一个」的语义）。
  return [...new Set(cands)].filter((p) => pathExists(p));
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

/**
 * 目标是否「可直接跳过」：
 *  - 不存在 → 需要新建；
 *  - 已是链接且 realpath 指向当前候选源 → 就绪，跳过；
 *  - 链接 realpath 失败（dangling junction：源目录被移动/删除）或指向别的源
 *    （换过依赖根）→ 需要重建；
 *  - 非链接（真目录/文件，如 npm i 装的）→ 视为就绪，跳过。
 * 旧实现只查「存在即跳过」，dangling junction 会永远
 * 留在 node_modules 里（pathExists 对死链返回 true），源恢复后脚本仍报
 * 「已存在」——补 realpath 比对 + 失败即重建。
 */
function destUsable(dest, src) {
  let st;
  try { st = lstatSync(dest); } catch (e) {
    // ENOENT = 路径确实不存在（需重建）；其余错误（EACCES/EPERM…）是环境故障，
    // 吞成 false 会把「没权限」伪装成「源缺失」并触发无意义重建。抛出真因。
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
  if (!st.isSymbolicLink()) return true;
  try {
    // `destUsable(dest, null)`（无候选源分支）此前会
    // realpathSync(null) 抛错被 catch 成 false → 一个能正常解析的旧链接被误判
    // 「源缺失」并强制重建（重建还因 #1 的 ReferenceError 失败 → exit 1）。
    // src 为 null（无候选源可比对）时，链接能解析 = 可用足够。
    if (src === null) {
      realpathSync(dest);
      return true;
    }
    // Windows 上 realpathSync 返回的大小写/分隔符可能与 src 的写法不同
    // （盘符大小写、正反斜杠混用），严格相等会把可用的链接误判成陈旧而反复
    // 重建。比较前统一 normalize；win32 下再统一小写（NTFS 大小写不敏感）。
    const norm = (p) => {
      const n = normalize(realpathSync(p));
      return IS_WIN ? n.toLowerCase() : n;
    };
    return norm(dest) === norm(src);
  } catch {
    return false; // dangling 或目标不可解析 → 重建
  }
}

/** 顶层入口：连接依赖（幂等）。 */
function main() {
  const profileRoot = resolveProfileRoot();
  // 本地 schema 依赖来源（[scope|null, name]；scope 为 null 表示裸包）。
  // 清单缩到真实使用集——cosmokit / @standard-schema/spec
  // 在全仓库（src/scripts/package.json）无任何 import，只为它们建 junction
  // 是死连接；schemastery（settings-schema/plugin-config）与 js-yaml
  // （model-provider）是 dsh 的依赖解析链锚点，保留。若未来源码引入新依赖，
  // 连同 package.json dependencies 一起加回来。
  const sources = [
    ['@deepseek-ai', 'schemastery'],
    [null, 'js-yaml'],
  ];
  console.log(`依赖源根：${profileRoot}\n`);

  let linked = 0;
  let skipped = 0;
  let missingSrc = 0;
  let linkFail = 0;
  const missingSrcLabels = [];
  const linkFailLabels = [];
  for (const [scope, name] of sources) {
    const label = scope ? `${scope}/${name}` : name;
    const cands = depCandidates(profileRoot, scope, name);
    const dest = scope ? join(NM, scope, name) : join(NM, name);
    // 源侧校验与目标侧同强度——depCandidates 的
    // pathExists 对 dangling 链接返回 true（lstat 只问链接本身在不在，不跟随），
    // 若 profile 侧候选包本身是个死 junction（它指向的依赖根已被删），
    // symlinkSync 照建不误：目标链接生成成功、缺源计数为 0、脚本 exit 0
    // ——「链接坏了但脚本没报」的悬浮故障。要求源 realpath 可解析才建链；
    // 不可解析按缺源计（运行时将走 npm i，与「源缺失」分支同一兜底语义）。
    // 多个候选时**逐个**解析，取第一个 realpath
    // 可解析者（此前只试 cands[0]——首候选是死链接但后续候选可用时仍误报
    // 缺失）；全部不可解析再落缺失计数。dest 侧已就绪（真实安装/正确链接）
    // 时逃生：源再乱也不报失败（正常开发流：npm i 后依赖层路径被换过）。
    // cands.length===0 曾单列分支、与下方
    // srcCand===null 块重复同一套 destUsable 判定——两个分支做同一件事，
    // 缺失文案分两处维护；合并后由 cands.length 派生文案（0 = 源缺失，
    // >0 = 候选全部不可解析）。
    let srcCand = null;
    for (const cand of cands) {
      try {
        // realpathSync 的返回值无需拿来判真——
        // 它要么返回真路径要么抛异常，永不返回 falsy；Boolean() 包装是
        // 死代码。解析成功即取用、失败进 catch 试下一个。
        realpathSync(cand);
        srcCand = cand;
        break;
      } catch {
        /* 该候选不可解析，试下一个 */
      }
    }
    if (srcCand === null) {
      if (destUsable(dest, null)) {
        console.log(`• 目标已就绪（跳过，源不在候选路径）：${label}`);
        skipped += 1;
      } else {
        // 源不可解析且目标也不可用：顺手清掉目标残留（坏链/半成品），避免
        // 「目标挂着死链接」的悬浮状态长留 node_modules；与下方重建分支的
        // 清理同一套语义（pathExists 对 dangling 返回 true，须平台分流删法）。
        try {
          if (pathExists(dest)) {
            removeJunction(dest);
          }
        } catch {
          /* 清理失败：不影响缺源结论，继续报缺失 */
        }
        const why = cands.length === 0 ? '源缺失' : '源候选全部不可解析（dangling）';
        console.log(`✘ ${why}（跳过，运行时将以 npm i 安装）：${label}`);
        missingSrc += 1;
        missingSrcLabels.push(label);
      }
      continue;
    }
    if (destUsable(dest, srcCand)) {
      console.log(`• 已存在（跳过）：${label}`);
      skipped += 1;
      continue;
    }
    try {
      // 走到这里 = 目标不存在或需重建（dangling/错链）；先清残留再新建。
      // 清理走 removeJunction（平台分流单点，见其定义处说明：Windows 必须
      // rmdirSync，unlinkSync 对目录型 reparse point 会 EPERM）。
      if (pathExists(dest)) {
        removeJunction(dest);
      }
      if (scope) mkdirSync(join(NM, scope), { recursive: true });
      symlinkSync(srcCand, dest, 'junction');
    } catch (error) {
      console.log(`✘ 连接失败（跳过）：${label} —— ${error?.message ?? error}`);
      linkFail += 1;
      linkFailLabels.push(label);
      continue;
    }
    console.log(`✔ 已连接：${label}`);
    linked += 1;
  }

  // 缺失进入汇总与退出码——原实现只在 linked===0 && skipped===0 时提示，
  // 单缺一个依赖时脚本「成功」退出，后续 smoke 又在运行时才暴露缺模块，
  // 链接层问题被延后且无归因。
  // 缺源（源不在候选路径 / 候选全 dangling）与连接失败（symlinkSync 抛错）
  // 是两类不同故障，分开计数与清单——混在同一数组里排查时看不出是「没
  // 找到源」还是「找到了但连不上」，分别打印便于快速归因。
  console.log(`\n完成：新建 ${linked} 个 junction，跳过 ${skipped} 个，缺源 ${missingSrc} 个，连接失败 ${linkFail} 个。`);
  if (missingSrc > 0) {
    console.log(`✘ 缺源清单：${missingSrcLabels.join('、')}。请检查 profile node_modules 路径（可用 DSH_NODE_MODULES 覆盖）。`);
  }
  if (linkFail > 0) {
    console.log(`✘ 连接失败清单：${linkFailLabels.join('、')}（目标残留已清理，下次运行会重试）。`);
  }
  if (missingSrc + linkFail > 0) {
    process.exit(1);
  }
}

main();
