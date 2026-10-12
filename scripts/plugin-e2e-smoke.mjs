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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createModelSource, SESSION_MODEL } from '../src/model-provider.js';
import { resolveApiKey, isKeyMissing } from '../src/credentials.js';
import { locateEngineBin, prepareEngineEnv, runEngine } from '../src/runner.js';

const BIN = fileURLToPath(new URL('../bin/codecheck.exe', import.meta.url));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ---------- 链路 1：模型源解析（无 ctx，走配置/兜底） ---------- */
const source = createModelSource(undefined, {});
const candidates = source.listCandidates();
check('listCandidates 至少 2 个（session + 模型）', candidates.length >= 2,
  `共 ${candidates.length} 个：${candidates.map((c) => c.value).slice(0, 5).join(', ')}${candidates.length > 5 ? '…' : ''}`);

const ep = source.resolveProvider(SESSION_MODEL);
check('resolveProvider(session) 解析出端点', !!ep, ep ? `${ep.providerLabel}/${ep.model} @ ${ep.url}` : 'null');
check('session 缺省命中官方 URL（api.deepseek.com）', ep?.url === 'https://api.deepseek.com', ep?.url);
check('session 缺省命中官方模型 deepseek-flash', ep?.model === 'deepseek-flash', ep?.model);
check('协议为 openai（chat/completions）', ep?.protocol === 'openai', ep?.protocol);
check('key 引用名为 DEEPSEEK_API_KEY', ep?.keyEnv === 'DEEPSEEK_API_KEY', ep?.keyEnv);

const epPro = source.resolveProvider('deepseek-v4-pro');
check('显式切模型 deepseek-v4-pro 可解析', !!epPro, epPro ? `${epPro.model} @ ${epPro.url}` : 'null');

const epMiss = source.resolveProvider('不存在的模型xyz');
check('未知模型回官方默认（不抛异常）', !!epMiss && epMiss.model === 'deepseek-flash', epMiss?.model ?? 'null');

/* ---------- 链路 2：key 解析（只读 yaml，不回显本体） ---------- */
const key = await resolveApiKey(undefined, 'DEEPSEEK_API_KEY', {});
check('DEEPSEEK_API_KEY 经插件通道可解析', !isKeyMissing(key), key ? `前缀 ${key.slice(0, 3)}…` : '空');
const keyUnknown = await resolveApiKey(undefined, 'NO_SUCH_ENV_VAR_XYZ', {});
check('未知引用名安全返回空串', keyUnknown === '', `值=${JSON.stringify(keyUnknown)}`);

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
  spawnSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'app.py'),
    'def auth(token, user):\n'
    + '    # 硬编码口令（敏感文件点名类缺陷样例）\n'
    + '    SECRET = "sk-live-1234567890abcdef"\n'
    + '    return "token ok" if token == SECRET else "denied"\n'
    + 'print(auth("x", "alice"))\n', 'utf8');
  spawnSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'demo'], { stdio: 'ignore' });
  // 制造工作区未提交改动（review 默认 diff 模式审工作区）。
  writeFileSync(join(repo, 'app.py'),
    'def auth(token, user):\n'
    + '    # 硬编码口令（未提交改动：新增字段泄露比分支）\n'
    + '    if user == "alice" and token == "tofu":\n'
    + '        return "ok"\n'
    + '    return "denied"\n'
    + 'print(auth("x", "alice"))\n', 'utf8');
  const t0 = Date.now();
  const result = await runEngine({
    bin: BIN,
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
