/**
 * index.js —— dsh-code-review 插件主入口（Cordis bundle 形态的唯一 apply）。
 *
 * 职责（步骤 4 骨架 + 后续步骤的接入位全部在这里汇合）：
 *  1. 注册原生工具 code_review（会话自然语言自动触发，日常主力）；
 *  2. 注册斜杠命令 /review（手动精确传参：分支/提交/目录/重点）；
 *  3. 注册宿主设置命名空间（评审模型选择器 / 报告目录 / 引擎路径 / 首启引导）；
 *  4. 首启引导流程（首次启用时输出确认引导，见 config.first_run）。
 *
 * 设置读法：
 *  - 宿主 settings 服务（inject 声明 'settings'）注册命名空间，DSH 设置页渲染；
 *  - 工具执行时经 getRuntimeConfig() 惰性读取最新设置快照，改设置即热生效；
 *  - 参数优先级：工具参数(显式) > 设置页 > 默认值。
 *
 * 同步执行语义：execute 原地 await 引擎跑完（接受长任务，最长约数分钟，
 * 由 config.review_timeout_ms 兜底）。结果一次返回（问题清单文本 + 报告路径）。
 *
 * 零敏感：本文件不硬编码任何平台内部标识；评审模型选项动态来自 DSH 配置。
 */
import { normalizeConfig, pickOverrides, DEFAULT_CONFIG, SETTINGS_NS } from './config.js';
import { readFileConfig } from './file-config.js';
import { createSetConfigTool, SET_CONFIG_TOOL_NAME } from './set-config-tool.js';
import { createSettingsSchema } from './settings-schema.js';
import { locateEngineBin, buildReviewArgs, runEngine, probeEngineVersion, prepareEngineEnv, collectPendingPaths } from './runner.js';
import { writeReport, repoNameOf } from './report.js';
import { buildSensitiveBlock } from './sensitive-list.js';
import { createModelSource } from './model-provider.js';
import { resolveApiKey, isKeyMissing } from './credentials.js';
import { executeReview } from './review-exec.js';
import {
  REVIEW_HOME, TASKS_ROOT,
  enqueueTask, readTask, listTasks, ensureServe, newTaskId,
} from './task-book.js';
import { createTaskRoutes, startPushPoller } from './task-api.js';

export const name = 'dsh-code-review';

/**
 * Cordis 服务注入声明：缺 'tools' 宿主报「cannot get property tools without
 * inject」（插件启用失败）；'settings' 为 DSH 宿主设置服务。两者都确定存在，声明即生效。
 */
export const inject = ['tools', 'settings'];

/** 工具名（常量，供描述与测试引用）。 */
export const TOOL_NAME = 'code_review';

/** 后台任务状态查询工具名。 */
export const STATUS_TOOL_NAME = 'code_review_status';

/* ═══ 一次评审的执行体（工具 execute 与 /review 命令共用） ═══ */

/**
 * 把工具参数归一为任务描述（executeReview 的入参形状）。
 * @param {object} args 工具参数（mode/base_ref/head_ref/commit/focus/repo_path/pending_paths/exclude_paths）。
 * @param {object} cfg  归一化配置（config 覆盖层）。
 * @returns {object} 任务描述。
 */
function taskFromArgs(args, cfg) {
  return {
    taskId: null, // 由入队方补全
    repoPath: args.repo_path,
    command: args.mode === 'scan' ? 'scan' : 'review',
    mode: args.mode === 'scan' ? undefined : args.mode,
    baseRef: args.base_ref,
    headRef: args.head_ref,
    commit: args.commit,
    focus: args.focus,
    excludePaths: Array.isArray(args.exclude_paths) ? args.exclude_paths.map(String) : [],
    pendingPaths: Array.isArray(args.pending_paths) ? args.pending_paths.map(String) : [],
    config: {
      review_model: cfg.review_model,
      report_dir: cfg.report_dir,
      engine_bin: cfg.engine_bin,
      review_timeout_ms: cfg.review_timeout_ms,
      // 并发设置必须随任务卡快照一起携带（2026-10-15 修）：review-exec 用
      // `{ ...DEFAULT_CONFIG, ...task.config }` 还原执行配置，快照漏带即回落默认
      // false（单线）——表现为设置面板已开启并发，引擎却仍收到 --concurrency 1。
      concurrency_enabled: cfg.concurrency_enabled === true,
      concurrency: cfg.concurrency,
    },
  };
}

/**
 * 后台投递一次评审（serve 编排执行，不阻塞前台、不受会话超时约束）。
 *
 * @param {object} args 工具参数。
 * @param {object} cfg  归一化配置。
 * @param {object} [opts] 附加元数据：{ requestor: { sessionId } }——发起会话标识，
 *                        供「完成后推送给发起会话」使用（拿不到则为空，跳过推送）。
 * @returns {Promise<{ok: boolean, taskId: string, text: string, serveAlive: boolean, syncFallback?: string}>}
 *   serve 未能拉起时回退同步执行（syncFallback 带提示）。
 */
async function dispatchReview(args, cfg, opts = {}) {
  const task = taskFromArgs(args, cfg);
  if (opts.requestor) task.requestor = opts.requestor;
  const serve = await ensureServe();
  if (!serve.alive) {
    // serve 起不来（罕见：宿主禁子进程等）→ 回退同步执行，保证能用。
    const exec = await executeReview(task);
    return {
      ok: exec.ok,
      taskId: newTaskId(),
      serveAlive: false,
      text: buildSyncResultText(exec),
      syncFallback: `serve 未能启动（${serve.reason ?? '未知原因'}），本次已回退同步执行。`,
    };
  }
  const taskId = enqueueTask(task);
  const taskPath = `${TASKS_ROOT}\\${taskId}.json`;
  return {
    ok: true,
    taskId,
    serveAlive: true,
    text: [
      `## 代码审查已排队（后台任务 ${taskId}）`,
      '',
      `- 仓库: ${args.repo_path || '(当前目录)'}`,
      `- 命令: codecheck ${task.command}${task.repoPath ? ` --repo ${task.repoPath}` : ''}`,
      `- 任务簿: ${taskPath}`,
      '',
      '评审在后台 serve 中执行，**不阻塞会话、不受超时限制**（慢模型也没关系）。',
      '随时用 code_review_status 工具查状态取结果；完成后报告自动落盘留档。',
    ].join('\n'),
  };
}

/**
 * 同步形态的结果组装（serve 不可用时的回退 / 低层测试引用）。
 * @param {object} exec executeReview 的结构化结果。
 * @returns {string} 会话内问题清单文本。
 */
function buildSyncResultText(exec) {
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

/**
 * 执行一次评审（同步形态，保留供测试/降级；生产走后台投递 dispatchReview）。
 *
 * @param {object} ctx       Cordis 上下文（模型取数/凭据解析，serve 场景不使用）。
 * @param {object} getConfig 实时配置读取函数。
 * @param {object} args      本次评审参数（repo_path/mode/base_ref/head_ref/commit/focus）。
 * @returns {Promise<string>} 会话内返回的问题清单文本。
 */
async function reviewOnce(ctx, getConfig, args) {
  const exec = await executeReview(taskFromArgs(args, getConfig()));
  return buildSyncResultText(exec);
}

/* ═══ 工具定义 ═══ */

/**
 * 从工具 execute 的 exec 上下文尽力提取发起会话标识（供「完成后推送给发起会话」）。
 * 宿主 exec 结构未公开：多形态尽力探测；拿不到返回 null（不推送，任务仍完整留档、
 * GUI 卡片仍可见——卡片跟随发起评审的那条消息，不依赖会话定向）。
 *
 * @param {*} exec 工具 execute 第二参数（宿主注入的执行上下文）。
 * @returns {{sessionId: string}|null}
 */
function requestorOf(exec) {
  if (!exec || typeof exec !== 'object') return null;
  const sid = exec?.sessionId ?? exec?.session?.id ?? exec?.address?.sessionId ?? exec?.meta?.sessionId ?? exec?.session_id;
  return sid ? { sessionId: String(sid) } : null;
}

/**
 * 创建原生工具 code_review。
 *
 * @param {object} ctx        Cordis 上下文（模型取数/凭据解析）。
 * @param {Function} getConfig 实时配置读取函数。
 * @returns {object} 工具对象（ctx.tools.register 直接消费）。
 */
export function createReviewTool(ctx, getConfig) {
  const tool = TOOL_NAME;
  return {
    name: tool,
    description: [
      '对代码仓库执行智能代码审查：调用引擎 codecheck（open-code-review 的 fork）读取 git diff 或做全目录扫描，',
      '用评审模型按三个固定视角挑刺：① 安全与脱敏（硬编码密钥/口令/PII/内部信息泄露 + 安全漏洞）；',
      '② 找 bug（逻辑/边界/异常/并发）；③ 冗余与任务无关代码（scope creep/死代码）。',
      '【后台执行】发起后立即返回任务 id（任务卡），评审由后台 serve 异步执行：不阻塞会话、不受会话超时限制、慢模型也没关系。',
      '随后用 code_review_status 工具查状态取结果；完成后报告自动落盘留档（会话内仍可拿完整问题清单）。',
      '参数：repo_path（仓库路径，默认当前目录）；mode（review 模式：uncommitted 工作区未提交 / branch 分支对比 / commit 指定提交；或 scan 全目录扫描）；',
      'base_ref（branch 模式的对比基线，默认 main）；head_ref（branch 模式的目标分支）；commit（commit 模式的提交号）；',
      'focus（本次评审重点领域，一句话背景要求）；pending_paths（待提交文件相对路径数组，用于敏感文件点名，内容不送审）；',
      'exclude_paths（跳过评审的路径，如 ["engine/**"]——引擎目录等已验证的手艺可排除）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        repo_path: { type: 'string', description: '仓库路径（绝对或相对当前目录）。省略 = 当前目录。' },
        mode: {
          type: 'string',
          enum: ['uncommitted', 'branch', 'commit', 'scan'],
          description: '评审模式：uncommitted=工作区未提交改动（默认）；branch=分支对比；commit=指定提交；scan=全目录扫描。',
        },
        base_ref: { type: 'string', description: 'branch 模式的对比基线分支（默认 main）。' },
        head_ref: { type: 'string', description: 'branch 模式的目标分支（要评审的分支）。' },
        commit: { type: 'string', description: 'commit 模式的提交号（评审该提交的改动）。' },
        focus: { type: 'string', description: '本次评审重点领域（一句话背景，如「这是要发布到 GitHub 的开源仓库，重点查脱敏」）。' },
        pending_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '待提交文件相对路径清单（git 相对路径）。命中敏感模式的会点名列入报告，内容一律不送审。',
        },
        exclude_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '跳过评审的路径模式（引擎 --exclude 语义，如 ["engine/**"]）。',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          task_id: { type: 'string' },
          report_path: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `${tool}：${String(args?.repo_path ?? '.')}`,
      kind: 'read',
      locations: args?.repo_path ? [{ path: String(args.repo_path) }] : [],
    }),
    async execute(args, _exec) {
      const cfg = getConfig();
      const requestor = requestorOf(_exec);
      const result = await dispatchReview(args ?? {}, cfg, requestor ? { requestor } : {});
      const text = result.syncFallback ? `${result.text}\n\n> ${result.syncFallback}` : result.text;
      return { ok: true, task_id: result.taskId, text };
    },
  };
}

/* ═══ 状态查询工具 code_review_status ═══ */

/**
 * 创建后台任务状态查询工具：查单个任务（状态/结果全文），或列出最近任务。
 *
 * @param {object} ctx       Cordis 上下文。
 * @param {Function} getConfig 实时配置读取函数。
 * @returns {object} 工具对象。
 */
export function createStatusTool(ctx, getConfig) {
  return {
    name: STATUS_TOOL_NAME,
    description: [
      '查询后台评审任务状态与结果（配合 code_review 后台任务的「任务 id」使用）。',
      'task_id 省略 = 列出最近的任务（id/状态/仓库/时间，一眼看到谁在跑、谁完成了）；',
      'task_id 指定 = 返回该任务完整状态与结果（done 时含完整问题清单 + 报告落盘路径，failed 时含引擎报错）。',
      '任务状态机：queued（排队）→ running（执行中）→ done（完成）| failed（失败/超时/引擎错误）。',
      '任务簿位置（可人工查看）：~/.dsh/dsh-code-review/tasks/ 下的 <id>.json。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        task_id: { type: 'string', description: '任务 id（code_review 返回的任务卡里）。省略 = 列出最近任务。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          tasks: { type: 'array' },
        },
        required: ['ok'],
      },
      render: (args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: `${STATUS_TOOL_NAME}`, kind: 'read' }),
    async execute(args, _exec) {
      return { ok: true, ...statusPayload(args?.task_id) };
    },
  };
}

/**
 * 状态查询载荷（工具 execute 与 /review-status 共用）。
 * @param {string} [taskId] 任务 id；省略 = 最近任务列表。
 * @returns {{text: string, tasks?: object[]}}
 */
function statusPayload(taskId) {
  if (taskId) {
    const task = readTask(taskId);
    if (!task) {
      return { text: `未找到任务 ${taskId}（任务簿：${TASKS_ROOT}）。可用 code_review_status 不带 task_id 列出最近任务。` };
    }
    let lines = [
      `## 评审任务 ${task.id}`,
      '',
      `- 状态: **${task.status}**${task.status === 'done' ? ' ✅' : task.status === 'failed' ? ' ❌' : ''}`,
      `- 仓库: ${task.repoPath ?? '(未指定)'}`,
      `- 命令: codecheck ${task.command}${task.repoPath ? ` --repo ${task.repoPath}` : ''}${(task.excludePaths || []).length ? ` ${task.excludePaths.map((p) => `--exclude ${p}`).join(' ')}` : ''}`,
      `- 创建: ${task.createdAt ?? '—'}`,
      task.startedAt ? `- 开始: ${task.startedAt}` : null,
      task.finishedAt ? `- 结束: ${task.finishedAt}` : null,
      task.result?.modelNote ? `- 模型: ${task.result.modelNote}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    if (task.status === 'running') {
      lines += '\n\n评审还在后台执行中……（慢模型没关系，不阻塞；过一会儿再查）。';
    } else if (task.status === 'done' || task.status === 'failed') {
      lines += `\n\n${task.result?.text ?? '(无结果文本)'}`;
    } else {
      lines += '\n\n任务已入队，等待 serve 拾起……';
    }
    return { text: lines, tasks: [task] };
  }
  const tasks = listTasks(10);
  if (tasks.length === 0) {
    return { text: '还没有评审任务。用 code_review 发起一次评审吧。', tasks: [] };
  }
  const rows = tasks.map((t) => {
    const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'running' ? '⏳' : '🕐';
    return `- ${icon} \`${t.id}\` ${t.status} · ${t.command} ${t.repoPath ?? ''} · ${(t.createdAt ?? '').slice(0, 19).replace('T', ' ')}`;
  });
  return {
    text: [
      `## 最近评审任务（${tasks.length} 个）`,
      '',
      ...rows,
      '',
      '详情用 code_review_status 传 task_id 查询（如 code_review_status task_id=xxx）。',
      `任务簿：${TASKS_ROOT}`,
    ].join('\n'),
    tasks,
  };
}

/* ═══ 首启引导 ═══ */

/**
 * 首次启用引导：输出引导日志（确认评审模型沿用、确认报告目录）。
 * 用户确认后可在设置里关闭 first_run；每次 apply 只在 first_run=true 时提示。
 *
 * @param {object} ctx  Cordis 上下文（logger）。
 * @param {object} cfg  归一化配置。
 */
function welcomeOnce(ctx, cfg) {
  if (!cfg.first_run) return;
  const logger = ctx.logger;
  const log = (msg) => {
    if (typeof logger?.info === 'function') logger.info(`[dsh-code-review] ${msg}`);
    else if (typeof logger === 'function') logger(`[dsh-code-review] ${msg}`);
    else process.stdout.write(`[dsh-code-review] ${msg}\n`);
  };
  log('首次启用引导 —— 智能代码审查插件已就绪。');
  log(`评审模型：${cfg.review_model === 'session' ? '沿用会话模型（DSH 默认 DeepSeek-V41-Flash）' : cfg.review_model}（可在设置面板「智能代码审查」分区另选）。`);
  log(`报告目录：${cfg.report_dir}（每次评审按 日期/仓库 落盘留档。` + '`发 GitHub 前已审过` 凭证）。');
  log('使用方法：会话里说「审一下当前改动」，或输入斜杠命令 /review 精确传参。');
  log('确认无误后，可在设置里关闭「首次启动引导」开关静默本提示。');
}

/* ═══ 设置注册 ═══ */

/**
 * 注册宿主设置命名空间：能力探测（register / installSettingsSection），
 * 失败仅告警降级（工具与命令照常，配置走默认+参数覆盖）。
 *
 * @param {object} ctx Cordis 上下文。
 */
function registerSettings(ctx) {
  try {
    const settings = ctx.settings;
    if (!settings) {
      ctx.logger?.warn?.('[dsh-code-review] 宿主未提供 settings 服务，设置面板不可用（默认配置仍生效）。');
      return;
    }
    // 评审模型选项动态来自 DSH 模型配置（不硬编码）：宿主增删 provider 后自动跟随。
    const modelSource = createModelSource(ctx);
    const candidates = modelSource.listCandidates();
    const schema = createSettingsSchema(candidates);
    if (typeof settings.register === 'function') {
      settings.register(SETTINGS_NS, schema);
      ctx.logger?.info?.(`[dsh-code-review] 设置命名空间已注册（${SETTINGS_NS}，评审模型选项 ${candidates.length} 个）。`);
    } else if (typeof settings.installSettingsSection === 'function') {
      settings.installSettingsSection({ namespace: SETTINGS_NS, schema });
      ctx.logger?.info?.('[dsh-code-review] 设置分区已安装（installSettingsSection 通道）。');
    } else {
      ctx.logger?.warn?.('[dsh-code-review] 宿主 settings 服务无 register/installSettingsSection，设置面板不可用。');
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-code-review] 设置注册失败（降级为默认配置）：${String(error?.message ?? error)}`);
  }
}

/* ═══ 斜杠命令 /review ═══ */

/**
 * 注册斜杠命令 /review（手动精确传参入口，与 code_review 工具共用执行体）。
 *
 * ⚠ 生命周期纪律（2026-10-12 客户端装载协议实测）：Cordis 在 apply 阶段**未注入的
 * 服务属性直接访问即抛** `cannot get property 'command' without inject`
 * （typeof 检查也拦不住——读属性本身就炸）。正确姿势：
 * 可选服务用 `ctx.inject(['command'], cb)` 动态注入，宿主提供 command 服务时
 * 才注册；不写静态 `inject` 数组（那是「必需的才用」），缺服务不阻塞插件激活，
 * 工具 code_review 仍为主力入口。
 *
 * @param {object} ctx       Cordis 上下文。
 * @param {Function} getConfig 实时配置读取函数。
 */
function registerCommand(ctx, getConfig) {
  try {
    ctx.inject(['command'], (sctx) => {
      try {
        sctx
          .command('review', '智能代码审查：对仓库 diff/扫描做评审（安全/找bug/冗余三视角）。后台执行——发起即返回任务 id，不阻塞；结果用 /review-status 查。')
          .option('mode, -m <mode>', '评审模式：uncommitted（默认）/ branch / commit / scan', { fallback: 'uncommitted' })
          .option('repo, -r <repo>', '仓库路径（默认当前目录）')
          .option('base, -b <base>', 'branch 模式的对比基线（默认 main）', { fallback: 'main' })
          .option('head <head>', 'branch 模式的目标分支')
          .option('commit, -c <commit>', 'commit 模式的提交号')
          .option('focus, -f <focus>', '本次评审重点领域（一句话背景）')
          .option('exclude <exclude>', '跳过评审的路径模式（--exclude 语义；多个用逗号分隔，如 engine/**,dist/**）')
          .action(async (argv) => {
            const cfg = getConfig();
            const exclude = typeof argv.exclude === 'string' && argv.exclude.trim()
              ? argv.exclude.split(',').map((s) => s.trim()).filter(Boolean)
              : [];
            const result = await dispatchReview(
              {
                mode: argv.mode,
                repo_path: argv.repo,
                base_ref: argv.base,
                head_ref: argv.head,
                commit: argv.commit,
                focus: argv.focus,
                exclude_paths: exclude,
              },
              cfg,
              // /review 由会话直接发起：argv.session 为宿主注入的会话对象（尽力取 id）。
              argv?.session?.id ? { requestor: { sessionId: String(argv.session.id) } } : {},
            );
            const text = result.syncFallback ? `${result.text}\n\n> ${result.syncFallback}` : result.text;
            sctx.logger?.info?.(`[dsh-code-review] /review 已投递后台任务 ${result.taskId}。`);
            return text;
          });
        sctx
          .command('review-status', '查询后台评审任务状态（/review 或 code_review 发起的任务）。')
          .argument('<taskId>', '任务 id（/review 返回的任务卡里；省略参数则列出最近任务）', { optional: true })
          .action(async (argv) => {
            return statusPayload(argv.taskId).text;
          });
      } catch (error) {
        sctx.logger?.warn?.(`[dsh-code-review] /review 命令注册失败（工具 code_review 仍可用）：${String(error?.message ?? error)}`);
      }
    });
  } catch (error) {
    // ctx.inject 本身抛错（宿主能力差异）→ 仅告警，不阻塞挂载。
    ctx.logger?.warn?.(`[dsh-code-review] command 服务不可用，/review 跳过（工具 code_review 仍为主力）：${String(error?.message ?? error)}`);
  }
}

/* ═══ 插件入口 ═══ */

// 必需服务注入声明见第 35 行（export const inject = ['tools', 'settings']）：
// tools = code_review 工具（核心入口）、settings = 设置面板，均为静态必需注入；
// command（/review 命令）与 webServer（GUI 任务数据路由/完成推送）为可选增强 →
// 各自经 ctx.inject 动态注入，缺服务不阻塞挂载（工具仍为主力入口，会话内查询兜底）。

/**
 * 挂载后台任务的宿主可见面：
 *   - webServer 路由（GUI 轮询/SSE 的数据源，client 认证 fetch 通道同源可读）；
 *   - 完成推送协程（任务 done/failed 时给发起会话推结果摘要，信息主动进 GUI 消息流）。
 * 两者都是可选能力：webServer 缺失 → 仅剩会话内查询；会话通道缺失 → 推送跳
 * 过（任务 JSON 记 push 标记，防反复试探）。disposers 供 apply 卸载时统一释放。
 *
 * @param {object} ctx       Cordis 上下文。
 * @param {Function[]} disposers 卸载函数收集数组（apply 返回时逐个调用）。
 */
function mountTaskApi(ctx, disposers) {
  // ① 数据路由（host 侧有 webServer 才挂；挂载失败仅告警）。
  try {
    ctx.inject(['webServer'], (sctx) => {
      try {
        for (const route of createTaskRoutes()) {
          disposers.push(sctx.webServer.register(route));
        }
        ctx.logger?.info?.('[dsh-code-review] 后台任务数据路由已挂载：/api/code-review/tasks、/api/code-review/events。');
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-code-review] webServer 路由挂载失败（GUI 仅剩会话内查询）：${String(error?.message ?? error)}`);
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-code-review] webServer 服务不可用（GUI 数据路由跳过）：${String(error?.message ?? error)}`);
  }
  // ② 完成推送协程（每 5s 扫一次任务簿，轻量；无新任务几乎零开销）。
  disposers.push(startPushPoller(ctx));
}

/**
 * Cordis apply 入口。
 *
 * @param {object} ctx       Cordis 上下文。
 * @param {object} [configRaw] 宿主传入配置（可 undefined；volatile 字段先解包）。
 * @returns {Function|void} 卸载函数（若有需清理的资源）。
 */
export function apply(ctx, configRaw) {
  // 运行时配置真源 = 三层合并（低 → 高）：
  //   ① 宿主 entry（configRaw，0.2.0 configForms 通道，volatile 字段为可热更新
  //      包装对象，须**每次读取时重新解包**（调用方每次读取配置都经
  //      pickOverrides 解包，不能只在启动时解包一次）；
  //   ② settings 命名空间快照（0.1.x 通道保底，尽力读取）；
  //   ③ 插件自有配置文件 plugin-config.json（**运行真源**，2026-10-13 加）：
  //      0.2.0-rc.2 宿主「面板保存」对第三方 bundle 插件不回传 entry config（实测
  //      只写 cordis.yml/patch.yml、无 settings 快照、apply 收全默认），
  //      code_review_set_config 工具/人工编辑写入本文件，
  //      getConfig 每次调用都重新读（热生效，无需重启），优先级最高。
  const entryConfig = () => normalizeConfig({ ...pickOverrides(configRaw), ...readFileConfig() });
  // 兜底 sourceGetter：settings 服务未就绪时仅 entry + 文件层（含默认值兜底）。
  let sourceGetter = entryConfig;
  const getConfig = () => sourceGetter();
  ctx.inject(['settings'], (sctx) => {
    // settings 服务就绪后：文件层优先，其次宿主 entry，0.1.x settings 快照仅补充。
    sourceGetter = () => {
      try {
        const snapshot = sctx.settings.get?.(SETTINGS_NS);
        const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
        return normalizeConfig({ ...base, ...pickOverrides(configRaw), ...readFileConfig() });
      } catch {
        /* 读快照/解包失败回退 entry + 文件层 */
        return entryConfig();
      }
    };
  });

  // 首启引导。
  welcomeOnce(ctx, getConfig());

  // 设置注册（能力探测，失败降级）。
  registerSettings(ctx);

  // 工具注册（ctx.effect 内，卸载时 dispose）。
  const disposers = [];
  ctx.effect(() => {
    try {
      disposers.push(ctx.tools.register(createReviewTool(ctx, getConfig)));
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-code-review] code_review 工具注册失败：${String(error?.message ?? error)}`);
    }
    try {
      disposers.push(ctx.tools.register(createStatusTool(ctx, getConfig)));
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-code-review] ${STATUS_TOOL_NAME} 工具注册失败：${String(error?.message ?? error)}`);
    }
    try {
      disposers.push(ctx.tools.register(createSetConfigTool(ctx, getConfig)));
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-code-review] ${SET_CONFIG_TOOL_NAME} 工具注册失败（配置仅走默认）：${String(error?.message ?? error)}`);
    }
  });

  // 斜杠命令 /review。
  registerCommand(ctx, getConfig);

  // 后台任务宿主可见面（GUI 数据路由 + 完成推送；可选能力，缺服务不阻塞）。
  mountTaskApi(ctx, disposers);

  // 引擎可用性探测（后台异步，仅日志告知；不阻塞挂载）。
  probeEngineVersion(getConfig()).then((v) => {
    if (v) {
      ctx.logger?.info?.(`[dsh-code-review] 引擎就绪：${v}`);
    } else {
      ctx.logger?.warn?.('[dsh-code-review] 未找到引擎 codecheck，请按设置面板说明配置 engine_bin 或放入插件包 bin/。');
    }
  });

  // 返回卸载函数（尽力释放）。
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 忽略 */
      }
    }
  };
}

/* 默认配置导出（宿主 schema 校验/测试引用）。 */
export { DEFAULT_CONFIG, SETTINGS_NS };
/* 0.2.0 宿主设置页可编辑配置 schema（configForms 表单字段真源，见 plugin-config.js）；
   设置命名空间 settings.register 仍保留（供 0.1.x settings 快照通道保底读取）。 */
export { Config } from './plugin-config.js';
/* 评审执行体导出（e2e/单元判据载体：sensitive-e2e、后续步骤可复现链路）。 */
export { reviewOnce, buildSensitiveBlock };
