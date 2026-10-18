// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCURRENCY_DEFAULT, CONCURRENCY_MIN, CONCURRENCY_MAX } from './config.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 平台判定单点（避免 process.platform 内联比较散落各处——风格红线）。 */
const IS_WIN = process.platform === 'win32';

/** Windows 可执行扩展名。 */
const EXE = IS_WIN ? '.exe' : '';

/**
 * 引擎二进制文件名（平台后缀）。导出一份给冒烟脚本共用——各 smoke 曾各写
 * 一份 `win32 ? 'codecheck.exe' : 'codecheck'` 映射，四处拷贝会漂移
 * （统一从这里取，平台判定单点）。
 * @returns {string} 'codecheck.exe'（win32）或 'codecheck'。
 */
export function engineBinName() {
  return `codecheck${EXE}`;
}

/**
 * 收集「待提交文件清单」（步骤 6 敏感点名的数据来源）。
 *
 * 语义（与 git 行为对齐）：
 *   - untracked：`git ls-files --others --exclude-standard`（未被 .gitignore 排除的新文件）；
 *   - modified：`git diff --name-only`（工作区改动，含未暂存）；
 *   - staged：`git diff --cached --name-only`（已暂存）。
 * 三者并集去重 = 发 GitHub 前「所有要过目的文件」。删除的文件不在盘上，不点名。
 *
 * 安全卫生：只出相对路径（文件名+目录），不读文件内容；非 git 仓库 /
 * 命令失败 → 返回 []（点名层静默跳过，不阻断评审）。
 *
 * @param {string} repoPath 仓库路径（绝对或相对）。
 * @returns {string[]} 待提交文件相对路径（正斜杠）。
 */
export function collectPendingPaths(repoPath) {
  if (!repoPath) return [];
  const run = (args) => {
    try {
      // windowsHide: 宿主是 GUI 进程（无控制台），Windows 上 spawnSync 控制台
      // 程序（git）默认会新建可见控制台窗口 → 每次采集都在用户屏幕上闪黑窗。
      // POSIX 忽略该选项，写死 true 无副作用。
      const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      if (r.status !== 0) {
        // 失败原因区分（git 不存在（r.error=ENOENT）、非 git
        // 仓库（exit 128）、15s 超时（r.status=null）——此前一律静默返回 []，
        // 与「仓库干净」不可区分，掩盖真实故障。这里记一条 warn（评审不阻断）。
        // 显式三路 if/else（此前
        // `err || (三元) || '未知原因'` 的链式兜底里，「git exit N」分支恒非空
        // 字符串，末尾 `|| '未知原因'` 是永远走不到的死分支；三路各归各位，
        // status 非 null 且非 0 时必然落入 exit N，无死代码）。
        let reason;
        if (r.error?.message) reason = r.error.message; // git 二进制缺失（ENOENT 等）
        else if (r.status === null) reason = 'git 未响应（15s 超时）';
        else reason = `git exit ${r.status}`;
        console.warn(`[dsh-code-review] 待提交清单收集失败：${reason}（该仓库按无待提交文件处理，评审继续）`);
        return [];
      }
      return (r.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (error) {
      console.warn(`[dsh-code-review] 待提交清单收集异常：${String(error?.message ?? error)}（忽略）`);
      return [];
    }
  };
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  const modified = run(['diff', '--name-only']);
  const staged = run(['diff', '--cached', '--name-only']);
  const seen = new Set();
  const out = [];
  for (const p of [...untracked, ...modified, ...staged]) {
    const norm = String(p).replace(/\\/g, '/');
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * 定位引擎二进制。
 *
 * @param {object} cfg 配置快照（engine_bin 可配）。
 * @returns {{bin: string, source: string} | null} 定位结果；null = 未找到
 *   （显式路径均不存在且 PATH 中无此命令——此前 PATH 兜底分支无条件返回候选，
 *   函数永不返回 null，「找不到引擎」被推迟到 spawn 阶段以 ENOENT 暴露；现在
 *   用 where/which 探测过才返回，与 JSDoc 契约一致，probeEngineVersion 的
 *   null 分支即真实可达）。
 */
export function locateEngineBin(cfg) {
  const candidates = [];
  if (cfg?.engine_bin) {
    candidates.push({ bin: cfg.engine_bin, source: 'settings' });
    candidates.push({ bin: cfg.engine_bin + EXE, source: 'settings' });
  }
  // 插件包内 bin/（与引擎构建产物同层分发的标准位）。
  const pkgBin = join(PKG_ROOT, 'bin', engineBinName());
  candidates.push({ bin: pkgBin, source: 'package' });
  // PATH 兜底（同名命令）。
  candidates.push({ bin: engineBinName(), source: 'path' });

  for (const candidate of candidates) {
    // PATH 名不能 stat（spawn 自带解析），用 where/which 探测可解析性；
    // 找不到不返回，继续走完全部候选后返回 null。
    if (candidate.source === 'path') {
      // 探测结果三态：true=在 PATH、false=确定不在、null=探测命令自身缺失
      // （最小化镜像无 which）。null 按「候选放行」处理——交由 spawn 阶段做
      // 最终裁决（可解析则成功，否则自然 ENOENT），不误报 not found。
      if (commandOnPath(candidate.bin) !== false) return candidate;
      continue;
    }
    if (existsSync(candidate.bin)) return candidate;
  }
  return null;
}

/**
 * 探测命令名是否在 PATH 中可解析（Windows: where；POSIX: which）。
 * @param {string} cmd 命令名（可带 .exe 扩展名）。
 * @returns {boolean | null} true = PATH 中能找到；false = 确定不在；
 *   null = 探测命令自身缺失（无法判定）。
 */
function commandOnPath(cmd) {
  const probe = IS_WIN ? 'where' : 'which';
  try {
    // windowsHide 同上：探测命令（where/which）也是控制台程序，不隐藏会闪窗。
    const r = spawnSync(probe, [cmd], { stdio: 'ignore', shell: false, windowsHide: true });
    // 探测命令缺失时 spawnSync **不抛**——返回
    // { error: ENOENT, status: null }。此前只判 `r.status === 0`，探针自身
    // 缺失（最小化/容器镜像无 which/where）会走 false 分支，把「PATH 实际
    // 可解析」误报成引擎不存在（上轮修只覆盖了同步 throw 的路径，async
    // spawn 才 throw；spawnSync 是带 error 返回）。error 或 status===null
    // 都视为「无法判定」→ null（调用方按放行候选处理，让 spawn 裁决）。
    if (r.error || r.status === null) return null;
    return r.status === 0;
  } catch {
    // 极端异常（参数非法等）：同样按「无法判定」放行。
    return null;
  }
}

/**
 * 组装 review/scan 命令参数（与引擎 shared_flags.go 的真实 flag 对齐）：
 *   review: --repo <路径> [--from <base> --to <head> | --commit <hash>]
 *           [--background <重点>] [--audience agent]
 *   scan:   --repo <路径> [--background <重点>] [--audience agent]
 * provider 注入（写 ~/.opencodereview/config.json / --provider/--model 或环境变量）
 * 在步骤 5 由注入函数接上。
 *
 * @param {object} opts
 * @param {'review'|'scan'} opts.command         引擎子命令（review=diff 评审，scan=全目录扫描）。
 * @param {'uncommitted'|'branch'|'commit'} [opts.mode] diff 模式（review 下）。
 * @param {string} [opts.baseRef] 对比基线（branch 模式 → --from）。
 * @param {string} [opts.headRef] 目标端（branch 模式 → --to）。
 * @param {string} [opts.commit]  指定提交（commit 模式 → --commit）。
 * @param {string} [opts.focus]   重点领域（→ --background）。
 * @param {string} [opts.repoPath] 仓库路径（→ --repo）。
 * @param {string[]} [opts.excludePaths] 排除路径（→ 每个 --exclude <p>；如 engine/**）。
 * @param {boolean} [opts.concurrencyEnabled] 并发评审开关。
 *   false（默认）= 单线顺序审查；true = 并行审查（token 消耗增加，用户侧成本控制）。
 * @param {number} [opts.concurrency] 并发广度（1..32，默认 8）；仅开关开启时生效。
 * @returns {string[]} 参数字符串数组。
 */
export function buildReviewArgs(opts) {
  const args = [opts.command || 'review'];
  if (opts.repoPath) args.push('--repo', opts.repoPath);
  if (opts.command !== 'scan') {
    const mode = opts.mode || 'uncommitted';
    if (mode === 'branch') {
      // 引擎校验：--from/--to 必须成对。headRef 缺省回退 'HEAD'（引擎解析 ref）。
      args.push('--from', opts.baseRef || 'main', '--to', opts.headRef || 'HEAD');
    } else if (mode === 'commit') {
      if (opts.commit) args.push('--commit', opts.commit);
    }
    // uncommitted（默认）：不加 diff 定位参数（引擎默认审查工作区未提交改动）。
  }
  if (Array.isArray(opts.excludePaths)) {
    // 引擎 --exclude 是**单值、逗号分隔多模式**语义（形如 `--exclude 'a/**,b/**'`），
    // 不是可重复 flag：逐个 push 只有**最后一个**生效（5 个独立
    // --exclude 得 `Will review (227)`（等于未排除），合并成逗号分隔才得 36）。
    const patterns = opts.excludePaths
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim());
    if (patterns.length > 0) args.push('--exclude', patterns.join(','));
  }
  if (opts.focus) args.push('--background', opts.focus);
  // 并发：设置面板控制，成本控制权在用户。
  //  - 未开启 → 显式 --concurrency 1（单线，行为确定；引擎 agent.go 默认 ≤0 → 8，
  //    不传会随引擎默认漂移，违反「未开启 = 单线」的用户语义）；
  //  - 开启   → --concurrency <n>（钳制 1..32，默认 8——与引擎默认对齐）。
  let concurrency = CONCURRENCY_DEFAULT;
  if (opts.concurrencyEnabled === true) {
    if (Number.isFinite(opts.concurrency)) {
      concurrency = Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.round(opts.concurrency)));
    }
  } else {
    concurrency = CONCURRENCY_MIN; // 单线
  }
  args.push('--concurrency', String(concurrency));
  // 会话内返回：agent 受众 = 仅摘要（无进度噪音，干净短输出）。
  args.push('--audience', 'agent');
  return args;
}

/**
 * 运行引擎并收集输出。
 *
 * @param {object} opts
 * @param {string} opts.bin   引擎二进制路径。
 * @param {string[]} opts.args 参数。
 * @param {number}  [opts.timeoutMs] 进程级兜底（默认 6 小时——
 *                                   用户拍板「取消超时」：不再 30 分钟截断慢
 *                                   模型/大仓库，此值只防引擎死循环占死 serve）。
 * @param {object}  [opts.env]      额外环境变量（provider 注入位，步骤 5）。
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut?: boolean}>}
 */
export function runEngine({ bin, args, timeoutMs = 6 * 60 * 60 * 1000, env = {} }) {
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
        // spawn 的 options **没有** encoding 字段（那是
        // spawnSync / execFileSync 的选项），写在这里被 Node 静默忽略——data
        // 回调仍收到 Buffer，`stdout += chunk` 靠隐式 toString('utf8')，
        // UTF-8 多字节序列跨 chunk 边界时仍会截断成替换字符。真正写法是
        // spawn 后用 setEncoding 把流切成字符串模式（见下方 data 监听前）。
        // detached: true = 引擎独立进程组——POSIX 超时强杀时能对整个进程组
        // 发信号（连同引擎派生的孙进程），Windows 侧另走 taskkill /T /F。
        detached: true,
      });
    } catch (error) {
      finish({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }

    const timer = setTimeout(() => {
      // 超时终止：
      //  1) 先 SIGTERM 协作式终止；引擎若忽略则残留进程会长期占用 serve 锁/
      //     资源——宽限期（KILL_GRACE_MS）后升级 SIGKILL 强杀；
      //  2) Windows 无进程组信号，child.kill 只终止直接子进程，引擎派生的
      //     子进程会变孤儿——走 taskkill /T /F 连子树一起终止。
      killProcessTree(child);
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n[codecheck] 评审超时（>${Math.round(timeoutMs / 1000)}s）已中止`, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    // 字符串模式（spawn 不支持 encoding 选项，用
    // setEncoding 让 data 事件直接给出字符串，跨 chunk 边界不再损坏多字节字符。
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');

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
 * 进程树终止（超时兜底用）：
 *  - Windows：taskkill /T /F——连同引擎派生的子进程树一起强杀（child.kill
 *    只终止直接子进程，派生进程会变孤儿）；
 *  - 其他平台：先对整个进程组 SIGTERM 协作式终止（spawn 已 detached），
 *    宽限 KILL_GRACE_MS（5s）后升级 SIGKILL，防引擎忽略 SIGTERM 时残留
 *    进程长期占用 serve 锁/资源。
 * @param {import('node:child_process').ChildProcess} child 引擎子进程。
 */
const KILL_GRACE_MS = 5000;
function killProcessTree(child) {
  // 子进程已自然退出（exit/signal 事件已落定、
  // exitCode/signalCode 非 null）时直接返回——此前仍会发 taskkill / 进程组
  // 信号，属无效系统调用（超时回调与 exit 事件的竞态窗口；taskkill 对已死
  // pid 报「找不到进程」，进程组信号可能命中 pid 复用的新进程）。
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    // 此前只 kill 直系子进程，引擎派生的孙进程会变孤儿
    // （与函数名/注释承诺的「树」不符）。spawn 已带 detached: true，负 pid
    // 即进程组信号，能连同孙进程一起终止；进程组信号失败（如非组长）回退
    // 直系 kill。
    if (!child.pid) return;
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 子进程已退出则忽略 */
        }
      }
    };
    // 宽限期升级强杀；unref 不拖住父进程退出。
    const escalation = setTimeout(() => {
      killGroup('SIGKILL');
    }, KILL_GRACE_MS);
    escalation.unref?.();
    // exit 监听器必须**先**注册再发 SIGTERM：子进程若在 killGroup 与
    // 监听器注册之间退出，once('exit') 永不触发 → 5s 后强杀定时器仍会执行
    // kill(-pid)，而该 pid 可能已被系统复用（打死无关进程组）。
    child.once?.('exit', () => clearTimeout(escalation));
    killGroup('SIGTERM');
  } catch {
    /* 子进程已退出等情况忽略 */
  }
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

/**
 * 组装引擎子进程环境（步骤 5：OCR-managed 的 provider 环境注入位）。
 *
 * 与引擎 internal/llm/resolver.go 对齐：OCR_LLM_URL/TOKEN/MODEL/PROTOCOL/TIMEOUT
 * 五个变量（缺少任一大件则该注入策略不生效，引擎会继续走 config 文件/其他环境）。
 * key 经 resolveApiKey 解析后只存在于返回的 env 对象中（随 spawn 传递），不落盘。
 *
 * 优先级语义（尊重宿主）：
 *   - 用户已在 ~/.opencodereview/config.json 显式配置完整 provider → 引擎优先用
 *     用户配置（resolver 顺序如此），本注入作为「引擎侧未配置时」的默认通道；
 *   - 本注入直接填入 OCR_LLM_*（URL/TOKEN/MODEL 齐备即完整端点）。
 *
 * @param {object} dep
 * @param {object} dep.endpoint  resolveProvider 的产物：{url,protocol,model,keyEnv,providerLabel,extraBody?}
 * @param {string} dep.key       真实 key（调用方已用 resolveApiKey 取好）。
 * @param {number} [dep.timeoutMs] 引擎侧 LLM 单请求超时（毫秒→折算秒，下限 30s）；
 *                                缺省 600 秒。调用方通常传任务级 review_timeout_ms，
 *                                即「单请求上限 ≤ 任务整体上限」，慢模型宽容。
 * @returns {{ env: object, injected: boolean, note: string }}
 */
export function prepareEngineEnv({ endpoint, key, timeoutMs = 600_000 }) {
  const env = {};
  let injected = false;
  if (!endpoint?.url || !endpoint?.model || !key) {
    return { env, injected, note: '端点或凭据不完整，未注入引擎环境（引擎将回退自身配置）。' };
  }
  const protocol = endpoint.protocol || 'openai';
  env.OCR_LLM_URL = endpoint.url;
  env.OCR_LLM_TOKEN = key;
  env.OCR_LLM_MODEL = endpoint.model;
  env.OCR_LLM_PROTOCOL = protocol;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    env.OCR_LLM_TIMEOUT = String(Math.max(30, Math.round(timeoutMs / 1000)));
  }
  injected = true;
  let note = `评审模型：${endpoint.providerLabel} / ${endpoint.model}（协议 ${protocol}）`;
  // vLLM 兼容端点（thinkingFormat=chat-template）默认走思考模式：评审不需要
  // 思维链，思考链会让单请求耗时翻数倍（实测同一审查任务 50s→21s、输出 token
  // 减 65%），并撞上单请求超时导致文件组被跳过。endpoint.extraBody 已是
  // 结构化对象，序列化后经 OCR_LLM_EXTRA_BODY 传给引擎（引擎侧解析进
  // ResolvedEndpoint.ExtraBody，与 config provider 的 extra_body 同一条路径）。
  if (endpoint.extraBody && Object.keys(endpoint.extraBody).length > 0) {
    env.OCR_LLM_EXTRA_BODY = JSON.stringify(endpoint.extraBody);
    note += '；已注入 extra_body（关闭思考模式）';
  }
  return { env, injected, note };
}

export { PKG_ROOT };
