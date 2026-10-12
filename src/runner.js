/**
 * runner.js —— 引擎 codecheck 的定位与子进程调用（OCR-managed 模式管家）。
 *
 * 职责：
 *  1. locateEngineBin：按 设置 engine_bin > 插件包内 bin/ > PATH 的顺序定位
 *     引擎二进制（Windows: codecheck.exe；其他平台: codecheck）；
 *  2. runEngine：spawn 引擎并把 stdout/stderr 收集回来（同步执行语义：
 *     发起后原地等待，接受长任务，超时兜底）；
 *  3. buildReviewArgs：组装 review/scan 命令参数骨架（diff 三模式 +
 *     scan 全目录 + --background 重点领域）；provider 注入（-c 生成的 config
 *     或环境变量）在步骤 5 接入，本文件留注入位。
 *
 * 零敏感：不包含任何平台标识；provider 注入数据全部来自 DSH 配置（ctx 取数），
 * 不经本文件写死。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Windows 可执行扩展名。 */
const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * 定位引擎二进制。
 *
 * @param {object} cfg 配置快照（engine_bin 可配）。
 * @returns {{bin: string, source: string} | null} 定位结果；null = 未找到。
 */
export function locateEngineBin(cfg) {
  const candidates = [];
  if (cfg?.engine_bin) {
    candidates.push({ bin: cfg.engine_bin, source: 'settings' });
    candidates.push({ bin: cfg.engine_bin + EXE, source: 'settings' });
  }
  // 插件包内 bin/（与引擎构建产物同层分发的标准位）。
  const pkgBin = join(PKG_ROOT, 'bin', `codecheck${EXE}`);
  candidates.push({ bin: pkgBin, source: 'package' });
  // PATH 兜底（同名命令）。
  candidates.push({ bin: `codecheck${EXE}`, source: 'path' });

  for (const candidate of candidates) {
    // PATH 名不 stat（交给 spawn 解析）；显式路径必须存在。
    if (candidate.source === 'path') {
      // spawn 会沿 PATH 找到；但为了在工具描述里给出确定信息，先不校验存在性。
      return candidate;
    }
    if (existsSync(candidate.bin)) return candidate;
  }
  return null;
}

/**
 * 组装 review/scan 命令参数。
 * 骨架期覆盖四个模式 + 重点领域；provider 注入位（--config / 环境变量）
 * 在步骤 5 由注入函数接上。
 *
 * @param {object} opts
 * @param {'review'|'scan'} opts.command         引擎子命令（review=diff 评审，scan=全目录扫描）。
 * @param {'uncommitted'|'branch'|'commit'} [opts.mode] diff 模式（review 下）。
 * @param {string} [opts.baseRef] 对比基线分支（branch 模式）。
 * @param {string} [opts.headRef] 目标分支（branch 模式）。
 * @param {string} [opts.commit]  指定提交（commit 模式）。
 * @param {string} [opts.focus]   重点领域（→ --background）。
 * @param {string} [opts.repoPath] 仓库路径。
 * @returns {string[]} 参数字符串数组。
 */
export function buildReviewArgs(opts) {
  const args = [opts.command || 'review'];
  if (opts.command === 'scan') {
    if (opts.repoPath) args.push(opts.repoPath);
    return args;
  }
  const mode = opts.mode || 'uncommitted';
  if (mode === 'branch') {
    if (opts.headRef) args.push('--branch', opts.headRef);
    args.push('--base', opts.baseRef || 'main');
  } else if (mode === 'commit') {
    if (opts.commit) args.push('--commit', opts.commit);
  }
  // 工作区未提交（uncommitted，默认）：不追加 diff 定位参数。
  if (opts.focus) args.push('--background', opts.focus);
  if (opts.repoPath) args.push('--dir', opts.repoPath);
  return args;
}

/**
 * 运行引擎并收集输出。
 *
 * @param {object} opts
 * @param {string} opts.bin   引擎二进制路径。
 * @param {string[]} opts.args 参数。
 * @param {number}  [opts.timeoutMs] 超时（默认 10 分钟）。
 * @param {object}  [opts.env]      额外环境变量（provider 注入位，步骤 5）。
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut?: boolean}>}
 */
export function runEngine({ bin, args, timeoutMs = 10 * 60 * 1000, env = {} }) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };

    let child;
    try {
      child = spawn(bin, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n[codecheck] 评审超时（>${Math.round(timeoutMs / 1000)}s）已中止`, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * 快速探测引擎版本（工具描述/首启引导里展示，亦作二进制可用的可观察验证）。
 *
 * @param {object} cfg 配置快照。
 * @returns {Promise<string|null>} 版本串首行；null = 不可用。
 */
export async function probeEngineVersion(cfg) {
  const located = locateEngineBin(cfg);
  if (!located) return null;
  const result = await runEngine({ bin: located.bin, args: ['--version'], timeoutMs: 30_000 });
  if (!result.ok) return null;
  return result.stdout.split('\n')[0]?.trim() || null;
}
