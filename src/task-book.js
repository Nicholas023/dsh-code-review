/**
 * task-book.js —— 后台评审任务簿（目录协议）与 serve 单例管理。
 *
 * 背景（后台任务化）：评审改后台执行（serve 进程编排，不阻塞前台、
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
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js'; // 仅取键集合作 config 白名单（不构成循环依赖：config.js 无本地导入）

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
  // 随机后缀固定 4 位 base36（36^4 ≈ 168 万种），与既有任务 id 格式/排序契约
  // 保持一致；随机源用 crypto.randomInt 而非 Math.random（加密强度、均匀分布，
  // 同秒并发生成时碰撞概率更低）。残余碰撞风险由 enqueueTask 的写入前探测兜底。
  const rand = randomInt(36 ** 4).toString(36).padStart(4, '0');
  return `${stamp}-${rand}`;
}

/** 任务文件路径。 */
export function taskFileOf(id) {
  return join(TASKS_ROOT, `${String(id).replace(/[^\w-]/g, '')}.json`);
}

/**
 * 原子写入任务文件（写临时文件再 rename，防读到半截 JSON）。
 *
 * 并发安全（临时文件名带 进程号 + 时间戳 + 随机后缀——
 * serve 进程与投递方对同一任务并发写时不再共用同一个 .tmp（旧实现固定
 * `${file}.tmp`：一个写者 rename 后另一个会 ENOENT 失败或相互覆盖）；
 * 写/改名失败时清理残留 tmp，避免目录堆积脏文件。
 *
 * 注意：本函数是覆盖语义（updateTask 的「读-改-写」依赖它），不做
 * 「目标已存在即拒绝」——新任务撞 id 的防护在 enqueueTask 层完成。
 *
 * @param {object} task 完整任务对象。
 */
export function writeTaskFile(task) {
  ensureDirs();
  const file = taskFileOf(task.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomInt(2 ** 32).toString(36)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    // 写/改名失败：清理本次的临时文件（不误删他人——文件名带本进程唯一后缀）。
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败也忽略，不掩盖原始错误 */
    }
    throw error;
  }
}

/** config 字段白名单（键集从 DEFAULT_CONFIG 派生，随默认键自动同步。
 * 任务文件只落评审相关可调项，杜绝上游把 token/apiKey 等凭据塞进 config 后被
 * 明文持久化到磁盘——「零敏感」契约的执行点之一（key 只进子进程 env）。 */
const CONFIG_KEY_WHITELIST = new Set(Object.keys(DEFAULT_CONFIG));

/**
 * 清洗任务卡的 config 覆盖层：只保留白名单键 + 基础类型值。
 *
 * @param {unknown} raw 调用方传入的 config。
 * @returns {object} 干净对象（永不返回 null；无合法键返回 {}）。
 */
function sanitizeTaskConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    // 白名单外键一律丢弃（含所有未知键/敏感键）。
    if (!CONFIG_KEY_WHITELIST.has(k)) continue;
    // 只保留标量基础类型；嵌套对象/数组不落盘（config 字段全是标量语义）。
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 入队一个评审任务（投递方用）。
 * @param {object} fields 任务字段（不含 id/status/createdAt——自动补全）。
 * @returns {string} 任务 id。
 */
export function enqueueTask(fields) {
  // 原先「existsSync 探测 → writeTaskFile」是
  // check-then-act——两个投递方同时通过探测后都会写入（tmp+rename 覆盖），
  // 后写者把先写者的任务文件整个换掉（并发投递丢任务）。改为 openSync 'wx'
  // **独占占位**：open 成功的唯一一个继续（后续 writeTaskFile 的 tmp+rename
  // 原子替换占位文件，写语义不变）；EEXIST = 已被占位/存在 → 换 id 重试。
  // 8 次仍失败显式报错，绝不静默覆盖已有任务文件。
  // 占位失败即换 id，不重复检查同一个 id（新增的
  // existsSync 预检与 wx 冲突捕获重叠且后者是判据，前者已删除）。
  // 注意：openSync 不负责建目录——writeTaskFile 曾隐式 mkdir，占位路径前置
  // ensureDirs（幂等）保证 tasks 目录存在（新 HOME 首次入队时目录尚未创建）。
  ensureDirs();
  let id = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cand = newTaskId();
    try {
      const fd = openSync(taskFileOf(cand), 'wx');
      closeSync(fd);
      id = cand;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // EPERM（权限/杀软拦截）不是「id 巧合」——
        // 重试 8 次只会把真实原因伪装成碰撞误报；立即上抛并带文件路径，
        // 调用方（工具 execute 外层）可把真实错误透给用户。
        if (error?.code !== 'EPERM') throw error;
        throw new Error(`任务占位文件写入被拒（EPERM）：${taskFileOf(cand)}（任务目录：${TASKS_ROOT}）`);
      }
      // 目标已存在（同秒并发投递/id 巧合）：换 id 下轮重试。
    }
  }
  if (id === null) {
    throw new Error('任务 id 碰撞：连续 8 次占位失败（目标文件均被占用），投递中止（请重试）');
  }
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
    requestor:
      fields.requestor && typeof fields.requestor === 'object' && fields.requestor.sessionId
        ? { sessionId: String(fields.requestor.sessionId) }
        : null,
    // 白名单过滤后落盘（零敏感契约）：未知键/凭据类键不进任务文件。
    config: sanitizeTaskConfig(fields.config),
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
  };
  try {
    writeTaskFile(task);
  } catch (error) {
    // 占位成功后写入失败（盘满/权限等）→ 回收占位
    // 文件——空文件残留在任务目录会被 readdir/JSON.parse 误读，且该 id 被
    // 永久占住永不执行；回收后调用方可重试投递。
    try {
      rmSync(taskFileOf(id), { force: true });
    } catch {
      /* 回收失败留待陈旧清理，不再向上叠加 */
    }
    throw error;
  }
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
    // 只处理 .json 文件：临时 *.tmp、锁 *.lock、陈旧回收 *.stale-* 均不以
    // .json 结尾，天然被过滤（无需额外排除条件）。
    .filter((f) => f.endsWith('.json'))
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
 * pid 是否存活（kill(pid, 0) 探活；EPERM = 进程存在但无信号权限 = 存活）。
 *
 * 探活逻辑从 serve-entry.js 收拢到本模块统一导出——
 * 两处旧实现（本文件 isServeAlive、serve-entry isPidAlive）曾各写一份，规则
 * 漂移过（一处只 catch 不区分错误码，把 EPERM 误判为死，陈旧锁/陈旧 pid 被
 * 误清、单例被误判破坏）。serve.pid 探活、任务锁陈旧回收、serve-entry 单例
 * 抢占共用同一判定，杜绝再次漂移。
 *
 * @param {number} pid 目标 pid。
 * @returns {boolean} 进程存活（含 EPERM 视为存活）。
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * serve 是否存活（pid 文件存在 + 进程探活）。
 * @returns {boolean}
 */
export function isServeAlive() {
  if (!existsSync(PID_FILE)) return false;
  let pid = NaN;
  try {
    pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    return false; // pid 文件损坏/不可读 → 按未存活处理
  }
  return isPidAlive(pid);
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

/** 删除 serve pid 文件（serve 退出时清理自己；陈旧任务文件的清理不在这里——
 * 任务文件是留档会话的凭证，清理策略由人工/运维决定，避免误删未消费任务）。 */
export function cleanupServe() {
  try {
    if (existsSync(PID_FILE)) rmSync(PID_FILE);
  } catch {
    /* 忽略 */
  }
}
