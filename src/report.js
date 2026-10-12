/**
 * report.js —— 评审报告落盘（ 五.7 / 词汇表「结果形态」）。
 *
 * 双给：① 会话内完整问题清单（由工具 execute 直接返回文本）；② 同步落一份
 * 评审报告文件（按日期/仓库存放）留档，作为「发 GitHub 前已审过」的凭证。
 *
 * 本文件管②的落盘约定（步骤 7 在此文件上完成判据：一次真实审查报告文件齐备）：
 *   <报告目录>/<YYYY-MM-DD>/<仓库名>-<HHMMSS>.md
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
 * 由仓库路径推出报告用的仓库名（取目录名，剥掉 .git 尾巴）。
 *
 * @param {string} repoPath 仓库绝对/相对路径。
 * @returns {string} 仓库名。
 */
export function repoNameOf(repoPath) {
  const base = basename(String(repoPath || '').replace(/[\\/]+$/, ''));
  return base.replace(/\.git$/i, '') || 'repo';
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
  const ymd = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const hms = now
    .toTimeString()
    .slice(0, 8)
    .replace(/:/g, '');
  const name = repoNameOf(repoPath);
  return resolve(join(base, ymd, `${name}-${hms}.md`));
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
  try {
    const path = reportFilePath({ reportDir, repoPath, now });
    // 目标是 报告根/日期/文件名 —— 逐级建目录（含日期子目录）。
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
