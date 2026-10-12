/**
 * task-book.js —— 后台评审任务簿（目录协议）与 serve 单例管理。
 *
 * 背景（2026-10-13 后台任务化）：评审改后台执行（serve 进程编排，不阻塞前台、
 * 不受会话 600s 超时约束）。任务与 serve 之间的通信用**目录协议**——
 * `~/.dsh/dsh-code-review/tasks/<id>.json` 一任务一文件：
 *   - 投递方（会话内工具 / /review 命令 / 手动）原子写入 {status:'queued'} 任务；
 *   - serve 进程轮询目录，拾起 queued → 标 running → 执行 → 标 done/failed
 *     （结果全文写入任务的 result 字段）；报告落盘路径回填 reportPath；
 *   - 查询方（code_review_status / /review-status）读任务文件即得状态与结果。
 * 目录协议免端口/免握手/断线不丢/跨会话可见；key 等敏感值一律不进任务文件
 * （模型端点/凭据由 serve 进程现场解析，key 只进子进程 env）。
 *
 * serve 单例：`serve.pid` 文件 + process.kill(pid,0) 探活——多会话共享同一个
 * serve（对应「n+1」里的那 1 个）；不在时由投递方按需拉起（detached 独立进程，
 * 会话退出不影响）；serve 空闲 10 分钟自动退出（按需加载语义）。
 *
 * 零敏感：任务文件只含仓库/评审参数与结果文本，不含任何凭据。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 评审工作根目录（env 可覆盖，测试/多用户场景用）。 */
export const REVIEW_HOME = process.env.DSH_REVIEW_HOME
  ? resolve(process.env.DSH_REVIEW_HOME)
  : join(homedir(), '.dsh', 'dsh-code-review');

/** 任务目录。 */
export const TASKS_ROOT = join(REVIEW_HOME, 'tasks');

/** serve 进程 pid 文件。 */
export const PID_FILE = join(REVIEW_HOME, 'serve.pid');

/** serve 空闲回收时长（无任务且无活动 N 毫秒后退出）。 */
export const IDLE_EXIT_MS = 10 * 60 * 1000;

/** 任务状态机：queued → running → done | failed（failed 含超时/引擎错误）。 */
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed'];

/** 确保目录存在（幂等）。 */
export function ensureDirs() {
  mkdirSync(TASKS_ROOT, { recursive: true });
  return TASKS_ROOT;
}

/** 生成任务 id（时间戳 + 随机后缀，目录内有序可倒排）。 */
export function newTaskId(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

/** 任务文件路径。 */
export function taskFileOf(id) {
  return join(TASKS_ROOT, `${String(id).replace(/[^\w-]/g, '')}.json`);
}

/**
 * 原子写入任务文件（写临时文件再 rename，防读到半截 JSON）。
 * @param {object} task 完整任务对象。
 */
export function writeTaskFile(task) {
  ensureDirs();
  const file = taskFileOf(task.id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
  renameSync(tmp, file);
}

/**
 * 入队一个评审任务（投递方用）。
 * @param {object} fields 任务字段（不含 id/status/createdAt——自动补全）。
 * @returns {string} 任务 id。
 */
export function enqueueTask(fields) {
  const id = newTaskId();
  const task = {
    id,
    status: 'queued',
    repoPath: fields.repoPath ?? null,
    command: fields.command ?? 'review',
    mode: fields.mode ?? 'uncommitted',
    baseRef: fields.baseRef ?? null,
    headRef: fields.headRef ?? null,
    commit: fields.commit ?? null,
    focus: fields.focus ?? null,
    excludePaths: Array.isArray(fields.excludePaths) ? fields.excludePaths.map(String) : [],
    pendingPaths: Array.isArray(fields.pendingPaths) ? fields.pendingPaths.map(String) : [],
    config: fields.config && typeof fields.config === 'object' ? { ...fields.config } : {},
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
  };
  writeTaskFile(task);
  return id;
}

/** 读任务对象；不存在/损坏返回 null。 */
export function readTask(id) {
  const file = taskFileOf(id);
  if (!id || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 更新任务字段（读-改-写 + 原子落盘；不改动其它字段）。
 * @param {string} id 任务 id。
 * @param {object} patch 要合并进任务对象的字段。
 * @returns {object|null} 更新后的任务；任务不存在返回 null。
 */
export function updateTask(id, patch) {
  const task = readTask(id);
  if (!task) return null;
  writeTaskFile({ ...task, ...patch });
  return readTask(id);
}

/**
 * 列出最近任务（按 id 字典序倒排——id 以时间戳开头，即时间倒序）。
 * @param {number} [limit] 最多返回条数（默认 10）。
 * @returns {object[]} 任务对象数组（不含 null）。
 */
export function listTasks(limit = 10) {
  if (!existsSync(TASKS_ROOT)) return [];
  return readdirSync(TASKS_ROOT)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(TASKS_ROOT, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .slice(0, limit);
}

/**
 * serve 是否存活（pid 文件存在 + 进程探活）。
 * @returns {boolean}
 */
export function isServeAlive() {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // 探活：进程存在返回 true；不存在抛 ESRCH。
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 serve 在跑（单例）：存活则复用；否则 detached 拉起并等待 pid 文件出现。
 *
 * @param {object} [opts]
 * @param {number} [opts.waitMs] 最多等 serve 就绪（pid 文件出现）毫秒数，默认 8000。
 * @returns {Promise<{started: boolean, alive: boolean, reason?: string}>}
 *   started=true 表示本次由调用方拉起；alive=false 表示起身失败（可回退同步执行）。
 */
export async function ensureServe(opts = {}) {
  const waitMs = opts.waitMs ?? 8000;
  if (isServeAlive()) return { started: false, alive: true };
  ensureDirs();
  // serve 入口与本模块同目录（src/serve-entry.js）。
  const entry = fileURLToPath(new URL('./serve-entry.js', import.meta.url));
  // serve 日志落盘（detached 后 stderr 不可见；append 打开，父进程不阻塞）。
  let logFd = null;
  try {
    logFd = openSync(join(REVIEW_HOME, 'serve.log'), 'a');
  } catch {
    logFd = null;
  }
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: logFd ? ['ignore', 'ignore', logFd] : 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_REVIEW_HOME: REVIEW_HOME },
    });
    child.on('error', () => {}); // 拉起失败由 isServeAlive 兜底报告。
    child.unref(); // 脱离会话进程，会话退出不影响 serve。
  } catch (error) {
    return { started: true, alive: false, reason: String(error?.message ?? error) };
  } finally {
    if (logFd !== null) {
      try { closeSync(logFd); } catch { /* 忽略 */ }
    }
  }
  // 等 pid 文件出现（serve 启动即写）。超时不等待——任务文件已在盘上，
  // serve 稍后就绪会自行拾起；此处仅用于告知「是否已确认拉起」。
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (isServeAlive()) return { started: true, alive: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { started: true, alive: isServeAlive(), reason: 'serve 启动慢于预期（任务已入队，稍后自动执行）' };
}

/** 删除 serve pid 文件与陈旧任务文件（serve 退出时清理自己）。 */
export function cleanupServe() {
  try {
    if (existsSync(PID_FILE)) rmSync(PID_FILE);
  } catch {
    /* 忽略 */
  }
}
