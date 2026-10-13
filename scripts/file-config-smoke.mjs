/**
 * file-config-smoke.mjs —— file-config.js + set-config-tool.js 单元冒烟。
 *
 * ⚠ 隔离：脚本先行把 DSH_REVIEW_HOME 指向临时目录再动态 import 被测模块
 * （REVIEW_HOME 在模块加载时求值），**绝不触碰真实 ~/.dsh/dsh-code-review/**。
 *
 * 覆盖：读缺失 → {}；写白名单过滤；回读一致；清空字段；原子写无 .tmp 残留；
 * 损坏 JSON 读 {}；set-config-tool 写/查语义。
 *
 * 用法：node scripts/file-config-smoke.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-code-review-fc-'));
process.env.DSH_REVIEW_HOME = tmpRoot;

const {
  readFileConfig,
  writeFileConfig,
  sanitizePatch,
  PLUGIN_CONFIG_FILE,
} = await import('../src/file-config.js');
const { createSetConfigTool, SET_CONFIG_TOOL_NAME } = await import('../src/set-config-tool.js');

let passed = 0;
function ok(name, cond, detail = '') {
  assert.equal(cond, true, `${name}${detail ? ` :: ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ① 文件缺失 → {}
ok('缺失文件读空', JSON.stringify(readFileConfig()) === '{}');

// ② 白名单过滤 + 类型校验
const written = writeFileConfig({ review_model: ' REVIEW_MODEL_A ', bad_key: 99, engine_bin: 123, report_dir: '~/r' });
ok('写入过滤未知键', !('bad_key' in written) && !('engine_bin' in written), JSON.stringify(written));
ok('值 trim 后落盘', written.review_model === 'REVIEW_MODEL_A', JSON.stringify(written));
const onDisk = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, 'utf8'));
ok('回读一致', onDisk.review_model === 'REVIEW_MODEL_A' && onDisk.report_dir === '~/r');
ok('原子写无 tmp 残留', !existsSync(`${PLUGIN_CONFIG_FILE}.tmp`));

// ③ 读回：review_model 在，bad_key/engine_bin 不在
const reread = readFileConfig();
ok('读回含合法覆盖', reread.review_model === 'REVIEW_MODEL_A' && reread.report_dir === '~/r');
ok('读回无非法字段', !('bad_key' in reread) && !('engine_bin' in reread));

// ④ 显式清空字段（null）→ 占位保留、读取可见（normalize 层会回退默认）
writeFileConfig({ review_model: null });
ok('清空后读含 null 占位', readFileConfig().review_model === null);

// ⑤ sanitizePatch 行为
ok('sanitize 空入 { }', JSON.stringify(sanitizePatch(undefined)) === '{}');
ok('sanitize 类型拒绝', JSON.stringify(sanitizePatch({ first_run: 'yes', review_timeout_ms: '6h' })) === '{}');

// ⑥ 损坏 JSON → 读 {}
writeFileConfig({ report_dir: '~/x' });
const { writeFileSync, renameSync } = await import('node:fs');
writeFileSync(PLUGIN_CONFIG_FILE, '{ 坏 JSON !!', 'utf8');
ok('损坏 JSON 读空', JSON.stringify(readFileConfig()) === '{}');

// ⑦ set-config-tool：只查（无参数）→ 不写；带参 → 写并取回生效值
const cfg = readFileConfig(); // 此时损坏文件 → {}
const tool = createSetConfigTool({ logger: { warn: () => {} } }, () => ({ review_model: 'session', report_dir: '~/d', engine_bin: '' }), {
  writeFileConfig,
  PLUGIN_CONFIG_FILE,
});
const query = await tool.execute({}, {});
ok('查询模式 ok', query.ok === true && query.text.includes('配置文件'));
// 重新生成工具（getConfig stub 反映写后重读值）
const tool2 = createSetConfigTool({ logger: { warn: () => {} } }, () => ({ review_model: 'REVIEW_MODEL_B', report_dir: '~/d', engine_bin: '' }), {
  writeFileConfig,
  PLUGIN_CONFIG_FILE,
});
const writeRes = await tool2.execute({ review_model: 'REVIEW_MODEL_B' }, {});
ok('写入模式返回生效值', writeRes.text.includes('REVIEW_MODEL_B'));
ok('写入后文件存在', readFileConfig().review_model === 'REVIEW_MODEL_B');

console.log(`\nfile-config smoke 全过：${passed} 项。`);
rmSync(tmpRoot, { recursive: true, force: true });
