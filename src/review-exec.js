/**
 * review-exec.js —— 一次评审的纯执行体（会话工具与后台 serve 共用，无 ctx 依赖）。
 *
 * 背景（后台任务化改造）：评审不再必须挂在会话进程内同步等待——
 * 执行体从 index.js 抽出，既可被会话内 code_review 工具复用（同步形态），
 * 也可被 serve-entry.js 在独立进程中调用（后台形态，慢模型/大仓库不阻塞前台、
 * 不超时）。配置与模型解析全部来自任务参数 + DSH 配置文件（model-provider /
 * credentials 的文件兜底），serve 进程里 ctx=undefined 即可工作。
 *
 * 数据流：executeReview(task) → locateEngineBin → buildReviewArgs → 解析评审
 * 模型端点（createModelSource(undefined)）→ 凭据（resolveApiKey(undefined,…)，
 * key 只进子进程 env 不落盘）→ runEngine 执行 codecheck → 敏感文件点名 →
 * 落报告。返回结构化结果，由调用方决定如何呈现。
 *
 * 零敏感：不包含任何平台标识；模型/凭据信息全部来自 DSH 配置。
 */
// DEFAULT_CONFIG 已无引用（配置统一走 normalizeConfig 快照），
// 死 import 移除。
// isAbsolute 用于 repoPath 的绝对路径判定（见下方
// 「1. repoPath 必填」——serve 进程无「调用时 cwd」概念，相对路径不可解析）。
import { isAbsolute } from 'node:path';
import { normalizeConfig } from './config.js';
import { readFileConfig } from './file-config.js';
import { locateEngineBin, buildReviewArgs, runEngine, prepareEngineEnv, collectPendingPaths } from './runner.js';
import { writeReport, repoNameOf } from './report.js';
import { buildSensitiveBlock } from './sensitive-list.js';
import { createModelSource } from './model-provider.js';
import { resolveApiKey, isKeyMissing } from './credentials.js';

/**
 * 引擎侧 LLM **单请求**超时（毫秒）：与任务级进程兜底 review_timeout_ms 解耦
 * （用户拍板「取消超时」后，任务整体不再有 30 分钟截断——慢模型/
 * 大仓库跑多久都行；但单个 LLM 请求仍需防端点悬挂，挂死不响应的单请求若无限
 * 等会占死整个任务）。折算为秒注入 OCR_LLM_TIMEOUT（见 prepareEngineEnv）。
 */
const OCR_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 执行一次评审（引擎 → 模型端点/key → 运行 → 点名 → 报告）。
 *
 * @param {object} task 任务描述：
 *   - {string} [task.taskId]    任务 id（落盘归置用；可缺省）。
 *   - {string} [task.repoPath]  仓库路径（--repo）。**必填**——serve 为 detached
 *                               进程，无「当前目录」语义；空值显式失败（见执行体）。
 *   - {string} [task.command]   'review'（默认）| 'scan'（全目录扫描）。
 *   - {string} [task.mode]      'uncommitted'（默认）| 'branch' | 'commit'。
 *   - {string} [task.baseRef]   branch 模式对比基线（--from）。
 *   - {string} [task.headRef]   branch 模式目标端（--to，缺省 HEAD）。
 *   - {string} [task.commit]    commit 模式提交号（--commit）。
 *   - {string} [task.focus]     重点领域（--background）。
 *   - {string[]} [task.excludePaths] 排除路径（--exclude，如 engine/**）。
 *   - {string[]} [task.pendingPaths] 待提交文件清单（敏感点名；缺省自动收集）。
 *   - {object} [task.config]    配置覆盖：review_model / report_dir /
 *                               engine_bin / review_timeout_ms /
 *                               concurrency_enabled / concurrency（缺省取默认值）。
 * @returns {Promise<object>} {
 *   ok, code, stdout, stderr, timedOut, elapsedSec,
 *   reportPath, modelNote, sensitiveBlock
 * }
 */
export async function executeReview(task) {
  try {
    return await executeReviewInner(task);
  } catch (error) {
    // 兜底（本函数 JSDoc 承诺「失败统一返回 {ok:false,...}」，
    // 但此前只有 locateEngineBin 失败走结构化返回——模型解析（如 ~/.dsh/profiles
    // 的 readdirSync 不可读）、参数组装等任一步抛出都会让 Promise 直接 reject 进
    // 调用方（dispatchReview/execute 均裸 await 无捕获）。这里把异常折叠成与
    // 「未找到引擎」同形状的失败对象，错误信息放 stderr。
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: `评审执行异常：${String(error?.message ?? error)}`,
      timedOut: false,
      elapsedSec: 0,
      reportPath: null,
      modelNote: '',
      sensitiveBlock: '',
    };
  }
}

/**
 * executeReview 的实现体（异常由外层兜底统一折叠成结构化失败，见 executeReview）。
 * @param {object} task 同 executeReview。
 * @returns {Promise<object>} 结构化结果。
 */
async function executeReviewInner(task) {
  const snap = task.config && typeof task.config === 'object' ? task.config : {};
  // 快照先经 normalizeConfig 合法化（任务卡是落盘 JSON，可被
  // 人工编辑或旧版/异常写入——review_timeout_ms 若是 null/0/负数/NaN 原样传给
  // runEngine，setTimeout(fn, 0) 会在第一轮事件循环就杀掉引擎（症状=「评审刚开始
  // 就超时中止」）；report_dir/engine_bin 为 null 也会带进下游。normalizeConfig
  // 语义：非法值回退默认、有限值钳制、未知键剔除，绝不抛错。
  const cfg = normalizeConfig(snap);
  // 并发设置兜底（任务卡快照由旧版插件写入时**不含并发字段**，直接
  // 取默认值会静默回落 false（单线）——症状是「设置面板已开启并发，引擎仍收到
  // --concurrency 1」。因此快照未携带并发字段时，实时读取插件配置文件兜底
  // （getConfig 热生效语义：执行时以最新配置为准）。快照带了值则仍以快照为准。
  if (typeof snap.concurrency_enabled !== 'boolean') {
    const live = normalizeConfig(readFileConfig());
    cfg.concurrency_enabled = live.concurrency_enabled;
    if (!Number.isFinite(snap.concurrency)) {
      cfg.concurrency = live.concurrency;
    }
  }

  // 1. repoPath 必填且须为绝对路径（此前只判「非空
  //    字符串」——serve 进程无「调用时 cwd」概念，相对路径会被引擎相对宿主
  //    profile cwd 解析，跑出伪成功/伪失败都不可预期。index.js dispatchReview
  //    已在上游把相对路径 resolve 成绝对；这里兜底任务簿直接投递的裸相对
  //    路径，错误信息直接引导补参，不猜。）
  if (!task.repoPath || typeof task.repoPath !== 'string' || !isAbsolute(task.repoPath)) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: '任务卡缺 repo_path 或非绝对路径：后台 serve 无「当前目录」概念，请显式传仓库绝对路径（code_review 工具的 repo_path）',
      timedOut: false,
      elapsedSec: 0,
      reportPath: null,
      modelNote: '',
      sensitiveBlock: '',
    };
  }

  // 2. 定位引擎（设置 > 包内 bin > PATH）。
  const located = locateEngineBin(cfg);
  if (!located) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: '未找到引擎 codecheck（查找顺序：engine_bin → 插件包 bin/ → PATH）',
      timedOut: false,
      elapsedSec: 0,
      reportPath: null,
      modelNote: '',
      sensitiveBlock: '',
    };
  }

  // 3. 组装引擎参数（含排除路径、并发设置——并发由设置面板控制，见 config.js）。
  const engineArgs = buildReviewArgs({
    command: task.command === 'scan' ? 'scan' : 'review',
    mode: task.command === 'scan' ? undefined : task.mode,
    baseRef: task.baseRef,
    headRef: task.headRef,
    commit: task.commit,
    focus: task.focus,
    repoPath: task.repoPath,
    excludePaths: task.excludePaths,
    concurrencyEnabled: cfg.concurrency_enabled === true,
    concurrency: cfg.concurrency,
  });

  // 4. 评审模型解析 + key 注入（零落盘：key 只进子进程 env）。
  // 端点解析失败（无会话模型、无用户配置路由，且官方付费兜底已于 
  // 红线移除）→ 任务直接失败并给可操作提示：不启动引擎、不产生任何外部
  // 调用，绝无隐式账单。与其他早退路径一致返回结构化失败对象（若改抛异常，
  // 会被 executeReview 的 catch 统一包上「评审执行异常：」前缀，把可操作的
  // 配置指引淹没在异常外观里）。
  const modelSource = createModelSource(undefined);
  const endpoint = modelSource.resolveProvider(cfg.review_model);
  if (!endpoint) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr:
        '评审模型解析失败：未找到可用端点（官方付费兜底已禁用，属配置红线——' +
        '任何路径都不得隐式调用官方付费 API）。请在设置面板选择评审模型，' +
        '或在 DSH 模型配置中登记 provider 后重试。',
      timedOut: false,
      elapsedSec: 0,
      reportPath: null,
      modelNote: '',
      sensitiveBlock: '',
    };
  }
  let engineEnv = {};
  let modelNote = '';
  if (endpoint.keyEnv) {
    const key = resolveApiKey(undefined, endpoint.keyEnv);
    if (isKeyMissing(key)) {
      modelNote = `评审模型 ${endpoint.providerLabel} 的凭据（${endpoint.keyEnv}）未找到：请配置环境变量或在 DSH 凭据文件中登记。`;
    } else {
      const prep = prepareEngineEnv({ endpoint, key, timeoutMs: OCR_REQUEST_TIMEOUT_MS });
      engineEnv = prep.env;
      if (prep.injected) modelNote = prep.note;
    }
  }

  // 5. 运行（后台任务语义：超时由任务级 timeoutSec 兜底，调用方不阻塞）。
  const start = Date.now();
  const result = await runEngine({ bin: located.bin, args: engineArgs, timeoutMs: cfg.review_timeout_ms, env: engineEnv });
  // elapsedSec 契约 = number（秒，见模块头 JSDoc；
  // 失败路径用 0）。此前 `.toFixed(1)` 把它变成字符串——消费方（index.js /
  // serve-entry.js 的结果头、client.js 的 fmtElapsed）按 number 运算，历史任务
  // 簿里存的 string 全靠「字符串比较碰巧方向对」才没炸。这里存原始 number，
  // 展示处各自 toFixed。
  const elapsedSec = (Date.now() - start) / 1000;

  // 6. 敏感文件点名（内容不送审，只点名）。
  const pendingPaths = Array.isArray(task.pendingPaths) && task.pendingPaths.length > 0
    ? task.pendingPaths
    : collectPendingPaths(task.repoPath);
  const sensitiveBlock = buildSensitiveBlock(pendingPaths);

  // 6. 落报告（失败不阻断）。
  // ⚠ body 是累加拼接的目标（上面 join 后还要追加 stderr/敏感块），必须 let——
  // 写成 const 会在「引擎失败且有 stderr」时抛 Assignment to constant variable，
  // 直接把整次评审打成 failed。
  let body = [
    '# 代码审查报告',
    '',
    `- 仓库: ${repoNameOf(task.repoPath || '')}`,
    `- 引擎: ${located.bin}`,
    `- 命令: codecheck ${engineArgs.join(' ')}`,
    `- 耗时: ${elapsedSec.toFixed(1)}s`,
    `- 退出码: ${result.code}`,
    // 并发注记（留档可读「这次是怎么跑的」（单线 / N 路并行）。
    `- 并发: ${cfg.concurrency_enabled === true ? `${cfg.concurrency} 路并行` : '单线（未开并发）'}`,
    modelNote ? `- 模型注记: ${modelNote}` : null,
    '',
    '---',
    '',
    result.stdout.trim() || (result.ok ? '(无输出)' : '(无标准输出)'),
  ]
    .filter((x) => x !== null)
    .join('\n');
  if (!result.ok && result.stderr.trim()) {
    body += `\n\n## 引擎 stderr\n\n\`\`\`\n${result.stderr.trim()}\n\`\`\`\n`;
  }
  if (sensitiveBlock) {
    body += `\n${sensitiveBlock}\n`;
  }

  const report = await writeReport({
    reportDir: cfg.report_dir,
    repoPath: task.repoPath || 'repo',
    body,
  });

  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: Boolean(result.timedOut),
    elapsedSec,
    reportPath: report.ok ? report.path : null,
    modelNote,
    sensitiveBlock,
  };
}
