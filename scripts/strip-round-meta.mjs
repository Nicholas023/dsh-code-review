#!/usr/bin/env node
/**
 * scripts/strip-round-meta.mjs —— 发布面轮次元数据剥离（一次性工具）。
 *
 * 背景：多轮评审修复在 src/、scripts/、client.js、std-facet.js 的注释里
 * 累积了大量轮次元数据（「」「复查修」「自审项 #N」
 * 「卡 N #N」）。整个源码树都是发布面（package.json files 收 scripts/，
 * client.js 打包进 GUI），这些轮次标记必须从注释中剥除，只留技术正文——
 * 读者无「第 N 轮」上下文，日期+编号对他们是噪音，且暴露内部迭代节奏。
 *
 * 用法（**默认干跑**——破坏性批量改写必须先人工复核统计结果）：
 *   node scripts/strip-round-meta.mjs            # 干跑：只统计与列残留，不改文件
 *   node scripts/strip-round-meta.mjs --apply    # 实跑（原地重写）
 *
 * 规则（按序，全部为保守匹配）：
 *   r0  日期+轮次动作［+（…）括号段 或 空格编号段］＋可选闭括号＋可选冒号 → 删
 *      （覆盖「」「」
 *      「」等全部轮次动作形态）
 *   r1  （#N） / （#N 附加词） → 删（孤立轮次编号引用，如「原子抢占」）
 *   r4  「自审项 #N」 → 删
 *   r5  残余空括号对、孤括号壳清理（r0/r1 拆解后的壳）
 * 处理范围：src/**、scripts/**、根 client.js、std-facet.js（.js/.mjs）。
 * 不触碰 engine/、docs/、根 README 等（非发布源码注释或已手工处理）。
 */
import { readdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认干跑（DRY）：写盘必须显式 --apply。批量注释改写不可逆，且历史上有
// 规则误伤正文的实例，强制「先看统计、再落盘」。
const DRY = !process.argv.includes('--apply');
const SCOPES = ['src', 'scripts'];
const ROOT_FILES = ['client.js', 'std-facet.js'];
// 本脚本自身必须排除：它的注释是「规则说明 + 示例日期/动作词」（如 r0 的
// 备选清单就含「自审项」「复查修」等字面量），既不该被改写，也会让残留检测
// 恒报假阳性。
const SELF = fileURLToPath(import.meta.url);

function collectFiles() {
  const out = [];
  const walk = (dir) => {
    // 目录可能不存在（部分 checkout / 首次运行）或不可读：跳过而非抛 ENOENT
    // 中断整个脚本（本工具的核心行为是「剥元数据」，不该被目录缺失打断）。
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of entries) {
      const p = join(dir, f);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue; // 竞态删除/无权限：跳过该条目
      }
      if (st.isDirectory()) {
        if (f === 'node_modules' || f === 'bin') continue;
        walk(p);
      } else if ((extname(p) === '.js' || extname(p) === '.mjs') && p !== SELF) {
        out.push(p);
      }
    }
  };
  for (const s of SCOPES) walk(s);
  for (const f of ROOT_FILES) {
    try {
      lstatSync(f);
      out.push(f);
    } catch { /* 文件不存在则跳过 */ }
  }
  return out;
}

const RULES = [
  // r0：日期+轮次动作［+（…）括号段 或 空格编号段］＋可选闭括号＋可选冒号。
  // alternation 必须**长词优先**（自审项>复查修>修复>修订>…>修）：JS 正则按
  // 顺序取第一个可匹配备选，「修」排前面会把「修复」剥成「复：」，破坏正文。
  // 「…」「…」
  // 这类可靠性实测/自审记录同样属轮次动作。
  [/2026-10-\d{2} (?:客户端装载协议实测|自审项|复查修|修复|修订|清除|强化|落定|迭代|实测)(?:（[^）]*）| ?#\d+[^）:：]*)?[）]?[:：]? ?/g, ''],
  // r0b：行尾孤立日期（动作/编号在下一行行首）——「……兼容；2026-10-16」+
  // 换行+「// 复查修：」形态拆两行写时，r0 不跨行、两半都漏；行尾
  // 日期先删，行首残留动作由 r0c（在 r1 拆括号后）收。只剥**标点分隔**的
  // 行尾日期（前导 ； 、 、）：行尾日期也可能是正文组成部分（如「（2026-10-16」
  // 后接下一行「实测 DSH 官方账号模型清单」——时间+实证记录），裸行尾日期
  // 绝不删。
  [/[；;，,、] ?2026-10-\d{2}$/gm, ''],
  // r1：孤立轮次编号引用（非日期开头）——（#N）/（#N 附加词）。
  [/（ ?#\d+[^）]* ?）/g, ''],
  // r4：孤立自审项编号（无日期前缀；r0 已吃掉带日期的形态）。
  [/（?自审项 ?#\d+ ?）?[:：]? ?/g, ''],
  // r0c：（必须在 r1/r4 之后执行）行首引导符后的孤立轮次动作残留，如
  // 「// 复查修：」被 r1 拆掉括号后变成「// 复查修：」再收——顺序在
  // r1 前会因括号挡路漏掉（settings-schema 跨行形态实证）。
  // 同样去掉裸「修」：它会把「修正/修改/修饰」等正常词的首字也当轮次动作吞掉
  // （如 `// 修正：边界` → `// 正：边界`）；已知轮次形态（修复/修订/复查修…）
  // 均已由更长的备选覆盖。
  [/^(\s*(?:\/\/|\*+)\s*)(?:自审项|复查修|修复|修订|清除|强化|落定|迭代|实测)[:：] ?/gm, '$1'],
  // r5：残余壳清理——空括号对+冒号、孤括号（r0/r1 拆解后的壳）。
  // 注意：不做任何「）：→：」替换——合法的「（毫秒）：与默认值同为…」
  // 这类正文会被误伤，宁可让个别拆解壳残留、人工收尾。
  // 收紧为「必须存在空括号对」（（ ?） 是必需项，不是可选项）：只在
  // 「拆解后留下空壳括号再跟冒号」这一确定形态上替换，`（毫秒）：` 不再命中。
  [/（ ?） ?（?：/g, '：'],
  [/（ ?）(?=[:：。，；）])/g, ''],
  [/（ ?）$/gm, ''],
];

const FILES = collectFiles();
let totalChange = 0;
let totalFile = 0;
const remains = [];

for (const file of FILES) {
  const orig = readFileSync(file, 'utf8');
  let text = orig;
  let changes = 0;
  for (const [re, rep] of RULES) {
    const before = text;
    text = text.replace(re, rep);
    if (text !== before) {
      // 粗略统计替换次数
      const cnt = (before.match(re) || []).length;
      changes += cnt;
    }
  }
  if (text !== orig) {
    totalChange += changes;
    totalFile += 1;
    if (!DRY) writeFileSync(file, text, 'utf8');
    // 统计残余元数据形态（r 规则未覆盖的）
    const rest = [];
    for (const line of text.split('\n')) {
      if (/2026-10-\d{2}|复查修|自审项|（#\d|（卡 \d+ #\d|（\d+ 裁决|#\d+ 已改/.test(line)) {
        rest.push(line.trim().slice(0, 100));
      }
    }
    if (rest.length) remains.push({ file, rest });
  }
}

console.log(`[strip] ${DRY ? 'DRY-RUN' : 'APPLIED'}：${totalFile}/${FILES.length} 个文件，${totalChange} 处替换`);
if (remains.length) {
  console.log(`[strip] ⚠ 残余元数据形态 ${remains.length} 个文件（需人工审）：`);
  for (const { file, rest } of remains) {
    console.log(`  ${file}:`);
    for (const r of rest) console.log(`    · ${r}`);
  }
} else {
  console.log('[strip] 无残余元数据形态。');
}
