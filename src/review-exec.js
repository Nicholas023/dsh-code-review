/**
 * review-exec.js —— 一次评审的纯执行体（会话工具与后台 serve 共用，无 ctx 依赖）。
 *
 * 背景（2026-10-13 后台任务化改造）：评审不再必须挂在会话进程内同步等待——
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
import { DEFAULT_CONFIG } from './config.js';
import { locateEngineBin, buildReviewArgs, runEngine, prepareEngineEnv, collectPendingPaths } from './runner.js';
import { writeReport, repoNameOf } from './report.js';
import { buildSensitiveBlock } from './sensitive-list.js';
import { createModelSource } from './model-provider.js';
import { resolveApiKey, isKeyMissing } from './credentials.js';

/**
 * 引擎侧 LLM **单请求**超时（毫秒）：与任务级进程兜底 review_timeout_ms 解耦
 * （2026-10-13 用户拍板「取消超时」后，任务整体不再有 30 分钟截断——慢模型/
 * 大仓库跑多久都行；但单个 LLM 请求仍需防端点悬挂，挂死不响应的单请求若无限
 * 等会占死整个任务）。折算为秒注入 OCR_LLM_TIMEOUT（见 prepareEngineEnv）。
 */
const OCR_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 执行一次评审（引擎 → 模型端点/key → 运行 → 点名 → 报告）。
 *
 * @param {object} task 任务描述：
 *   - {string} [task.taskId]    任务 id（落盘归置用；可缺省）。
 *   - {string} [task.repoPath]  仓库路径（--repo）。
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
  const cfg = { ...DEFAULT_CONFIG, ...(task.config && typeof task.config === 'object' ? task.config : {}) };

  // 1. 定位引擎（设置 > 包内 bin > PATH）。
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

  // 2. 组装引擎参数（含排除路径、并发设置——并发由设置面板控制，见 config.js）。
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

  // 3. 评审模型解析 + key 注入（零落盘：key 只进子进程 env）。
  const modelSource = createModelSource(undefined);
  const endpoint = modelSource.resolveProvider(cfg.review_model);
  let engineEnv = {};
  let modelNote = '';
  if (endpoint && endpoint.keyEnv) {
    const key = await resolveApiKey(undefined, endpoint.keyEnv);
    if (isKeyMissing(key)) {
      modelNote = `评审模型 ${endpoint.providerLabel} 的凭据（${endpoint.keyEnv}）未找到：请配置环境变量或在 DSH 凭据文件中登记。`;
    } else {
      const prep = prepareEngineEnv({ endpoint, key, timeoutMs: OCR_REQUEST_TIMEOUT_MS });
      engineEnv = prep.env;
      if (prep.injected) modelNote = prep.note;
    }
  }

  // 4. 运行（后台任务语义：超时由任务级 timeoutSec 兜底，调用方不阻塞）。
  const start = Date.now();
  const result = await runEngine({ bin: located.bin, args: engineArgs, timeoutMs: cfg.review_timeout_ms, env: engineEnv });
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  // 5. 敏感文件点名（内容不送审，只点名）。
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
    `- 耗时: ${elapsedSec}s`,
    `- 退出码: ${result.code}`,
    // 并发注记（2026-10-14 迭代）：留档可读「这次是怎么跑的」（单线 / N 路并行）。
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
