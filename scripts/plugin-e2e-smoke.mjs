// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scripts/plugin-e2e-smoke.mjs —— 判据⑤插件侧端到端实证：
 * 「插件接入位（model-provider → credentials → prepareEngineEnv → runEngine）
 *  在真实仓库上完成一次代码审查」。
 *
 * 与 engine-e2e-smoke.mjs 的区别：不手动拼 OCR_LLM_* env，完全走插件导出函数
 * 链路（createModelSource / resolveApiKey / prepareEngineEnv / runEngine），
 * 证明「宿主不预知端点也能注入」——评审模型解析、key 解析、env 组装的
 * 可观察输出与手动基准（engine-e2e）一致。
 *
 * 用法：node scripts/plugin-e2e-smoke.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createModelSource, SESSION_MODEL } from '../src/model-provider.js';
import { resolveApiKey, isKeyMissing } from '../src/credentials.js';
import { locateEngineBin, prepareEngineEnv, runEngine, engineBinName } from '../src/runner.js';

// exe 后缀只在 win32 生效（平台化）。
// 平台后缀统一从 runner.js 的 engineBinName() 取
// （四处冒烟此前各写一份映射，拷贝会漂移、平台判定单点化）。
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', engineBinName());

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ---------- 链路 1：模型源解析（无 ctx，走配置/兜底） ---------- */
const source = createModelSource(undefined);
const candidates = source.listCandidates();
check('listCandidates 至少 2 个（session + 模型）', candidates.length >= 2,
  `共 ${candidates.length} 个：${candidates.map((c) => c.value).slice(0, 5).join(', ')}${candidates.length > 5 ? '…' : ''}`);

const ep = source.resolveProvider(SESSION_MODEL);
check('resolveProvider(session) 解析出端点', !!ep, ep ? `${ep.providerLabel}/${ep.model} @ ${ep.url}` : 'null');
// session 在无会话上下文时回退到**用户配置的首条路由**（官方付费兜底已移除，
// 不再有「官方默认」这一层）。断言只锁「非官方付费端点 + 端点/模型齐备」，
// 不锁具体 provider——评审模型随用户配置而变。
check('session 缺省命中用户配置路由（非官方付费端点）',
  !!ep && !String(ep.url).includes('api.deepseek.com'), ep?.url);
check('session 缺省解析出模型 id', !!ep?.model, ep?.model);
check('协议字段齐备（openai 兼容）', ep?.protocol === 'openai', ep?.protocol);
check('keyEnv 字段存在（可空 = 本地端点无需凭据）', !!ep && 'keyEnv' in ep, String(ep?.keyEnv));

const epPro = source.resolveProvider('deepseek-v4-pro');
check('显式切模型 deepseek-v4-pro 可解析', !!epPro, epPro ? `${epPro.model} @ ${epPro.url}` : 'null');

const epMiss = source.resolveProvider('不存在的模型xyz');
// 未知模型回退「路由表内第一条可用路由」——本机 profile 恒有 config-deepseek，
// 表非空 → 命中的 source 必是既有配置路由（'config-deepseek' | 'config-alternate'）。
// 『官方兜底路由 fallback-deepseek』这一 source 已随红线整体移除（路由表全空时
// 直接返回 null，由调用方明确报错）；resolvedFrom 标 fallback-from-explicit。
// 不锁死具体模型/端点（回退目标随配置变）。
check('未知模型回退既有路由（不抛异常）',
  !!epMiss && !!epMiss.url && (epMiss.source === 'config-deepseek' || epMiss.source === 'config-alternate'),
  epMiss ? `${epMiss.resolvedFrom} → ${epMiss.model}（source=${epMiss.source}）` : 'null');

/* ---------- 链路 2：key 解析（只读 yaml，不回显本体） ---------- */
const key = resolveApiKey(undefined, 'DEEPSEEK_API_KEY', {});
check('DEEPSEEK_API_KEY 经插件通道可解析', !isKeyMissing(key),
  // 不回显 key 前缀（与 engine-e2e 同口径，日志存档不泄真实密钥字符）
  key ? '已找到' : '空');
// 未找到 → null（键不存在），与「键存在但空值 → ''」区分；统一用 isKeyMissing 判定。
const keyUnknown = resolveApiKey(undefined, 'NO_SUCH_ENV_VAR_XYZ', {});
check('未知引用名安全返回 null（键不存在）', isKeyMissing(keyUnknown) && keyUnknown === null, `值=${JSON.stringify(keyUnknown)}`);

/* ---------- 链路 3：env 组装 + 真实评审 ---------- */
const located = locateEngineBin({ engine_bin: BIN });
check('引擎经设置 engine_bin 定位', !!located, located ? located.bin : 'null');

const prep = prepareEngineEnv({ endpoint: ep, key, timeoutMs: 600_000 });
const envKeys = Object.keys(prep.env).sort().join(', ');
check('prepareEngineEnv 注入 5 个 OCR_LLM_* 键', prep.injected && prep.env.OCR_LLM_URL && prep.env.OCR_LLM_TOKEN && prep.env.OCR_LLM_MODEL && prep.env.OCR_LLM_PROTOCOL && prep.env.OCR_LLM_TIMEOUT, envKeys);
check('注入的 URL/模型与解析结果一致', prep.env.OCR_LLM_URL === ep.url && prep.env.OCR_LLM_MODEL === ep.model);

/* ---------- 链路 4：真实仓库评审（插件管道 vs 手动基准等价性） ---------- */
const repo = mkdtempSync(join(tmpdir(), 'dcr-plugin-e2e-'));
try {
  // git/spawn 失败不静默——init/add/commit 任一失败立即
  // 报材料失败（仓库无基线时后续断言会因错误原因通过/失败）。
  const gitInit = spawnSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  if (gitInit.status !== 0) {
    check('git init 成功', false, `status=${gitInit.status}${gitInit.error ? ' error=' + gitInit.error.message : ''}`);
  }
  writeFileSync(join(repo, 'app.py'),
    'def auth(token, user):\n'
    + '    # 硬编码口令（敏感文件点名类缺陷样例）\n'
    // 夹具换显式假值——前缀形态（密钥扫描器通用命中规则）
    // 会被密钥扫描/推送保护误报，也向仓库示范了坏实践；显式假值对评审模型
    // 同样是「像泄露密钥」的靶子，对扫描器却是显然的占位。
    // 伪造值改用完全不带密钥前缀的字串——密钥形态前缀
    // 本身就是各扫描器通用命中规则，占位语义不变，零误报残留。
    + '    SECRET = "NOT-A-KEY-placeholder-0000"\n'
    + '    return "token ok" if token == SECRET else "denied"\n'
    + 'print(auth("x", "alice"))\n', 'utf8');
  // #2 只捕获了 init/commit，add 仍裸跑——add 失败（索引
  // 写不进）时 commit 会带上遗漏文件，基线残缺导致后续 diff 断言失真。与
  // init/commit 同款三连校验。
  const gitAdd = spawnSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  if (gitAdd.status !== 0) {
    check('git add 成功（暂存基线）', false, `status=${gitAdd.status}${gitAdd.error ? ' error=' + gitAdd.error.message : ''}`);
  }
  const gitCommit = spawnSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'demo'], { stdio: 'ignore' });
  if (gitCommit.status !== 0) {
    check('git commit 成功（含提交基线）', false, `status=${gitCommit.status}${gitCommit.error ? ' error=' + gitCommit.error.message : ''}`);
  }
  // 制造工作区未提交改动（review 默认 diff 模式审工作区）。
  writeFileSync(join(repo, 'app.py'),
    'def auth(token, user):\n'
    + '    # 硬编码口令（未提交改动：新增字段泄露比分支）\n'
    + '    if user == "alice" and token == "tofu":\n'
    + '        return "ok"\n'
    + '    return "denied"\n'
    + 'print(auth("x", "alice"))\n', 'utf8');
  const t0 = Date.now();
  // 真用 locateEngineBin 的结果——此前上方「引擎经设置
  // engine_bin 定位」断言了 located 却仍在 `bin: BIN` 传硬编码常量，
  // 「设置 engine_bin 定位」路径从没被真正走到。
  // 行号引用改为相对描述，避免断言行移动后失联。
  const result = await runEngine({
    bin: located?.bin ?? BIN,
    args: ['review', '--repo', repo, '--audience', 'agent'],
    timeoutMs: 180_000,
    env: prep.env,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (result.stdout || '') + (result.stderr || '');
  check('codecheck review 退出码 0', result.ok, `status=${result.code}`);
  check(`审查输出非空（${secs}s）`, out.trim().length > 50, `${out.trim().length} 字符`);
  const found = /app\.py/.test(out);
  check('输出含被审文件名 app.py（插件管道真实送达）', found, found ? '命中' : '未命中');
  console.log('\n----- 插件管道评审输出前 800 字符 -----');
  console.log(out.slice(0, 800));
  console.log('----- 截断说明见上 -----\n');
} catch (err) {
  // runEngine/文件操作抛异常不再逃逸——原结构异常会绕过
  // 下方 failures 汇总与退出码，脚本以 unhandled rejection 结束且无结论；
  // 现在记为失败项并继续走收尾（清理 repo、统一退出码）。
  check('主流程无异常（runEngine 不抛）', false, String((err && err.message) || err));
} finally {
  rmSync(repo, { recursive: true, force: true });
  console.log('临时仓库已清理。');
}

if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\n✔ 插件侧端到端实证通过：plugin 注入位（模型解析→key→env→评审）全链路跑通');
}
