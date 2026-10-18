// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scripts/switch-model-e2e.mjs —— 判据⑤「切模型也通」实证：
 * 设置面板另选「非会话模型」（异构审查）后，插件管道真实评审跑通。
 *
 * 与 plugin-e2e-smoke 的 session 链路互补：这里显式 resolveProvider(<模型id>)，
 * 证明「选定 ≠ session」路径的端点解析 → key 解析 → env 注入 → 引擎评审
 * 全链路可用；若目标模型带 thinkingFormat=chat-template（vLLM 兼容端点），
 * extraBody 处理也一并走插件逻辑。
 *
 * 模型 id 以本机 DSH 配置为准（即设置面板「评审模型」选择器里的选项）。
 * 用法：node scripts/switch-model-e2e.mjs [模型id]（默认取本机常用验证模型；
 * 真实 API，约 10-40s / 数千 token）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createModelSource, SESSION_MODEL } from '../src/model-provider.js';
import { resolveApiKey, isKeyMissing } from '../src/credentials.js';
import { prepareEngineEnv, runEngine, engineBinName } from '../src/runner.js';

// 默认验证目标：本机 DSH 配置中存在的非会话模型（可按需以命令行参数覆盖）。
// 原 `?? 'session'` 与文件头自述「默认取非会话模型」自相矛盾——无参数运行时
// 走 session 分支，而本脚本以 createModelSource(undefined) 创建（无 ctx，
// currentSessionModel 恒空），target 落到用户配置首条路由，核心主张
// （另选模型可跑通）默认路径从没被验证。改为默认取候选列表首个非 session 项
// （即设置面板「评审模型」选择器里的选项）；候选为空时显式报错
// （配置里一个模型都没有，跑这脚本没有意义）。
// createModelSource 第二参（旧版 ctx 兼容位）已废弃——
// 传 undefined 即可；「session」字面量换成 SESSION_MODEL 常量（与 src 同源，
// 防拼写漂移）。
const src = createModelSource(undefined);
// 候选过滤掉 session 首项，取第一个真实配置模型作为 TARGET。
// 注：历史上还需排除官方兜底路由（source='fallback-deepseek'，路由表全空时
// 恒注入），该兜底已随红线整体移除——现在路由表全空时 listCandidates 只剩
// session 一项，过滤后为空即提示显式传参。
const NON_SESSION = src.listCandidates().filter((c) => c.value !== SESSION_MODEL);
const TARGET = process.argv[2] ?? NON_SESSION[0]?.value;
if (!TARGET) {
  // 原文案硬编码宿主模型适配器标识——违反开源唯一
  // 「不硬编码特定平台」红线（仓库即将发布，内部宿主插件名不进公开源码）。
  // 泛化为零敏感描述。
  console.error('✘ 默认模型列表为空：DSH 模型配置未解析出任何模型。请显式传模型 id。');
  process.exit(1);
}
if (!process.argv[2]) {
  console.log(`注记：未显式传模型 id，取候选列表首个非会话模型 = ${TARGET}`);
}
// exe 后缀只在 win32 生效（平台化）。
// 平台后缀统一从 runner.js 的 engineBinName() 取。
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', engineBinName());
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const ep = src.resolveProvider(TARGET);
check(`${TARGET} 解析出端点`, !!ep, ep ? `${ep.providerLabel}/${ep.model}` : 'null');
check('端点命中用户配置路由（source 非空）', !!ep && !!ep.source, `${ep?.source}/${ep?.resolvedFrom}`);
const key = resolveApiKey(undefined, ep?.keyEnv ?? '', {});
check('该 provider 的 key 可解析', !isKeyMissing(key),
  // 不回显 key 头（与 engine-e2e 同口径，终端/CI 日志存档即泄露面）
  key ? `已找到（${ep?.keyEnv ?? '未指定 keyEnv'}）` : '空');
const prep = prepareEngineEnv({ endpoint: ep, key, timeoutMs: 600_000 });
check('env 注入生效', prep.injected, Object.keys(prep.env).join(','));
if (ep?.extraBody) {
  console.log(`注记：${TARGET} 为 chat-template 端点，插件已带 extraBody 信息（${JSON.stringify(ep.extraBody)}）——引擎 env 通道无 extra_body，直连端点将在本次实证中观察是否受影响。`);
}

const repo = mkdtempSync(join(tmpdir(), 'dcr-switch-'));
try {
  // git 调用带 encoding + 退出码校验：静默失败会让评审跑在未初始化仓库上，
  // 错误形态误导排查（与 engine-e2e / plugin-e2e 同一模式）。
  const gitInit = spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  check('git init 成功', gitInit.status === 0, `status=${gitInit.status}${gitInit.error ? ' ' + gitInit.error.message : ''}`);
  writeFileSync(join(repo, 'a.py'), ['x = 1', ''].join('\n'), 'utf8');
  const gitAdd = spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' });
  check('git add 成功', gitAdd.status === 0, `status=${gitAdd.status}${gitAdd.error ? ' ' + gitAdd.error.message : ''}`);
  const gitCommit = spawnSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@i', 'commit', '-m', 'd'], { encoding: 'utf8' });
  check('git commit 成功', gitCommit.status === 0, `status=${gitCommit.status}${gitCommit.error ? ' ' + gitCommit.error.message : ''}`);
  // 夹具用明显占位口令（不用「真口令形态」的随机串）：测试只关心
  // 「硬编码口令能否被评审识别」，占位串同样能触发，且不会让外部 secret
  // 扫描器误报。
  writeFileSync(join(repo, 'a.py'), ['x = 1', 'password = "NOT-A-PASSWORD-placeholder"  # 未提交硬编码', ''].join('\n'), 'utf8');
  const r = await runEngine({ bin: BIN, args: ['review', '--repo', repo, '--audience', 'agent'], timeoutMs: 180_000, env: prep.env });
  const out = (r.stdout || '') + (r.stderr || '');
  check(`${TARGET} 评审退出码 0`, r.ok, `status=${r.code}`);
  check('输出含评审结论（非 endpoint 报错）', !/no valid LLM endpoint/i.test(out) && !/(^|\n)\s*(error|fail):? /i.test(r.stderr || '') && out.trim().length > 50, `${out.trim().length} 字符`);
  console.log('\n----- 评审输出前 700 字符 -----');
  console.log(out.slice(0, 700));
  console.log('----- 截断说明见上 -----\n');
} catch (err) {
  // runEngine 抛出（spawn 失败/超时/引擎异常）不能让它变成未处理拒绝——
  // 那样会绕过 failures 计数与退出码判定，测试「崩了但报通过」。
  check('主流程无异常（runEngine 不抛）', false, String((err && err.message) || err));
} finally {
  rmSync(repo, { recursive: true, force: true });
  console.log('临时仓库已清理。');
}

if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\n✔ 切模型实证通过：面板另选 ${TARGET}（${ep?.providerLabel}）真实评审跑通`);
}
