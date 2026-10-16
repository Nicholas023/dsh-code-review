/**
 * src/task-api.js —— 后台评审任务的宿主可见面（「GUI 可见」落地之一）。
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

/** 配置写接口的请求体上限（设置面板只发两个小字段，4KB 足够；64KB 兜底）。
 *  导出供 task-api-smoke 断言引用（烟雾测试
 *  与产品实现共用同一常量的值，杜绝「测试里写死 64KB、实现改了忘记同步」。 */
export const CONFIG_BODY_LIMIT = 64 * 1024;

/** SSE 并发连接上限：每个连接独立每 1s 对任务目录做一次指纹扫描，
 *  不限速会让 N 个连接把目录扫描开销线性放大（DoS 面）；超过上限直接拒连。
 *  导出供 task-api-smoke 断言引用（口径同上）。 */
export const SSE_MAX_CONNECTIONS = 10;
let sseActiveConnections = 0;

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
 * 旧实现存在两个缺陷 ——
 * ① 超限分支只调 req.destroy()：被销毁的 req 通常只发 'close'/'aborted' 而不发
 *    'end'，Promise 既不 resolve 也不 reject（handler 永远不返回 413，连接与
 *    Promise 一起泄漏）；② body.length 是 UTF-16 字符数而非字节数，含多字节
 *    字符的请求体可绕过 64KB 字节上限；且逐 chunk 字符串拼接会把跨 chunk
 *    边界的多字节字符切坏。
 * 按 Buffer 累计真实字节数；统一走 done() 唯一 settle 出口（正常 end /
 * 超限 / 客户端断开 close / 网络错误 error 全都只 settle 一次），保证调用方
 * 永不挂死。
 * 超限分支**不再调 req.destroy()**（destroy 拆掉底层 socket，
 * 调用方下一微任务写回的 413 到不了客户端）——done(null) 即停收，未读完的
 * 请求体由 node 在响应 flush 完成后自行收尾（destroySoon / 内核反压）。
 *
 * @param {object} req IncomingMessage。
 * @param {number} [limit] 字节上限；超过返回 null（调用方回 413）。
 * @returns {Promise<string|null>} 请求体文本；超限/报错为 null。
 */
function readBody(req, limit = CONFIG_BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    /** 唯一 settle 出口：任意结束路径只 resolve 一次，杜绝重复/悬挂。 */
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      // chunk 是 Buffer：按字节累计（不再用字符串 length，UTF-16 计数漏洞已封）。
      size += chunk.length;
      if (size > limit) {
        // **不**再调 req.destroy()——destroy 拆掉的是底层
        // socket（Node 文档：message.destroy() 即 socket.destroy()），而路由是
        // 在下一个微任务里才写 413（readBody().then(...)），此时连接已断，413
        // 永远到不了客户端（只看到连接重置）。done(null) 停止收集并 settle；
        // req.pause() 停止从内核缓冲继续拉数据（省 CPU/内存），但不拆 socket，
        // 保证随后的 413 仍能送达；未读完的请求体由 node 在响应 flush 后自行
        // 收尾（destroySoon）。
        done(null);
        req.pause();
        return;
      }
      // 只收合法数据；超限分支已 return，到这里的数据一律入缓冲。
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('close', () => done(null)); // 客户端中断也要 settle，避免悬挂
    req.on('error', () => done(null)); // 网络错误与超限同形（统一判空回 4xx）
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
      // 鉴权假设（本路由挂在宿主 webServer 名下，
      // 宿主对该路径强制同源认证（客户端 fetch 相对路径走宿主认证通道），故插件层
      // 不再重复校验身份；此处只做「连接数上限」兜底——SSE 是长连接，每个连接
      // 每 1s 对任务目录做一次 statSync 指纹扫描（tasksFingerprint），不限速会被
      // 恶意页面/多标签页并发放大为目录扫描 DoS。
      if (sseActiveConnections >= SSE_MAX_CONNECTIONS) {
        json(res, 503, { error: 'too-many-sse-connections', limit: SSE_MAX_CONNECTIONS });
        return;
      }
      sseActiveConnections += 1;
      // 名额自增之后、close 处理器注册之前任一同步步骤抛错
      // （writeHead / tasksFingerprint / listTasks 异常），名额将永不归还——
      // 反复触发会把连接数钉死在上限形成 503 黑洞。包一层 try：异常路径归还
      // 名额、清定时器，并尽力回 500（响应头未发出时），发不出则直接拆连接。
      let timer = null;
      // 名额是否已在异常路径归还：close 处理器与 catch 都可能递减，用标志位
      // 保证**只递减一次**（否则「初始化异常 + 随后连接关闭」会双重递减，
      // 计数被永久低估，上限校验形同虚设）。
      let slotReturned = false;
      try {
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
        timer = setInterval(() => {
          const fp = tasksFingerprint();
          if (fp !== last) {
            last = fp;
            writeFrame({ revision: fp, tasks: summarize(listTasks(LIST_LIMIT)) });
          }
        }, 1000);
        // 断开即释放连接名额（多标签页反复开关页面时防止计数泄漏到上限）：
        // 同时保证 clearInterval 一定执行（stopPushPoller 同款清理）。
        req.on('close', () => {
          clearInterval(timer);
          // 异常路径已归还名额时不重复递减（见 slotReturned 声明处说明）。
          if (!slotReturned && sseActiveConnections > 0) sseActiveConnections -= 1;
        });
      } catch (error) {
        // 初始化异常：归还名额 + 清定时器，防名额泄漏到上限；然后尽力回 500。
        slotReturned = true;
        if (sseActiveConnections > 0) sseActiveConnections -= 1;
        try {
          if (timer) clearInterval(timer);
        } catch { /* 忽略 */ }
        try {
          json(res, 500, { error: 'sse-init-failed', detail: String(error?.message ?? error) });
        } catch {
          // 响应头已发出等无法再写响应的情况：直接拆连接。
          try {
            res.destroy();
          } catch { /* 忽略 */ }
        }
      }
    },
  });
  // 配置写路由（设置面板的「并发评审」开关/并发广度经此写入
  // 插件自有配置文件（plugin-config.json，运行真源）——0.2.0 宿主面板保存对第三方
  // 插件不回传运行层（定案），并发设置必须在保存时同步落运行真源，
  // 下一次评审 getConfig 热读取立即生效。
  // 安全防线（
  //   ① 鉴权假设：路由挂宿主 webServer 名下，受宿主同源认证保护（客户端相对路径
  //      fetch 走宿主认证通道）。createTaskRoutes 拿不到宿主 ctx/身份（index.js 调用
  //      处未注入），插件层无权也不做二次身份校验；
  //   ② 请求体上限：readBody 按 Buffer 字节累计（CONFIG_BODY_LIMIT = 64KB），
  //      超限回 413，杜绝多字节字符绕过与超量解析；
  //   ③ 白名单：writeFileConfig 只收白名单键 + 类型校验 + 原子落盘，未知键被忽略。
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
  // 头部摘要：按「成功 > 超时 > 失败」优先级取一（if/else 取代嵌套三元，项目规约）。
  let head;
  if (r.ok) head = `✅ 代码审查任务完成（${task.id}）`;
  else if (r.timedOut) head = `⏱ 代码审查任务超时（${task.id}）`;
  else head = `❌ 代码审查任务失败（${task.id}）`;
  const lines = [
    head,
    '',
    `- 仓库: ${task.repoPath ?? '(未指定)'}`,
    // elapsedSec 可能带长尾精度（引擎执行秒数非
    // 整数）——原样拼会输出整段小数（19.384756283）；toFixed(1) 展示，与
    // index.js buildSyncResultText / serve-entry buildResultText 同口径。
    r.ok ? `- 耗时: ${Number(r.elapsedSec ?? 0).toFixed(1)}s` : `- 退出码: ${r.code ?? '—'}`,
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
      // channel 字段一律取 sender 的（入参 channel 已归一进 sender，读 sender.channel
      // 避免与 channel?.channel 两套取法并存导致记录不一致）。
      record = { at: new Date().toISOString(), ok: false, channel: sender.channel ?? 'none', error: 'no-requestor' };
    } else {
      try {
        const ok = await sender.prompt(sessionId, completionText(task));
        record = { at: new Date().toISOString(), ok, channel: sender.channel, error: ok ? '' : 'prompt-rejected' };
      } catch (error) {
        record = { at: new Date().toISOString(), ok: false, channel: sender.channel, error: String(error?.message ?? error) };
      }
    }
    // updateTask 内部是「读-改-写」原子替换：任务文件被并发清理/删除时返回 null。
    // 不再提前 readTask 预读（少一次 IO，也缩短「读-判断-写」窗口）；
    // pushed 按 updateTask 实际返回值计数——真正写回成功才算推进，杜绝
    // 「任务已被清理仍虚报推送条数」的语义失真。
    const updated = updateTask(task.id, { push: record });
    if (updated) pushed += 1;
  }
  return pushed;
}

/** 起完成推送协程（apply 调用）；返回停止函数。tickMs 缺省 5 秒。 */
export function startPushPoller(ctx, { tickMs = 5000 } = {}) {
  // 重入保护（pushCompletedTask 是异步的，若上一轮
  // 未结束（慢会话通道/网络）而 interval 又触发，会重叠执行——同一批任务可能被
  // 并发推送两次（task.push 标记是「读-改-写」，并发下两边可能同时读到未标记）。
  // 用 running 标志保证任意时刻至多一个协程在跑，漏掉的轮次下一轮自然补上。
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    pushCompletedTask(ctx)
      .catch((error) => {
        // 与 interval 同一条日志通道：首次补推失败也留痕，不再静默吞掉（原实现
        // 首次补推 .catch(() => {}) 无日志，出错时难以排查）。
        ctx.logger?.warn?.(`[dsh-code-review] 完成推送轮询出错：${String(error?.message ?? error)}`);
      })
      .finally(() => {
        running = false; // 无论成败都释放标志，保证下一轮 tick 能正常发起
      })
      .catch(() => {
        // 终端兜底——上面 catch 回调里的 logger.warn 与
        // String 若自身抛错（logger 实现异常/字符串化失败），.finally 之后的
        // 拒绝会继续往链尾传，而这条 fire-and-forget 链无人接收 → 未处理拒绝
        // （Node 15+ 默认直接终止进程，等于把插件守护拖挂）。此空 catch 保证
        // 任何情况链尾都闭合。
      });
  };
  const timer = setInterval(tick, tickMs);
  // 启动后首次立即跑一次（把积压任务补推）。
  tick();
  return () => clearInterval(timer);
}

/* 供单元自检直接引用（不经过宿主）： */
export { tasksListPayload, taskDetailPayload };
