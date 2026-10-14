/**
 * scripts/task-api-smoke.mjs —— 任务 API 与完成推送冒烟自检（2026-10-13「GUI 可见」之二）。
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

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

/* 模块加载前锁定 REVIEW_HOME（task-book 的 TASKS_ROOT 在加载时解析一次）。 */
const home = mkdtempSync(join(tmpdir(), 'dcr-taskapi-smoke-'));
process.env.DSH_REVIEW_HOME = join(home, 'review');

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
  const n3 = await api.pushCompletedTask(ctxSC);
  check('无发起会话的任务不推送（标 no-requestor）', n3 === 1 && tb.readTask(id2).push?.error === 'no-requestor', JSON.stringify(tb.readTask(id2).push));

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
  check('路由数组 3 条（2 精确 + 1 前缀）', routes.length === 3, JSON.stringify(routes.map((r) => r.path)));
  check('精确路由含 /api/code-review/tasks 与 /events', exactPaths.includes('/api/code-review/tasks') && exactPaths.includes('/api/code-review/events'));
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
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\ntask-api 冒烟${failures ? `完成，${failures} 项失败` : '全部通过'}。`);
process.exit(failures ? 1 : 0);
