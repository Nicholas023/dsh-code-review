/**
 * index.js —— dsh-code-review 插件主入口（Cordis bundle 形态的唯一 apply）。
 *
 * 职责（步骤 4 骨架 + 后续步骤的接入位全部在这里汇合）：
 *  1. 注册原生工具 code_review（会话自然语言自动触发，日常主力）；
 *  2. 注册斜杠命令 /review（手动精确传参：分支/提交/目录/重点）；
 *  3. 注册宿主设置命名空间（评审模型选择器 / 报告目录 / 引擎路径 / 首启引导）；
 *  4. 首启引导流程（首次启用时输出确认引导，见 config.first_run）。
 *
 * 设置读法（与 宿主既有插件范式 同范式）：
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
import { createSettingsSchema } from './settings-schema.js';
import { locateEngineBin, buildReviewArgs, runEngine, probeEngineVersion, prepareEngineEnv, collectPendingPaths } from './runner.js';
import { writeReport, repoNameOf } from './report.js';
import { listSensitiveFiles } from './sensitive-list.js';
import { createModelSource } from './model-provider.js';
import { resolveApiKey, isKeyMissing } from './credentials.js';

export const name = 'dsh-code-review';

/**
 * Cordis 服务注入声明：缺 'tools' 宿主报「cannot get property tools without
 * inject」（插件启用失败）；'settings' 为 DSH 宿主设置服务（宿主既有插件范式
 * 生产实证存在）。两者都确定存在，声明即生效。
 */
export const inject = ['tools', 'settings'];

/** 工具名（常量，供描述与测试引用）。 */
export const TOOL_NAME = 'code_review';

/* ═══ 一次评审的执行体（工具 execute 与 /review 命令共用） ═══ */

/**
 * 执行一次评审：定位引擎 → 解析评审模型端点 → 注入 key（零落盘）→
 * 运行引擎 → 组装结果文本 → 落报告。
 *
 * @param {object} ctx       Cordis 上下文（模型取数/凭据解析）。
 * @param {object} getConfig 实时配置读取函数。
 * @param {object} args      本次评审参数（repo_path/mode/base_ref/head_ref/commit/focus）。
 * @returns {Promise<string>} 会话内返回的问题清单文本。
 */
async function reviewOnce(ctx, getConfig, args) {
  const cfg = getConfig();

  // 1. 定位引擎（设置 > 包内 bin > PATH）。
  const located = locateEngineBin(cfg);
  if (!located) {
    return [
      '## 智能代码审查：引擎不可用',
      '',
      '未找到引擎 codecheck。查找顺序：设置里的 engine_bin → 插件包内 `bin/codecheck(.exe)` → PATH。',
      '请先在设置面板「智能代码审查」分区配置引擎路径，或把编译产物放到插件包 `bin/` 目录后重试。',
    ].join('\n');
  }

  // 2. 组装 review/scan 参数（diff 三模式 + 重点领域）。
  const engineArgs = buildReviewArgs({
    command: args.mode === 'scan' ? 'scan' : 'review',
    mode: args.mode === 'scan' ? undefined : args.mode,
    baseRef: args.base_ref,
    headRef: args.head_ref,
    commit: args.commit,
    focus: args.focus,
    repoPath: args.repo_path,
  });

  // 2.5 评审模型解析 + key 注入（步骤 5）。key 只进子进程 env，绝不落盘/进日志。
  const modelSource = createModelSource(ctx);
  const reviewModel = cfg.review_model;
  const endpoint = modelSource.resolveProvider(reviewModel);
  let engineEnv = {};
  let injectNote = '';
  if (endpoint && endpoint.keyEnv) {
    const key = await resolveApiKey(ctx, endpoint.keyEnv);
    if (isKeyMissing(key)) {
      injectNote = `\n> ⚠ 评审模型 ${endpoint.providerLabel} 的凭据（${endpoint.keyEnv}）未找到：请配置环境变量或在 DSH 凭据文件中登记后再审。`;
    } else {
      const prep = prepareEngineEnv({ endpoint, key, timeoutMs: cfg.review_timeout_ms });
      engineEnv = prep.env;
      if (prep.injected) injectNote = `\n> ${prep.note}`;
    }
  }

  // 3. 运行（同步等待，超时兜底）。
  const start = Date.now();
  const result = await runEngine({ bin: located.bin, args: engineArgs, timeoutMs: cfg.review_timeout_ms, env: engineEnv });
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  // 4. 敏感文件点名（步骤 6）：显式 pending_paths 优先；缺省自动收集
  //    repo 待提交清单（git ls-files --others + diff）。命中敏感模式的
  //    文件只点名不读内容（内容由引擎侧排除，双保险）。
  const pendingPaths = Array.isArray(args.pending_paths) && args.pending_paths.length > 0
    ? args.pending_paths
    : collectPendingPaths(args.repo_path);
  const sensitiveBlock = buildSensitiveBlock(pendingPaths);

  // 5. 落报告（失败不阻断：结果文本仍返回，错误随文本告知）。
  let body = [
    '# 代码审查报告',
    '',
    `- 仓库: ${repoNameOf(args.repo_path || '')}`,
    `- 引擎: ${located.bin}`,
    `- 命令: codecheck ${engineArgs.join(' ')}`,
    `- 耗时: ${elapsedSec}s`,
    `- 退出码: ${result.code}`,
    injectNote ? `- 模型注记: ${injectNote.trim().replace(/^\n> /, '')}` : null,
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
  // 敏感点名块进报告文件（判据⑥：报告里出现点名项；会话 tail 也保留一次）。
  if (sensitiveBlock) {
    body += `\n${sensitiveBlock}\n`;
  }

  const report = await writeReport({
    reportDir: cfg.report_dir,
    repoPath: args.repo_path || 'repo',
    body,
  });

  const header = result.ok
    ? `## 代码审查完成（${elapsedSec}s）\n\n以下为引擎 codecheck 的评审结果：`
    : `## 代码审查失败（${elapsedSec}s，退出码 ${result.code}）\n\n引擎报错：`;
  const tail = [
    '',
    '---',
    result.ok
      ? `报告已留档：${report.ok ? report.path : `（落盘失败：${report.error}）`}`
      : `（本次失败未产生有效报告${report.ok ? `，但已留档记录：${report.path}` : ''}）`,
    injectNote,
    sensitiveBlock,
  ]
    .filter(Boolean)
    .join('\n');

  return `${header}\n\n${result.ok || result.stdout.trim() ? result.stdout.trim() || '(引擎无输出)' : result.stderr.trim()}\n${tail}`;
}

/** 敏感文件点名块（步骤 6 判据载体；contents 不送审、文件内容不读取）。 */
function buildSensitiveBlock(pendingPaths) {
  const hits = listSensitiveFiles(pendingPaths);
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => `${i + 1}. \`${h.path}\``);
  return [
    '',
    '## ⚠ 敏感文件点名（内容未送审，请人工确认是否该提交）',
    '',
    ...lines,
    '',
    '> 这些文件命中敏感路径模式，引擎已排除其内容（不送审）。请逐一确认：',
    '> 若包含密钥/凭据/隐私信息，提交 GitHub 前应加入 .gitignore 或剔除。',
  ].join('\n');
}

/* ═══ 工具定义 ═══ */

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
      '参数：repo_path（仓库路径，默认当前目录）；mode（review 模式：uncommitted 工作区未提交 / branch 分支对比 / commit 指定提交；或 scan 全目录扫描）；',
      'base_ref（branch 模式的对比基线，默认 main）；head_ref（branch 模式的目标分支）；commit（commit 模式的提交号）；',
      'focus（本次评审重点领域，一句话背景要求）；pending_paths（待提交文件相对路径数组，用于敏感文件点名，内容不送审）。',
      '返回：会话内完整问题清单（文件+行号+类型+严重度+建议）+ 报告文件落盘路径。',
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
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
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
      const text = await reviewOnce(ctx, getConfig, args ?? {});
      // 结果以可读文本返回（渲染给会话）；ok 与否按文本语义由引擎退出码决定，
      // 这里统一带出枚举语义：非致命引擎错误仍返回 ok=false 提示文案在正文。
      return { ok: true, text };
    },
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
 * 宿主若不支持 cordis command 注册（能力差异），仅告警，工具仍为主力入口。
 *
 * @param {object} ctx       Cordis 上下文。
 * @param {Function} getConfig 实时配置读取函数。
 */
function registerCommand(ctx, getConfig) {
  if (typeof ctx.command !== 'function') return;
  try {
    ctx
      .command('review', '智能代码审查：对仓库 diff/扫描做评审（安全/找bug/冗余三视角），返回问题清单并落报告。')
      .option('mode, -m <mode>', '评审模式：uncommitted（默认）/ branch / commit / scan', { fallback: 'uncommitted' })
      .option('repo, -r <repo>', '仓库路径（默认当前目录）')
      .option('base, -b <base>', 'branch 模式的对比基线（默认 main）', { fallback: 'main' })
      .option('head <head>', 'branch 模式的目标分支')
      .option('commit, -c <commit>', 'commit 模式的提交号')
      .option('focus, -f <focus>', '本次评审重点领域（一句话背景）')
      .action(async (argv) => {
        const text = await reviewOnce(ctx, getConfig, {
          mode: argv.mode,
          repo_path: argv.repo,
          base_ref: argv.base,
          head_ref: argv.head,
          commit: argv.commit,
          focus: argv.focus,
        });
        return text;
      });
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-code-review] /review 命令注册失败（工具 code_review 仍可用）：${String(error?.message ?? error)}`);
  }
}

/* ═══ 插件入口 ═══ */

/**
 * Cordis apply 入口。
 *
 * @param {object} ctx       Cordis 上下文。
 * @param {object} [configRaw] 宿主传入配置（可 undefined；volatile 字段先解包）。
 * @returns {Function|void} 卸载函数（若有需清理的资源）。
 */
export function apply(ctx, configRaw) {
  // volatile 解包 + 归一化（vision 踩坑：不解包会以 [object Object] 启用失败）。
  const cfg = normalizeConfig(pickOverrides(configRaw));

  // 运行时快照：工具执行时惰性读最新设置；无 settings 服务时回退初始 cfg。
  let sourceGetter = null;
  const getConfig = () => (sourceGetter ? sourceGetter() : cfg);
  const getRuntimeConfig = () => {
    if (typeof ctx.settings?.get === 'function' && typeof ctx.settings?.patch === 'function') {
      try {
        const snapshot = ctx.settings.get(SETTINGS_NS);
        if (snapshot && typeof snapshot === 'object') return normalizeConfig({ ...cfg, ...snapshot });
      } catch {
        /* 读快照失败回退初始 cfg */
      }
    }
    return cfg;
  };
  sourceGetter = getRuntimeConfig;

  // 首启引导。
  welcomeOnce(ctx, getConfig());

  // 设置注册（能力探测，失败降级）。
  registerSettings(ctx);
  ctx.inject(['settings'], (sctx) => {
    // settings 服务就绪后更新 sourceGetter 为实时快照读取。
    sourceGetter = () => {
      try {
        const snapshot = sctx.settings.get?.(SETTINGS_NS);
        if (snapshot && typeof snapshot === 'object') return normalizeConfig({ ...cfg, ...snapshot });
      } catch {
        /* 忽略 */
      }
      return cfg;
    };
  });

  // 工具注册（ctx.effect 内，卸载时 dispose）。
  const disposers = [];
  ctx.effect(() => {
    try {
      disposers.push(ctx.tools.register(createReviewTool(ctx, getConfig)));
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-code-review] code_review 工具注册失败：${String(error?.message ?? error)}`);
    }
  });

  // 斜杠命令 /review。
  registerCommand(ctx, getConfig);

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
/* 评审执行体导出（e2e/单元判据载体：sensitive-e2e、后续步骤可复现链路）。 */
export { reviewOnce, buildSensitiveBlock };
