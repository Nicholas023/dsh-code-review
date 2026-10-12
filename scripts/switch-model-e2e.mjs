/**
 * scripts/switch-model-e2e.mjs —— 判据⑤「切模型也通」实证：
 * 设置面板另选 （异构审查，DSH  cucc provider）后，
 * 插件管道真实评审跑通。
 *
 * 与 plugin-e2e-smoke 的 session 链路互补：这里显式 resolveProvider('REVIEW_MODEL_A')，
 * 证明「选定 ≠ session」路径的端点解析 → key 解析 → env 注入 → 引擎评审
 * 全链路可用； 带 thinkingFormat=chat-template（vLLM 兼容端点），
 * extraBody 处理也一并走插件逻辑。
 *
 * 用法：node scripts/switch-model-e2e.mjs [模型id]（默认 ；真实 API，
 * 约 10-40s / 数千 token）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createModelSource } from '../src/model-provider.js';
import { resolveApiKey, isKeyMissing } from '../src/credentials.js';
import { prepareEngineEnv, runEngine } from '../src/runner.js';

const TARGET = process.argv[2] ?? 'REVIEW_MODEL_A';
const BIN = fileURLToPath(new URL('../bin/codecheck.exe', import.meta.url));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const src = createModelSource(undefined, {});
const ep = src.resolveProvider(TARGET);
check(`${TARGET} 解析出端点`, !!ep, ep ? `${ep.providerLabel}/${ep.model}` : 'null');
check('端点非官方兜底（确实命中配置 provider）', !!ep && ep.source !== 'fallback-deepseek', `${ep?.source}/${ep?.resolvedFrom}`);
const key = await resolveApiKey(undefined, ep?.keyEnv ?? '', {});
check('该 provider 的 key 可解析', !isKeyMissing(key), key ? `前缀 ${key.slice(0, 3)}…（${ep?.keyEnv}）` : '空');
const prep = prepareEngineEnv({ endpoint: ep, key, timeoutMs: 600_000 });
check('env 注入生效', prep.injected, Object.keys(prep.env).join(','));
if (ep?.extraBody) {
  console.log(`注记：${TARGET} 为 chat-template 端点，插件已带 extraBody 信息（${JSON.stringify(ep.extraBody)}）——引擎 env 通道无 extra_body，直连端点将在本次实证中观察是否受影响。`);
}

const repo = mkdtempSync(join(tmpdir(), 'dcr-switch-'));
try {
  spawnSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'a.py'), ['x = 1', ''].join('\n'), 'utf8');
  spawnSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@i', 'commit', '-m', 'd'], { stdio: 'ignore' });
  writeFileSync(join(repo, 'a.py'), ['x = 1', 'password = "P@ssw0rd123"  # 未提交硬编码', ''].join('\n'), 'utf8');
  const r = await runEngine({ bin: BIN, args: ['review', '--repo', repo, '--audience', 'agent'], timeoutMs: 180_000, env: prep.env });
  const out = (r.stdout || '') + (r.stderr || '');
  check(`${TARGET} 评审退出码 0`, r.ok, `status=${r.code}`);
  check('输出含评审结论（非 endpoint 报错）', !/no valid LLM endpoint/i.test(out) && !/(^|\n)\s*(error|fail):? /i.test(r.stderr || '') && out.trim().length > 50, `${out.trim().length} 字符`);
  console.log('\n----- 评审输出前 700 字符 -----');
  console.log(out.slice(0, 700));
  console.log('----- 截断说明见上 -----\n');
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
