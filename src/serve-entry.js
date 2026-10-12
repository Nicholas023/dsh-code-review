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
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { executeReview } from './review-exec.js';
import {
  REVIEW_HOME, TASKS_ROOT, PID_FILE, IDLE_EXIT_MS,
  ensureDirs, readTask, updateTask, listTasks, isServeAlive, cleanupServe,
} from './task-book.js';

/** 优雅停哨兵文件（--stop 写；守护每轮检查）。 */
const STOP_FILE = join(REVIEW_HOME, '.stop');

/* ── 进程身份：单例守护只允许一个活实例 ── */
function claimServe() {
  if (isServeAlive()) {
    process.stderr.write('[serve] 已有 serve 实例在跑（复用单例），本进程退出。\n');
    process.exit(0);
  }
  ensureDirs();
  // 以【任务文件方式】改写 pid：写临时再 rename，防止与探活竞态读到半截。
  writeFileSync(`${PID_FILE}.tmp`, String(process.pid), 'utf8');
  rmSync(`${PID_FILE}.tmp`);
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

/** 结果全文组装（会话内呈现：header + 引擎输出 + tail）。 */
function buildResultText(task, exec) {
  const header = exec.ok
    ? `## 代码审查完成（${exec.elapsedSec}s）\n\n以下为引擎 codecheck 的评审结果：`
    : `## 代码审查失败（${exec.elapsedSec}s，退出码 ${exec.code}）\n\n引擎报错：`;
  const tail = [
    '',
    '---',
    exec.ok
      ? `报告已留档：${exec.reportPath ?? '（落盘失败）'}`
      : `（本次失败未产生有效报告${exec.reportPath ? `，但已留档记录：${exec.reportPath}` : ''}）`,
    exec.modelNote ? `> ${exec.modelNote}` : null,
    exec.sensitiveBlock || null,
  ]
    .filter(Boolean)
    .join('\n');
  const bodyText = exec.ok || exec.stdout.trim()
    ? exec.stdout.trim() || '(引擎无输出)'
    : exec.stderr.trim();
  return `${header}\n\n${bodyText}\n${tail}`;
}

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
  const running = updateTask(taskId, { status: 'running', startedAt: new Date().toISOString() });
  try {
    const exec = await executeReview(task);
    const text = buildResultText(task, exec);
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
    return done ?? running;
  } catch (error) {
    const errText = String(error?.stack ?? error?.message ?? error);
    process.stderr.write(`[serve] 任务执行异常：${errText}\n`);
    return updateTask(taskId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      result: { ok: false, code: null, elapsedSec: null, timedOut: false, reportPath: null, modelNote: '', text: `执行异常：${errText}` },
    }) ?? running;
  }
}

/** 找到下一个可执行任务（queued；running/其他跳过）。 */
function nextQueuedTask() {
  return listTasks(50).find((t) => t?.status === 'queued') ?? null;
}

/** 守护主循环：轮询任务目录，串行执行，空闲自动退出。 */
async function serveLoop() {
  claimServe();
  process.stderr.write(`[serve] 就绪：${TASKS_ROOT}（单例 pid=${process.pid}，空闲 ${Math.round(IDLE_EXIT_MS / 60000)} 分钟自动退出）\n`);
  let lastActivity = Date.now();
  let stopRequested = false;

  while (!stopRequested) {
    // 哨兵停：外部写 .stop 文件即可优雅关闭（不强制，轮询兜底）。
    if (existsSync(STOP_FILE)) {
      stopRequested = true;
      break;
    }
    const task = nextQueuedTask();
    if (task) {
      lastActivity = Date.now();
      process.stderr.write(`[serve] 拾起任务 ${task.id}（${task.command} ${task.repoPath ?? ''}）\n`);
      const done = await runTaskOnce(task.id);
      process.stderr.write(`[serve] 任务 ${task.id} → ${done?.status ?? '(无)'}\n`);
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
  cleanupServe();
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
    cleanupServe();
    process.exit(1);
  });
}
