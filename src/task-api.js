/**
 * src/task-api.js —— 后台评审任务的宿主可见面（2026-10-13「GUI 可见」落地之一）。
 *
 * 提供三件事，全部挂在宿主原生能力上（不依赖任何第三方插件）：
 *   1. **完成推送**：轮询任务簿，发现新 done/failed 且未推送过的任务 →
 *      通过宿主会话通道（ctx.sessionController 优先 / ctx.apiProxy 兜底）给
 *      发起会话推一条结果摘要（信息进 GUI 消息流，任务做完不用自己查）。
 *   2. **任务数据路由**（ctx.webServer，宿主认证 fetch 通道，client 同源可读）：
 *      - GET /api/code-review/tasks        最近任务摘要列表（客户端轮询用）；
 *      - GET /api/code-review/tasks/<id>   单任务详情（含结果全文/报告路径）；
 *      - GET /api/code-review/events       SSE 流（任务簿变化即推送，GUI 实时刷）。
 *   3. **指纹修订号**：客户端据此知道「任务簿变了没」，避免无效重渲染。
 *
 * 零敏感：路由只回任务元数据与评审结果文本，不回 key、不读引擎配置之外的任何文件。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_ROOT, listTasks, readTask, updateTask } from './task-book.js';
import { writeFileConfig } from './file-config.js';

const LIST_LIMIT = 20;

/** 配置写接口的请求体上限（设置面板只发两个小字段，4KB 足够；64KB 兜底）。 */
const CONFIG_BODY_LIMIT = 64 * 1024;

/** node:http 风格 JSON 响应。 */
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * 读取请求体（宿主 webServer 透传 node http IncomingMessage，需自行收集）。
 *
 * @param {object} req IncomingMessage。
 * @param {number} [limit] 字节上限；超过返回 null（调用方回 413）。
 * @returns {Promise<string|null>} 请求体文本；超限/报错为 null。
 */
function readBody(req, limit = CONFIG_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        tooBig = true;
        try {
          req.destroy();
        } catch { /* 忽略 */ }
      }
    });
    req.on('end', () => resolve(tooBig ? null : body));
    req.on('error', reject);
  });
}

/** 任务簿指纹：tasks 目录内所有 <id>.json 的 文件名 + mtime + 大小 拼接。
 *  场景只有一个服务写任务文件（serve），插件侧读；以 mtime 变化为「变了」。 */
export function tasksFingerprint() {
  let entries;
  try {
    entries = readdirSync(TASKS_ROOT);
  } catch {
    return '0';
  }
  const parts = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = statSync(join(TASKS_ROOT, name));
      parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* 文件正被原子替换（tmp+rename）的瞬间 → 跳过，下一轮指纹就稳定 */
    }
  }
  return String(parts.length) + '|' + parts.sort().join(',');
}

/** 列表摘要：去掉 result.text 大字段（客户端列表不需要全文）。 */
function summarize(tasks) {
  return tasks.map((t) => ({
    id: t.id,
    status: t.status,
    command: t.command,
    repoPath: t.repoPath ?? '',
    focus: t.focus ?? '',
    excludePaths: t.excludePaths ?? [],
    createdAt: t.createdAt ?? '',
    startedAt: t.startedAt ?? '',
    finishedAt: t.finishedAt ?? '',
    elapsedSec: t.result?.elapsedSec ?? null,
    modelNote: t.result?.modelNote ?? '',
    reportPath: t.result?.reportPath ?? '',
    ok: t.result?.ok ?? null,
  }));
}

/** 状态查询（与 statusPayload 同文信息，路由 JSON 形态）。 */
function tasksListPayload() {
  const tasks = summarize(listTasks(LIST_LIMIT));
  return { revision: tasksFingerprint(), tasks };
}

/** 单任务详情（含 result.text 全文，供 GUI 展示/复制）。 */
function taskDetailPayload(id) {
  const task = readTask(id);
  if (!task) return { revision: tasksFingerprint(), found: false, task: null };
  return {
    revision: tasksFingerprint(),
    found: true,
    task: {
      ...summarize([task])[0],
      resultText: task.result?.text ?? '',
      resultCode: task.result?.code ?? null,
      timedOut: task.result?.timedOut ?? false,
      requestor: task.requestor ?? null,
    },
  };
}

/** 新建 webServer 路由数组（宿主 ctx.webServer.register 消费，每一项返回 disposer）。 */
export function createTaskRoutes() {
  const routes = [];
  routes.push({
    kind: 'exact',
    path: '/api/code-review/tasks',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' });
      json(res, 200, tasksListPayload());
    },
  });
  routes.push({
    kind: 'prefix',
    path: '/api/code-review/tasks/',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' });
      // req.url 形如 /api/code-review/tasks/<id>（无查询串时）。
      const rest = (req.url ?? '').split('?')[0].slice('/api/code-review/tasks/'.length);
      if (!/^[\w-]+$/.test(rest)) return json(res, 404, { error: 'not-found' });
      json(res, 200, taskDetailPayload(rest));
    },
  });
  routes.push({
    kind: 'exact',
    path: '/api/code-review/events',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const writeFrame = (payload) => {
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* socket 已关 */ }
      };
      let last = tasksFingerprint();
      writeFrame({ revision: last, tasks: summarize(listTasks(LIST_LIMIT)) });
      const timer = setInterval(() => {
        const fp = tasksFingerprint();
        if (fp !== last) {
          last = fp;
          writeFrame({ revision: fp, tasks: summarize(listTasks(LIST_LIMIT)) });
        }
      }, 1000);
      req.on('close', () => clearInterval(timer));
    },
  });
  // 配置写路由（2026-10-14 迭代）：设置面板的「并发评审」开关/并发广度经此写入
  // 插件自有配置文件（plugin-config.json，运行真源）——0.2.0 宿主面板保存对第三方
  // 插件不回传运行层（2026-10-13 实测定案），并发设置必须在保存时同步落运行真源，
  // 下一次评审 getConfig 热读取立即生效。
  // 只收白名单键（file-config sanitizePatch），值做类型校验；不发 key/不读引擎配置。
  routes.push({
    kind: 'exact',
    path: '/api/code-review/config',
    handler: (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' });
      readBody(req)
        .then((body) => {
          if (body === null) return json(res, 413, { error: 'payload-too-large' });
          let patch;
          try {
            patch = JSON.parse(body || '{}');
          } catch {
            return json(res, 400, { error: 'bad-json' });
          }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return json(res, 400, { error: 'bad-request' });
          }
          try {
            const next = writeFileConfig(patch); // 白名单 + 类型校验 + 原子落盘
            json(res, 200, { ok: true, active: next });
          } catch (error) {
            json(res, 500, { error: 'write-failed', detail: String(error?.message ?? error) });
          }
          return undefined;
        })
        .catch(() => json(res, 400, { error: 'bad-request' }));
    },
  });
  return routes;
}

/* ═══ 完成推送 ═══ */

/** 会话消息摘要文本（任务完成/失败时推给发起会话）。 */
export function completionText(task) {
  const r = task.result ?? {};
  const head = r.ok
    ? `✅ 代码审查任务完成（${task.id}）`
    : r.timedOut
      ? `⏱ 代码审查任务超时（${task.id}）`
      : `❌ 代码审查任务失败（${task.id}）`;
  const lines = [
    head,
    '',
    `- 仓库: ${task.repoPath ?? '(未指定)'}`,
    r.ok ? `- 耗时: ${r.elapsedSec}s` : `- 退出码: ${r.code ?? '—'}`,
    r.modelNote ? `- 模型: ${r.modelNote}` : null,
    r.ok && r.reportPath ? `- 报告: ${r.reportPath}` : null,
    '',
    r.ok ? '结果全文可用 code_review_status 查（task_id=' + task.id + '）。' : `失败原因见引擎 stderr（code_review_status task_id=${task.id}）。`,
  ].filter(Boolean).join('\n');
  return lines;
}

/** 探测宿主会话通道并构造投递函数（sessionController 优先 / apiProxy 兜底）。
 *  @returns {null | {channel: string, prompt: (sessionId, text) => Promise<boolean>}} */
export function probeSessionChannel(ctx) {
  const sc = typeof ctx.get === 'function' && ctx.get('sessionController');
  if (sc && typeof sc.prompt === 'function') {
    return {
      channel: 'sessionController',
      prompt: async (sessionId, text) => {
        const res = await sc.prompt(
          { sessionId, requestId: `code-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, mode: 'queue', content: [{ type: 'text', text }] },
          new AbortController().signal,
        );
        return res?.accepted === true;
      },
    };
  }
  const api = typeof ctx.get === 'function' && ctx.get('apiProxy');
  if (api && api.sessions && typeof api.sessions.prompt === 'function') {
    return {
      channel: 'apiproxy',
      prompt: async (sessionId, text) => {
        const r = await api.sessions.prompt({
          rpcId: `code-review-${Date.now()}`,
          payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        });
        return r?.result?.ok === true && r?.result?.value?.accepted === true;
      },
    };
  }
  return null;
}

/** 一次性推进：把「新完成/失败且未推送」的任务推给发起会话；返回本次推了几条。 */
export async function pushCompletedTask(ctx, { channel } = {}) {
  const sender = channel ?? probeSessionChannel(ctx);
  if (!sender) return 0;
  const tasks = listTasks(LIST_LIMIT);
  let pushed = 0;
  for (const task of tasks) {
    if (task.status !== 'done' && task.status !== 'failed') continue;
    if (task.push && task.push.at) continue; // 已推送过（防刷屏）
    const sessionId = task.requestor?.sessionId || '';
    let record;
    if (!sessionId) {
      // 无发起会话标识：不推送，只标记一次，避免每轮重复试探。
      record = { at: new Date().toISOString(), ok: false, channel: channel?.channel ?? 'none', error: 'no-requestor' };
    } else {
      try {
        const ok = await sender.prompt(sessionId, completionText(task));
        record = { at: new Date().toISOString(), ok, channel: sender.channel, error: ok ? '' : 'prompt-rejected' };
      } catch (error) {
        record = { at: new Date().toISOString(), ok: false, channel: sender.channel, error: String(error?.message ?? error) };
      }
    }
    const before = readTask(task.id);
    if (before) updateTask(task.id, { push: record });
    pushed += 1;
  }
  return pushed;
}

/** 起完成推送协程（apply 调用）；返回停止函数。tickMs 缺省 5 秒。 */
export function startPushPoller(ctx, { tickMs = 5000 } = {}) {
  const timer = setInterval(() => {
    pushCompletedTask(ctx).catch((error) => {
      ctx.logger?.warn?.(`[dsh-code-review] 完成推送轮询出错：${String(error?.message ?? error)}`);
    });
  }, tickMs);
  // 启动后首次立即跑一次（把积压任务补推）。
  pushCompletedTask(ctx).catch(() => {});
  return () => clearInterval(timer);
}

/* 供单元自检直接引用（不经过宿主）： */
export { tasksListPayload, taskDetailPayload };
