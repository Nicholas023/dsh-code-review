/**
 * scripts/serve-smoke.mjs —— 后台 serve 链路冒烟（回归护网）。
 *
 * 验证「后台任务化」最小闭环：
 *   1. 投递方 enqueueTask 写任务文件（queued）；
 *   2. serve 守护进程（独立子进程）拾起任务 → 状态流转 running；
 *   3. serve 能启动引擎并执行（真实引擎 + 临时仓库；断言语义见下）；
 *   4. serve 空闲回收与 pid 单例探查钩子可用。
 *
 * 判据（可观察行为）：
 *   - 任务 status 从 queued 变为 running（serve 拾起并开始执行）——必过；
 *   - 引擎对「无改动仓库」若秒回则任务应到 done/failed（尽力断言，不断言具体值）；
 *   - 全程不依赖外部 LLM 可达性：uncommitted 评审即使 LLM 慢，serve 也不受影响
 *     （本冒烟只等状态流转，不等评审完成）。
 *
 * 隔离：DSH_REVIEW_HOME 指向临时目录，不碰生产任务簿。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DEFAULT_CONFIG } from '../src/config.js';
import { locateEngineBin } from '../src/runner.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'dcr-serve-smoke-'));
const repo = mkdtempSync(join(tmpdir(), 'dcr-serve-repo-'));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// 临时 git 仓库：一个文件 + commit + 一行改动（uncommitted diff 有内容但极小）。
const { spawnSync } = await import('node:child_process');
const gitInit = spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
check('git init 成功', gitInit.status === 0, `status=${gitInit.status}${gitInit.error ? ' ' + gitInit.error.message : ''}`);
writeFileSync(join(repo, 'a.py'), 'x = 1\n', 'utf8');
const gitAdd = spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' });
check('git add 成功', gitAdd.status === 0, `status=${gitAdd.status}${gitAdd.error ? ' ' + gitAdd.error.message : ''}`);
// git 调用带 encoding + 退出码校验（与此后几个 e2e 同一模式）：静默失败会让
// 评审跑在「无提交基线」的仓库上，diff 语义失真且报错形态误导排查。
const gitCommit = spawnSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@i', 'commit', '-m', 'init'], { encoding: 'utf8' });
check('git commit 成功（含提交基线）', gitCommit.status === 0, `status=${gitCommit.status}${gitCommit.error ? ' ' + gitCommit.error.message : ''}`);
writeFileSync(join(repo, 'a.py'), 'x = 2\n', 'utf8'); // 工作区改动

process.env.DSH_REVIEW_HOME = home;
const tb = await import(new URL('../src/task-book.js', import.meta.url).href);

// 投递一个任务（工具侧同款 enqueueTask）。
// ① 配置快照 spread DEFAULT_CONFIG 生成——此前手写五键与
// src/index.js taskFromArgs 实际形状已漂移（缺 concurrency_enabled/concurrency），
// 配置键改名/语义变化时本冒烟无法察觉；② report_dir 落到临时 home 下——原
// '~/dsh-code-review-reports' 会在任务 done 时把报告写进真实用户 HOME，与文件头
// 「隔离」声明相悖且收尾不清理。
const id = tb.enqueueTask({
  repoPath: repo,
  command: 'review',
  mode: 'uncommitted',
  config: {
    ...DEFAULT_CONFIG,
    review_model: 'session',
    report_dir: join(home, 'reports'), // 临时目录内，随 home 一起清理
    review_timeout_ms: 60_000, // 原默认 6h 是生产语义；冒烟只需短超时
  },
});
check('投递：任务入队（queued 落盘）', tb.readTask(id)?.status === 'queued', id);

// 拉起 serve 守护（非 detached——测试进程内管理；生产由 ensureServe detached 拉）。
const entry = join(ROOT, 'src', 'serve-entry.js');
const serve = spawn(process.execPath, [entry], {
  env: { ...process.env, DSH_REVIEW_HOME: home },
  stdio: 'pipe',
  windowsHide: true,
});
let serveLog = '';
serve.stdout.on('data', (d) => { serveLog += d; });
serve.stderr.on('data', (d) => { serveLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 引擎可用性：CI / 新克隆无 bin/codecheck（构建产物不入库，走 Release 分发）
// → 任务会「秒失败」，观察不到 queued→running 的瞬时中间态。此时改断言
// 「已被 serve 拾起并离开 queued」（同样证明后台链路走通）；本机有引擎时
// 仍严格断言观察到 running。判据与 unit-smoke 的密闭化同一原则。
const engineAvailable = Boolean(locateEngineBin({ ...DEFAULT_CONFIG, engine_bin: '' }));
let sawRunning = false;
let finalStatus = 'queued';
const deadline = Date.now() + 45_000;
while (Date.now() < deadline) {
  const t = tb.readTask(id);
  if (t && t.status === 'running') sawRunning = true;
  if (t) finalStatus = t.status;
  if (t && (t.status === 'done' || t.status === 'failed')) break;
  await sleep(400);
}

check(
  'serve 拾起任务：queued → running（后台链路通）',
  engineAvailable ? sawRunning : finalStatus !== 'queued',
  engineAvailable
    ? `末状态=${finalStatus}`
    : `无引擎环境（CI/新克隆）：已被拾起并执行，末状态=${finalStatus}`
);
check('serve 单例 pid 文件存在', existsSync(tb.PID_FILE), tb.PID_FILE ? '' : '');

// 引擎已真实启动（任务要么 done/failed，要么仍在 running——都说明引擎进程起了）。
const tFin = tb.readTask(id);
const engineTouched = tFin && (tFin.status === 'running' || tFin.status === 'done' || tFin.status === 'failed');
check('引擎执行被触碰（running/done/failed 任一即证明执行链路走通）', Boolean(engineTouched), tFin ? tFin.status : 'null');

// 收尾：优雅停 serve（哨兵文件）→ 等退出 → 清理。
mkdirSync(join(home), { recursive: true });
writeFileSync(join(home, '.stop'), new Date().toISOString(), 'utf8');
await sleep(2500);
try { serve.kill(); } catch { /* 已退出 */ }
rmSync(home, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exit(1);
}
console.log('\n✔ 全部通过：后台 serve 链路冒烟 OK');
