/**
 * serve-entry.js —— 后台评审服务（独立进程，detached 挂后台，按需加载）。
 *
 * 职责（对应「n+1」里的那 1 个 serve）：
 *  - 守护模式（默认）：轮询任务目录（tasks/），串行执行 queued 任务；
 *    空闲（无任务且长期无活动）自动退出——按需加载语义，不评审不开；
 *  - 单例：启动即写 serve.pid；重复启动（pid 已存在且进程存活）直接退出；
 *  - 任务执行：读任务 → 标 running → executeReview（评审执行体，模型端点/
 *    凭据现场解析，key 不进任何文件）→ 标 done/failed（结果全文进任务结果）；
 *  - 慢模型不阻塞任何人：评审在自己的进程里跑，会话/用户该干嘛干嘛，
 *    查询方随时读任务文件取状态与结果。
 *
 * 用法：
 *   node src/serve-entry.js            # 守护模式（默认）
 *   node src/serve-entry.js --run <id> # 单任务执行后退出（手动/调试）
 *   node src/serve-entry.js --stop     # 请求守护进程退出（写 .stop 哨兵）
 *
 * 零敏感：不含任何平台标识；评审模型来自任务 config（用户设置），
 * 模型端点/凭据解析全在本进程内完成，不落盘。
 */
import {
  existsSync, writeFileSync, writeSync, readFileSync, openSync, closeSync,
  rmSync, readdirSync, renameSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { executeReview } from './review-exec.js';
import { buildResultText } from './result-text.js';
import {
  REVIEW_HOME, TASKS_ROOT, PID_FILE, IDLE_EXIT_MS,
  ensureDirs, readTask, updateTask, cleanupServe, isPidAlive,
} from './task-book.js';

/** 优雅停哨兵文件（--stop 写；守护每轮检查）。 */
const STOP_FILE = join(REVIEW_HOME, '.stop');

/** 守护退出统一清理：删 .stop 哨兵（陈旧哨兵只对上一个实例有意义——不删则
 * 「停一次 = 永久停」：下次拉起的新守护循环第一件事就命中哨兵立刻退出，任务
 * 永远停在 queued）+ 删 serve.pid。
 * 仅清理本进程实际拥有的状态——serveLoop 的
 * catch 也到达这里：claimServe 抛非 EEXIST 错误（EACCES/ENOSPC/ensureDirs
 * 失败）时本进程从未持有单例，删除 serve.pid / .stop 会破坏活守护的单例
 * 判定（后续 ensureServe 判死 → 再拉起一个 → 双守护）并吞掉其停机请求。 */
function shutdownServe() {
  if (readOwner(PID_FILE) !== process.pid) return;
  try {
    rmSync(STOP_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  cleanupServe();
}

/** 进程身份：单例守护只允许一个活实例。
 * 原实现「isServeAlive() 探活 → 写 PID_FILE」两步
 * 判断有 check-then-act 竞态——两个实例可同时通过探活、各自写 pid，双双存活
 * 破坏单例。改为与 acquireTaskLock 同构的 openSync('wx') 独占创建：谁的 open
 * 成功谁就是唯一实例；后到者读 pid 探活，持有者存活则退出（复用单例），
 * 陈旧 pid（持有者已死）清除重试一次。open 原子性替代原 tmp+rename 方案。
 * 陈旧判定的不等价窗口已封——「内容损坏（写一半/
 * 崩溃残留）」不再无条件按陈旧处理，统一走 isOwnerAlive 的 mtime 年龄门槛；
 * 陈旧回收改用 rename 原子移走（rm+open 会把另一进程刚建的新文件一并删掉，
 * 形成双执行者窗口）。任务锁（acquireTaskLock）使用同一套判定与回收。 */
function claimServe() {
  ensureDirs();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(PID_FILE, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (isOwnerAlive(PID_FILE)) {
        process.stderr.write('[serve] 已有 serve 实例在跑（复用单例），本进程退出。\n');
        process.exit(0);
      }
      // 陈旧 pid 文件（持有者已死 / 内容损坏且长期未更新）：原子移走后**重试**
      // openSync('wx')——不能 throw：并发启动时另一进程可能已抢先回收，pid 文件
      // 此刻已不存在，抛原 EEXIST 会把可成功的抢占变成一个崩溃的 serve 进程。
      // 两次都拿不到才走循环外的「已有实例」退出路径。
      if (!reclaimStaleLock(PID_FILE)) continue;
    }
  }
  // 理论不可达（两次 EEXIST = 清除后又有新持有者写入）：按已有实例退出。
  process.stderr.write('[serve] 单例抢占失败（pid 文件冲突），本进程退出。\n');
  process.exit(0);
}

/** 读锁/pid 文件持有者：返回 pid；文件缺失/不可读/内容非法 → NaN。 */
function readOwner(file) {
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

/**
 * 文件是否被「活着的持有者」占着。
 *  - 内容可解析出合法 pid → 交给 isPidAlive（探活语义，EPERM 视为存活）；
 *  - 内容损坏/为空（可能正在写入，或崩溃残留）→ 按 mtime 年龄：刚创建
 *    （<5s）保守视为持有中（等下一轮再判），长期未更新才按陈旧处理。
 *    防止把「写入到一半的锁」判死清除，两个执行者同时入场。
 */
function isOwnerAlive(file) {
  const owner = readOwner(file);
  if (Number.isInteger(owner) && owner > 0) return isPidAlive(owner);
  let mtime;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    // 无法 stat：保守判持有中，绝不把「读不到的锁」当陈旧回收
    // （误回收会让两个执行者同时入场）。
    return true;
  }
  return (Date.now() - mtime) < 5000;
}

/**
 * 陈旧锁回收：rename 原子移走（A 移走后 B 的 rename 抛 ENOENT 直接放弃——
 * 天然互斥，取代 rm+open 的「把新锁一并删掉」窗口），调用方循环里重建。
 * @returns {boolean} 是否移走成功（false = 已被他人回收/不存在）。
 */
function reclaimStaleLock(file) {
  try {
    // 时间戳单次取样：rename 与后续 rmSync 必须指向同一文件（两次调用
    // Date.now() 可能落在不同毫秒，第二次会去删一个不存在的乱名）。
    const stale = `${file}.stale-${Date.now()}`;
    renameSync(file, stale);
    // 移走后顺手清掉陈旧残留：rename 移出的文件已经不可能再被误认成锁
    // （文件名带 .stale- 后缀，探活/回收只按原名查找）；留着只会让任务
    // 目录累积垃圾。rmSync 失败（杀软拦截等）不影响本次回收结果，残留的
    // *.stale-* 文件也无害，静默忽略。
    try {
      rmSync(stale, { force: true });
    } catch {
      /* 清理失败：陈旧残留无害，忽略 */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 排他抢占任务（openSync 'wx' 独占创建锁文件）。
 *
 * 旧实现「updateTask(running) → 重读比对 startedAt」存在
 * 真窗口——A 写入 running(tsA) → B 覆盖写入 running(tsB) → A 重读：可能读到
 * tsA（B 尚未写入）放行，B 重读 tsB 也放行 → 两个实例同时执行同一任务
 * （重复调用模型端点 + 结果互相覆盖）。锁文件用 'wx' 独占创建，无论多少个
 * 进程同时竞争，openSync 成功的唯一一个才持有执行权——原子，无窗口。
 *
 * 陈旧锁兜底：持有者崩溃（未及释放）时锁永久残留会把任务卡死。锁内容 =
 * 持有者 pid，抢锁失败时探活——持有者已死则清除锁重试一次。判定与回收
 * 复用 claimServe（serve.pid）同款语义（isOwnerAlive 的 mtime 年龄门槛 +
 * reclaimStaleLock 的 rename 原子移走），两处共享不再各写一套。
 *
 * @param {string} taskId 任务 id。
 * @returns {string | null} 锁文件路径（持有）；null = 抢占失败（他人持有或 IO 错误）。
 */
function acquireTaskLock(taskId) {
  const lockPath = join(TASKS_ROOT, `${taskId}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // 非冲突错误（权限/盘满等）与「锁被他人持有」语义不同：静默返回 null
        // 会让调用方打出通用的「抢占失败」文案，把真实 I/O 故障藏起来。
        // 与 enqueueTask 对 EPERM 的处理口径一致——写诊断到 stderr 再放弃。
        process.stderr.write(`[serve] 任务锁获取异常（${error?.code ?? error?.message}）：${taskId}\n`);
        return null;
      }
      // 陈旧判定改走 isOwnerAlive（内容损坏/写入到
      // 一半的锁按 mtime 年龄保守判持有，防误删双执行者）+ reclaimStaleLock
      // （rename 原子移走，防 rm+open 删掉他人刚建的新锁）——与 claimServe
      // 完全同构；原「parse → isPidAlive → rmSync」实现无条件把损坏锁判死，
      // 且 rm+open 有双执行者窗口。
      if (isOwnerAlive(lockPath)) return null; // 锁被活进程持有（含写入中的锁）
      // 已被他人回收：锁文件此刻可能已不存在，continue 重试 openSync('wx')
      // 比 return null（本轮跳过该任务）更响应——与 claimServe 的意图一致。
      if (!reclaimStaleLock(lockPath)) continue;
    }
  }
  return null;
}

/** 结果全文组装（会话内呈现：header + 引擎输出 + tail）。 */
// 结果文本组装已抽到 result-text.js（与 index.js 同步回退形态共用同一实现，
// 两个入口的失败路径呈现曾因各自维护而漂移），这里直接用共享函数。

/** 执行单个任务（原子状态流转 + 结果回写）。 */
export async function runTaskOnce(taskId) {
  const task = readTask(taskId);
  if (!task) {
    process.stderr.write(`[serve] 任务不存在：${taskId}\n`);
    return null;
  }
  if (task.status === 'running') {
    process.stderr.write(`[serve] 任务已在执行中：${taskId}\n`);
    return task;
  }
  // 原子抢占（openSync('wx') 排他锁——守护模式轮询
  // 与 --run 手动模式可同时竞争同一 queued 任务（--run 不写 pid、不参与单例），
  // 锁保证最终恰好一个执行者；锁在运行期持有，finally 统一释放（正常/异常
  // 路径都归还，崩溃残留由陈旧锁探活兜底，见 acquireTaskLock）。
  const lockPath = acquireTaskLock(taskId);
  if (!lockPath) {
    process.stderr.write(`[serve] 任务抢占失败（已有执行者或锁获取失败）：${taskId}\n`);
    return task;
  }
  try {
    // 锁保证「同一时刻仅一个执行者」，但不保证任务
    // 仍在排队——抢锁窗口里他人可能已把同一任务执行完（锁在执行结束时释放，
    // 这里才抢到）。拿锁后重读：任务消失/非 queued 一律让位——不执行、不覆盖
    // 终态（锁在 finally 归还）。
    const fresh = readTask(taskId);
    if (!fresh) {
      process.stderr.write(`[serve] 任务不存在（抢锁后）：${taskId}\n`);
      return null;
    }
    if (fresh.status !== 'queued') {
      process.stderr.write(`[serve] 任务已不在排队（status=${fresh.status}），让位：${taskId}\n`);
      return fresh;
    }
    const claimedAt = new Date().toISOString();
    updateTask(taskId, { status: 'running', startedAt: claimedAt });
    try {
      // 用抢锁后重读的 fresh（而非初读的 task）：两次读之间若有并发写入
      // （配置/模式变更），初读快照会丢更新。
      const exec = await executeReview(fresh);
      const text = buildResultText(exec);
      const done = updateTask(taskId, {
        status: exec.ok ? 'done' : 'failed',
        finishedAt: new Date().toISOString(),
        result: {
          ok: exec.ok,
          code: exec.code,
          elapsedSec: exec.elapsedSec,
          timedOut: exec.timedOut,
          reportPath: exec.reportPath,
          modelNote: exec.modelNote,
          text,
        },
      });
      return done ?? task;
    } catch (error) {
      const errText = String(error?.stack ?? error?.message ?? error);
      process.stderr.write(`[serve] 任务执行异常：${errText}\n`);
      return updateTask(taskId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        result: { ok: false, code: null, elapsedSec: null, timedOut: false, reportPath: null, modelNote: '', text: `执行异常：${errText}` },
      }) ?? task;
    }
  } finally {
    // 释放锁：锁是执行权的唯一判据，无论成败必须归还，否则该任务永远
    // 无法被再次拾起（下次轮询/重试直接抢占失败）。
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 找到下一个可执行任务（queued；running/其他跳过）。 */
function nextQueuedTask(skipIds = new Set()) {
  // 原 `listTasks(50)` 按 id 倒序取最近 50 条，若它们全是 done/failed/running，
  // 更早的 queued 会被永久饿死且不报任何错——任务目录长期运行必然累积出
  // 这种局面。改为 readdir 全量扫描：只解析 .json（写任务时的临时文件
  // *.tmp 天然被过滤），不再受「最近 50 条」窗口限制。
  // 注意：本修的目标是「不饿死旧 queued」，**不是**省 IO——readTask 仍会对
  // 每个 *.json 逐个 JSON.parse（相对 listTasks 解析量持平，且多一次
  // existsSync）；任务目录只增不减，空闲轮询每秒全量扫一遍属预期成本
  // （守护空闲自动退出，常驻窗口有限）。
  // skipIds：本轮已尝试且不可抢占（锁被他人持有等）的任务 id——队头抢锁
  // 失败不再挡住它后面的任务（见 serveLoop 调用处）。
  let files;
  try {
    files = readdirSync(TASKS_ROOT);
  } catch {
    return null; // 任务目录不存在：无任务可拾。
  }
  const queued = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (skipIds.has(id)) continue;
    const t = readTask(id);
    if (t?.status === 'queued') queued.push(t);
  }
  // 执行序 FIFO 正序（任务 id 时间戳开头，正序 = 入队序，最旧先执行）——
  // 原倒序「先执行最新的」会让持续有新任务时旧任务无限饿死，与「不饿死旧
  // queued」的设计目标相悖。展示侧列表仍按 id 倒序不受影响（那是 UI 习惯），
  // 执行序独立为先进先出。
  queued.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return queued[0] ?? null;
}

/** 守护主循环：轮询任务目录，串行执行，空闲自动退出。 */
async function serveLoop() {
  // bootAt 在 claimServe **之前**取值——抢到单例
  // 前的停机请求（spawn 后到 claimServe 返回之间写入的 --stop）mtime 晚于
  // 启动时刻，不会被误当陈旧哨兵删除（取值拖后 = 用户停机被静默吞掉，
  // 而 --stop 已提示成功）。判据收敛为「文件晚于本进程启动」的严格语义。
  const bootAt = Date.now();
  claimServe();
  // 清理陈旧哨兵（.stop 只对上一个实例有意义——上次 --stop
  // 后若未清理（旧版/异常退出），新守护循环第一轮就会命中哨兵立刻退出，任务
  // 永远停在 queued（「停一次 = 永久停」）。启动即删，哨兵语义回到
  // 「本轮停机请求」；退出时的删除在 shutdownServe 统一处理。
  // 只在哨兵**早于本实例启动**时删——并发场景下
  // 「别的实例刚写好、正要退」的停机请求（mtime 晚于启动时刻）必须保留，
  // 无条件删会把别人的停心声吞掉。
  try {
    if (statSync(STOP_FILE).mtimeMs < bootAt) rmSync(STOP_FILE, { force: true });
  } catch {
    /* 哨兵不存在/不可读：无需清理 */
  }
  process.stderr.write(`[serve] 就绪：${TASKS_ROOT}（单例 pid=${process.pid}，空闲 ${Math.round(IDLE_EXIT_MS / 60000)} 分钟自动退出）\n`);
  let lastActivity = Date.now();
  let stopRequested = false;
  // 本轮不可抢占的任务 id 集合：队头锁被他人持有时，跳过它继续尝试后续
  // queued（否则队头永远抢不到锁，它后面的任务全被堵死）；全部 queued 都
  // 被跳过时清空集合、等下一拍重试队头（见下方空任务分支）。
  const skipIds = new Set();

  while (!stopRequested) {
    // 哨兵停：外部写 .stop 文件即可优雅关闭（不强制，轮询兜底）。
    if (existsSync(STOP_FILE)) {
      stopRequested = true;
      break;
    }
    const task = nextQueuedTask(skipIds);
    if (task) {
      const done = await runTaskOnce(task.id);
      process.stderr.write(`[serve] 任务 ${task.id} → ${done?.status ?? '(无)'}\n`);
      // runTaskOnce 抢占失败（锁被他人持有/IO 错）时返回的任务仍是 queued——
      // 若无条件刷新 lastActivity + 无限重复挑同一任务，锁长期被持有时会
      // 无限热循环：CPU 打满、空闲回收永不触发。语义：真执行过（status 已
      // 流转到终态）才计活动；未执行则把该 id 加进 skipIds，本轮不再挑它
      // （下一轮循环接着尝试后面的任务）。
      // 取舍：队列里所有任务都不可抢占（比如另一个 serve 实例正在逐个
      // 执行）时，本实例每轮把排队任务全部试一遍后清空集合休眠 1s 再试——
      // 不空转 CPU，也不退出（优先保证队列最终被消费，不为省常驻而放弃
      // 可执行队列）。
      if (done && (done.status === 'done' || done.status === 'failed')) {
        lastActivity = Date.now();
        skipIds.clear(); // 有任务真正消费完，队列状态已更新，跳过集作废重来
      } else {
        skipIds.add(task.id);
      }
      continue;
    }
    if (skipIds.size > 0) {
      // 全部 queued 都在跳过集：清空后等下一拍重试队头——不清空的话
      // nextQueuedTask 永远返回 null，会误走下面的「队列空 → 空闲回收」，
      // 把锁被他人持有（但未耗尽空闲预算）的队列当无任务退出守护。
      skipIds.clear();
      await sleep(1000);
      continue;
    }
    // 空闲回收：队列空且超过 IDLE_EXIT_MS 无活动 → 退出（按需加载）。
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      process.stderr.write('[serve] 空闲超时，自动退出。\n');
      stopRequested = true;
      break;
    }
    await sleep(1000);
  }
  shutdownServe();
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CLI 入口 ── */
const [, , flag, arg] = process.argv;
if (flag === '--run' && arg) {
  // 单任务模式：执行后退出（手动投递/调试；不写 pid、不动守护生命周期）。
  ensureDirs();
  runTaskOnce(arg)
    .then((task) => {
      if (task?.result?.text) {
        process.stdout.write(`${task.result.text}\n`);
        process.exit(task.result.ok ? 0 : 1);
      }
      process.exit(2);
    })
    .catch((error) => {
      process.stderr.write(`[serve] --run 失败：${String(error?.message ?? error)}\n`);
      process.exit(2);
    });
} else if (flag === '--stop') {
  // 请求守护退出（向哨兵文件写时间戳；守护下一轮轮询看到即退出）。
  ensureDirs();
  writeFileSync(STOP_FILE, new Date().toISOString(), 'utf8');
  process.stdout.write('[serve] 已请求退出（哨兵已写）。\n');
} else {
  serveLoop().catch((error) => {
    process.stderr.write(`[serve] 守护异常退出：${String(error?.message ?? error)}\n`);
    shutdownServe();
    process.exit(1);
  });
}
