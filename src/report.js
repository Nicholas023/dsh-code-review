// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * report.js —— 评审报告落盘（结果形态：会话内清单 + 报告文件留档）。
 *
 * 双给：① 会话内完整问题清单（由工具 execute 直接返回文本）；② 同步落一份
 * 评审报告文件（按日期/仓库存放）留档，作为「发 GitHub 前已审过」的凭证。
 *
 * 本文件管②的落盘约定（步骤 7 在此文件上完成判据：一次真实审查报告文件齐备）：
 *   <报告目录>/<YYYY-MM-DD>/<仓库名>-<HHMMSSmmm>.md
 *
 * 零敏感：不硬编码平台路径；报告目录默认来自配置（~ 展开用户态）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';

/**
 * 展开用户主目录（~ 前缀）为绝对路径。
 *
 * @param {string} p 可能含 ~ 的路径。
 * @returns {string} 绝对路径。
 */
export function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 由仓库路径推出报告用的仓库名（取目录名，剥掉 .git 尾巴，白名单净化）。
 *
 * 返回名直接拼进报告路径，原实现只剥 .git 尾巴、不做净化——
 * 若路径派生名含 Windows 非法字符（: * ? " < > |）或控制字符，mkdir/writeFile
 * 会失败或产生异常文件。这里按白名单过滤（仅保留 Unicode 字母/数字与 . _ -，
 * 其余替换为 _——\w 是 ASCII-only，用 \w 会把中文/日文仓库名整段替换成 _，
 * 注释同步为 Unicode 属性类实现）并截断到 100 字符。
 *
 * 白名单净化只解决「非法字符」这一类——Windows
 * 保留设备名（CON/PRN/NUL 等）全是白名单内合法字符，净化后仍是原名，本函数
 * 并不挡设备名（此前注释把设备名写进「这里按白名单过滤」的声称内，名不副实）。
 * 设备名归报告路径生成处的日期/仓库目录前缀兜底（实际撞上的概率趋零），此处
 * 不额外处理——声明与实现保持一致。
 *
 * @param {string} repoPath 仓库绝对/相对路径。
 * @returns {string} 仓库名。
 */
export function repoNameOf(repoPath) {
  const base = basename(String(repoPath || '').replace(/[\\/]+$/, ''));
  // \w 是 ASCII-only——中文/日文等仓库名会被整段替换成 _，且不同中文仓库名
  // 归一成同一目录名互相覆盖。改用 Unicode 属性类（\p{L} 字母 \p{N} 数字，
  // u 标志），保留下划线/点/连字符。
  const cleaned = base.replace(/\.git$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '_');
  // 纯点/下划线/连字符的「伪名字」（如路径是 '.'、'..'）没有可用仓库名——
  // base 对 '.' 就是 '.'，清洗规则认为点合法会把它原样放行；拿它当目录名
  // 写盘会解析到目录自身/其父目录，报告路径整个乱掉。统一回落 'repo'。
  const name = cleaned && !/^[._-]+$/.test(cleaned) ? cleaned : 'repo';
  // 按 **Unicode 码点** 截断：slice(0,100) 按 UTF-16 码元切，第 100 个码元落在
  // 代理对中间（扩展 CJK 字符）会留下孤立代理，mkdir/writeFile 可能报错或产出
  // 乱码目录名。展开为码点数组再切，保证不劈开代理对。
  return [...name].slice(0, 100).join('');
}

/**
 * 计算报告文件路径（日期分目录，时间戳防覆盖）。
 *
 * @param {object} opts
 * @param {string} opts.reportDir  报告根目录（配置值，可为 ~）。
 * @param {string} opts.repoPath   被审仓库路径（用于仓库名）。
 * @param {Date}   [opts.now]      时间基准（测试注入；默认现在）。
 * @returns {string} 绝对报告路径。
 */
export function reportFilePath({ reportDir, repoPath, now = new Date() }) {
  const base = expandHome(reportDir);
  // 日期与文件名时间戳统一取【本地时间】——旧实现 ymd 用
  // toISOString()（UTC）、hms 用 toTimeString()（本地），跨时区/临近午夜时
  // 报告会落到「UTC 日期目录 + 本地时间文件名」的错位组合（同一天的报告
  // 被拆进两个日期目录）。
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // 时间戳加毫秒位——同一秒内并发评审的两次落盘不再互相覆盖
  // （旧实现只到 HHMMSS，秒级并发时后写者静默覆盖前一份报告）。
  const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const name = repoNameOf(repoPath);
  return resolve(join(base, ymd, `${name}-${hms}.${ms}.md`));
}

/**
 * 写报告文件（自动建目录）。失败不抛：落盘失败应显式返回错误信息给人看，
 * 而不是中断会话（评审结果本身由工具返回文本，报告是留档补充）。
 *
 * @param {object} opts
 * @param {string} opts.reportDir 报告根目录。
 * @param {string} opts.repoPath  仓库路径。
 * @param {string} opts.body      报告正文（Markdown）。
 * @param {Date}   [opts.now]     时间基准。
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function writeReport({ reportDir, repoPath, body, now }) {
  // 入参预检放在任何 IO 之前——reportDir 缺失/非字符串时旧实现
  // 让 join 抛 ERR_INVALID_ARG_TYPE，body 非字符串时 writeFile 才报错（此时目录
  // 已建好，留下空目录），而异常又被统一捕获成 error 字符串，调用方只能看到
  // 与「配置缺失」无关的模糊信息，难以定位。这里显式校验并返回明确错误。
  const base = expandHome(reportDir);
  if (typeof base !== 'string' || base === '') {
    return { ok: false, error: '报告目录未配置（report_dir 为空或非法）' };
  }
  if (typeof body !== 'string') {
    return { ok: false, error: '报告正文缺失（body 必须是字符串）' };
  }
  try {
    // 传入已展开的 base（而非原始 reportDir）：reportFilePath 内部仍会调
    // expandHome（对绝对路径幂等、无副作用，保留是为其公共 API 允许 reportDir
    // 带 ~）；这里传 base 保证「校验用的路径」与「最终写入路径」同源。
    const path = reportFilePath({ reportDir: base, repoPath, now });
    // 目标是 报告根/日期/文件名 —— 逐级建目录（含日期子目录）。
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
