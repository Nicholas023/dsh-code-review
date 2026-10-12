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
 * 用法：node scripts/link-deps.mjs（幂等：目标已存在即跳过）。
 * 说明：junction 是目录链接（非提权 symlink），Windows 可用；node_modules/
 * 与 junction 内容提交时 gitignore。正式发布不依赖本脚本（npm i 装依赖）。
 */
import { existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');

/** 本地 schema 依赖来源（生产 profile 依赖层，只读引用，绝不修改）。
 * 条目：[scope|null, name, 源绝对路径]；scope 为 null 表示无作用域裸包。 */
const SOURCES = [
  ['@deepseek-ai', 'schemastery', 'C:/Users/HP/.dsh/profiles/node_modules/@deepseek-ai/schemastery'],
  ['@deepseek-ai', 'cosmokit', 'C:/Users/HP/.dsh/profiles/node_modules/@deepseek-ai/cosmokit'],
  ['@standard-schema', 'spec', 'C:/Users/HP/.dsh/profiles/node_modules/@standard-schema/spec'],
  [null, 'js-yaml', 'C:/Users/HP/.dsh/profiles/node_modules/js-yaml'],
];

let linked = 0;
let skipped = 0;
for (const [scope, name, src] of SOURCES) {
  const dest = scope ? join(NM, scope, name) : join(NM, name);
  // 源包必须存在才算数（缺一个就明确报出来，不静默）。
  if (!existsSync(src)) {
    console.log(`✘ 源缺失（跳过，运行时将以 npm i 安装）：${src}`);
    continue;
  }
  if (existsSync(dest)) {
    console.log(`• 已存在（跳过）：${scope ? join(scope, name) : name}`);
    skipped += 1;
    continue;
  }
  if (scope) mkdirSync(join(NM, scope), { recursive: true });
  symlinkSync(src, dest, 'junction');
  console.log(`✔ 已连接：${scope ? join(scope, name) : name}`);
  linked += 1;
}

console.log(`\n完成：新建 ${linked} 个 junction，跳过 ${skipped} 个。`);
if (linked === 0 && skipped === 0) {
  console.log('⚠ 没有任何依赖被连接——请检查 profile node_modules 路径是否变化。');
  process.exit(1);
}
