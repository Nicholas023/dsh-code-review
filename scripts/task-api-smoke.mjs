/**
 * scripts/task-api-smoke.mjs —— 任务 API 与完成推送冒烟自检（「GUI 可见」之二）。
 *
 * 验证宿主可见面三件事（全部在隔离 DSH_REVIEW_HOME 下跑，碰不到生产任务簿）：
 *   1. 完成推送：sessionController 通道优先 / apiProxy 兜底 / 都没有则 null；
 *      任务 done|failed 且未推送过 → 推给发起会话（requestor.sessionId）+ push 标记落盘；
 *      推过的不再推（防刷屏）；无 requestor → 不推但标 no-requestor（防反复试探）。
 *   2. 数据路由：createTaskRoutes 形状（tasks 精确 + tasks/:id 前缀 + events 精确），
 *      GET /api/code-review/tasks 返回 { revision, tasks[] }（列表摘要无 result.text）。
 *   3. completionText：完成/失败/超时三种头的文案形状。
 *
 * 运行：node scripts/task-api-smoke.mjs（package.json check 脚本已收录）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/* ═══ 隔离必须最先做：模块加载前锁定 REVIEW_HOME ═══
 * task-book.js 的 TASKS_ROOT 在**模块求值时**按 DSH_REVIEW_HOME 解析一次，
 * 之后不再重读环境变量。若本文件里任何 task-book 的（直接或间接）求值跑在
 * 这行之前，TASKS_ROOT 会落到用户真实任务簿（~/.dsh 默认目录）——冒烟里的
 * 入队/状态流转/推送标记会把生产任务簿写脏。ESM 静态导入有提升、不按源码
 * 行序求值，因此**被测模块一律走下方动态 import**，env 锁定放在所有动态
 * import 之前；node:* 内置模块无此风险（不碰 REVIEW_HOME）。
 */
const home = mkdtempSync(join(tmpdir(), 'dcr-taskapi-smoke-'));
process.env.DSH_REVIEW_HOME = join(home, 'review');

// 常量改**动态导入**——静态 import 在文件加载阶段就求值 task-api.js：其顶层
// 一旦抛错（依赖缺失/模块间循环），冒烟连自身的「加载前置检查」都跑不到就
// 崩；动态导入把模块加载挪进可控流程，失败走显式 check 退出（隔离前提：
// 测试自身不得隐式依赖被测模块可加载）。
let CONFIG_BODY_LIMIT = 0;
let SSE_MAX_CONNECTIONS = 0;
try {
  ({ CONFIG_BODY_LIMIT, SSE_MAX_CONNECTIONS } = await import('../src/task-api.js'));
} catch (error) {
  console.log(`✘ 无法加载 src/task-api.js（模块加载前置检查）—— ${String(error?.message ?? error)}`);
  process.exit(1);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

try {
  const tb = await import(new URL('../src/task-book.js', import.meta.url).href);
  const api = await import(new URL('../src/task-api.js', import.meta.url).href);

  /* ── 1. 入队（带 requestor）+ 置 done ── */
  const id = tb.enqueueTask({ repoPath: '/r', command: 'scan', requestor: { sessionId: 'sess-1' } });
  const t0 = tb.readTask(id);
  check('requestor 随任务落盘', t0.requestor?.sessionId === 'sess-1', JSON.stringify(t0.requestor));
  tb.updateTask(id, { status: 'done', result: { ok: true, elapsedSec: 7, modelNote: 'TEST-MODEL', reportPath: '/rep.md', text: '## 评审完成\n\n内容……' } });

  /* ── 2. 通道探测择优 ── */
  const callLog = [];
  const ctxSC = {
    get: (n) =>
      n === 'sessionController'
        ? { prompt: async (p) => { callLog.push(['sc', p.sessionId]); return { accepted: true }; } }
        : undefined,
  };
  check('sessionController 通道探测成功', api.probeSessionChannel(ctxSC)?.channel === 'sessionController');
  const ctxProxy = {
    get: (n) =>
      n === 'apiProxy'
        ? { sessions: { prompt: async () => ({ result: { ok: true, value: { accepted: true } } }) } }
        : undefined,
  };
  check('apiProxy 通道探测成功（兜底）', api.probeSessionChannel(ctxProxy)?.channel === 'apiproxy');
  check('双通道都无 → null（推送跳过）', api.probeSessionChannel({ get: () => undefined }) === null);

  /* ── 3. 推送一次 + 标记落盘 + 防重推 ── */
  const n1 = await api.pushCompletedTask(ctxSC);
  check('完成任务被推送给发起会话（1 条）', n1 === 1 && callLog[0]?.[0] === 'sc' && callLog[0]?.[1] === 'sess-1', JSON.stringify(callLog));
  const t1 = tb.readTask(id);
  check('push 标记落盘（ok/channel）', t1.push?.ok === true && t1.push?.channel === 'sessionController', JSON.stringify(t1.push));
  const n2 = await api.pushCompletedTask(ctxSC);
  check('已推送任务不重复推（防刷屏）', n2 === 0, `n2=${n2}`);

  /* ── 4. 无 requestor → 不推但标 no-requestor ── */
  const id2 = tb.enqueueTask({ repoPath: '/r2' });
  tb.updateTask(id2, { status: 'failed', result: { ok: false, code: 1, text: 'boom' } });
  const callsBefore = callLog.length;
  // 返回值不再捕获（原 `const n3 =` 是死变量）——id2 从来
  // 不是推送对象，返回值计数与它的标记无关，只有 callLog 与 push 标记能证明
  // 「没推 + 标了」两个语义同时成立。
  await api.pushCompletedTask(ctxSC);
  // 断言从「n3 === 1」改为「推送调用零新增 + id2 标
  // no-requestor」——原写法漏检两个真失败：把「没 requestor 的任务当成有
  // requestor 推出去」（callLog 计数对不上）与「成功但没标 no-requestor」；
  // id2 从来不是推送对象，n3 计数与它的标记无关，只有 callLog 与 push 标记
  // 能证明「没推 + 标了」两个语义同时成立。
  check('无发起会话的任务不推送（callLog 零新增）', callLog.length === callsBefore, `calls=${JSON.stringify(callLog)}`);
  check('无发起会话的任务标 no-requestor（防反复试探）', tb.readTask(id2).push?.error === 'no-requestor', JSON.stringify(tb.readTask(id2).push));

  /* ── 5. completionText 三形态 ── */
  const okTxt = api.completionText(tb.readTask(id));
  check('完成文本含 ✅ 标题与报告路径', okTxt.includes('✅ 代码审查任务完成') && okTxt.includes('/rep.md') && okTxt.includes('code_review_status'));
  const oldId = tb.enqueueTask({ repoPath: '/r3' });
  tb.updateTask(oldId, { status: 'failed', result: { ok: false, code: 7, timedOut: true } });
  const toTxt = api.completionText(tb.readTask(oldId));
  check('超时文本含 ⏱ 标题', toTxt.includes('⏱ 代码审查任务超时'));
  const failId = tb.enqueueTask({ repoPath: '/r4' });
  tb.updateTask(failId, { status: 'failed', result: { ok: false, code: 2 } });
  const failTxt = api.completionText(tb.readTask(failId));
  check('失败文本含 ❌ 标题与退出码', failTxt.includes('❌ 代码审查任务失败') && failTxt.includes('2'));

  /* ── 6. 路由形状 + GET /tasks 实际响应 ── */
  const routes = api.createTaskRoutes();
  const exactPaths = routes.filter((r) => r.kind === 'exact').map((r) => r.path);
  check('路由数组 4 条（3 精确 + 1 前缀）', routes.length === 4, JSON.stringify(routes.map((r) => r.path)));
  check('精确路由含 /tasks、/events 与 /config', exactPaths.includes('/api/code-review/tasks') && exactPaths.includes('/api/code-review/events') && exactPaths.includes('/api/code-review/config'));
  check('前缀路由 /api/code-review/tasks/', routes.some((r) => r.kind === 'prefix' && r.path === '/api/code-review/tasks/'));
  const tasksRoute = routes.find((r) => r.path === '/api/code-review/tasks');
  let statusCode = 0;
  let body = '';
  const res = { writeHead: (c) => { statusCode = c; }, end: (s) => { body = s; } };
  await tasksRoute.handler({ method: 'GET', url: '/api/code-review/tasks' }, res);
  const parsed = JSON.parse(body);
  check('GET /tasks 200 + JSON', statusCode === 200 && Array.isArray(parsed.tasks), `http=${statusCode}`);
  // 契约 = 按 id 字典序降序（id 以创建时间戳开头）；同一秒内的任务时间戳前缀相同，
  // 不能断言「最后创建的一定排第一」，只能断言排序性质本身。
  const ids = parsed.tasks.map((t) => t.id);
  const sortedIds = [...ids].sort().reverse();
  check('列表按 id 降序且含最新任务', ids.join() === sortedIds.join() && ids.includes(failId), ids.join(','));
  check('列表摘要不含 result.text 大字段', parsed.tasks.every((t) => !('resultText' in t)));

  /* ── 7. 单任务详情路由（prefix）─ ── */
  const prefixRoute = routes.find((r) => r.path === '/api/code-review/tasks/');
  let dBody = '';
  const dRes = { writeHead: (c) => { statusCode = c; }, end: (s) => { dBody = s; } };
  await prefixRoute.handler({ method: 'GET', url: `/api/code-review/tasks/${id}` }, dRes);
  const detail = JSON.parse(dBody);
  check('GET /tasks/:id 返回详情（found + resultText）', detail.found === true && typeof detail.task.resultText === 'string' && detail.task.resultText.length > 0, `found=${detail.found}`);

  /* ── 8. 指纹稳定性 ── */
  const fp1 = api.tasksFingerprint();
  const fp2 = api.tasksFingerprint();
  check('任务簿指纹稳定（未变化时相同）', fp1 === fp2 && fp1 !== '0', fp1);

  /* ── 9. 极限护栏（读体上限 + SSE 连接数上限与归还 ── */
  const configRoute = routes.find((r) => r.path === '/api/code-review/config');
  // ① POST /config 超 64KB 字节上限 → 413（readBody 按 Buffer 字节累计）。
  let cfgStatus = 0;
  const bigReq = new EventEmitter();
  bigReq.method = 'POST';
  // 假 req 补齐流控制 API：真实 IncomingMessage 必有 pause()，readBody 在
  // 超限分支会调用它停止拉取剩余数据（不拆 socket 以保证 413 可达）。
  bigReq.pause = () => {};
  // handler 对 readBody(req).then(...) 是 fire-and-forget
  // （语句不返回 promise）——`await handler(...)` 只是 await undefined 的假同步，
  // 413/200 断言此前靠 Node 微任务 drain 的时序巧合通过。改：emit data/end 后
  // await 宏任务闸（setImmediate），等 readBody 事件链真正落定再断言。
  configRoute.handler(bigReq, { writeHead: (c) => { cfgStatus = c; }, end: () => {} });
  bigReq.emit('data', Buffer.alloc(CONFIG_BODY_LIMIT + 8, 0x61));
  bigReq.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  check('POST /config 超 64KB → 413', cfgStatus === 413, `http=${cfgStatus}`);
  // ①b 小 body → 200（护栏不误伤正常写入；写入的是白名单值，隔离 HOME 不受累）。
  const smallReq = new EventEmitter();
  smallReq.method = 'POST';
  configRoute.handler(smallReq, { writeHead: (c) => { cfgStatus = c; }, end: () => {} });
  smallReq.emit('data', Buffer.from('{"review_model":"session"}'));
  smallReq.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  check('POST /config 小 body → 200', cfgStatus === 200, `http=${cfgStatus}`);
  // ② SSE 连接数上限：挂满 SSE_MAX_CONNECTIONS 个 → 超限的第 N+1 个 503；
  // 关一个后恢复（连接数常量从 src/task-api.js 导入，测试与实现同一真源）。
  // 每个「连接」= 假 req（EventEmitter，手动触发 close）+ 假 res（writeHead/write
  // no-op）。handler 内部开 setInterval 指纹轮询，测试末尾逐一 emit('close') 让
  // close 处理器清定时器并归还名额（不留活句柄、不泄漏计数）。
  const eventsRoute = routes.find((r) => r.path === '/api/code-review/events');
  const sseCodes = [];
  const openSse = [];
  for (let i = 0; i < SSE_MAX_CONNECTIONS; i += 1) { // 常量与实现同源（导入）
    const req = new EventEmitter();
    req.method = 'GET';
    const st = { code: 0 };
    const res = {
      writeHead: (c) => { st.code = c; },
      write: () => {},
      end: () => {},
      destroy: () => {},
    };
    openSse.push(req);
    eventsRoute.handler(req, res);
    sseCodes.push(st);
  }
  check(`SSE 挂满 ${SSE_MAX_CONNECTIONS} 个连接全部 200（名额逐个占用）`,
    sseCodes.length === SSE_MAX_CONNECTIONS && sseCodes.every((s) => s.code === 200),
    sseCodes.map((s) => s.code).join(','));
  let overStatus = 0;
  const overReq = new EventEmitter();
  overReq.method = 'GET';
  eventsRoute.handler(overReq, { writeHead: (c) => { overStatus = c; }, write: () => {}, end: () => {}, destroy: () => {} });
  check(`超限的第 ${SSE_MAX_CONNECTIONS + 1} 个连接 → 503（连接数上限兜底）`, overStatus === 503, `http=${overStatus}`);
  openSse[0].emit('close'); // 关闭一个（触发 close 处理器：清定时器 + 归还名额）
  let afterStatus = 0;
  const againReq = new EventEmitter();
  againReq.method = 'GET';
  eventsRoute.handler(againReq, { writeHead: (c) => { afterStatus = c; }, write: () => {}, end: () => {}, destroy: () => {} });
  check('关闭一个连接后新连接恢复 200（名额归还）', afterStatus === 200, `http=${afterStatus}`);
  // 收尾循环**跳过 openSse[0]**——它在上面名额归还
  // 用例里已 close 过，而路由 close 处理器是 `on('close')`（非 once），对已关
  // 连接二次 emit('close') 会把 sseActiveConnections 再减一次——那是「误扣
  // 存活连接名额」（计数小于真实存活数，后续合规连接被误 503），且把已清过
  // 的 interval 二次清理——测试自身就成了「非幂等插槽结算」的演示，而不是
  // 证明。slice(1) 后每个连接恰好 close 一次。
  for (const req of openSse.slice(1)) req.emit('close'); // 收尾清理（openSse[0] 已在上面关闭）
  // 无条件清理：503 分支未注册 close 处理器（名额满时提前 return），
  // emit 无监听器即无副作用；若实现在 503 分支也装了 interval（潜在缺陷），
  // 这里能把它一并清掉，避免测试进程被悬挂 timer 拖着不退出。
  overReq.emit('close');
  againReq.emit('close');
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\ntask-api 冒烟${failures ? `完成，${failures} 项失败` : '全部通过'}。`);
process.exit(failures ? 1 : 0);
