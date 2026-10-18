// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

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
const { createSetConfigTool } = await import('../src/set-config-tool.js');
// SET_CONFIG_TOOL_NAME 死导入已移除（本脚本只用工厂，不
// 需要工具名常量；常量在 src/set-config-tool.js 有定义即足够）。

let passed = 0;
function ok(name, cond, detail = '') {
  assert.equal(cond, true, `${name}${detail ? ` :: ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 测试体套 try/finally：任一条断言失败（assert 抛错）或
// 文件读取/JSON.parse 抛异常时，finally 同样执行清理——此前 rmSync 只在全部
// 断言通过后执行，失败路径会泄漏临时目录。
try {
// ① 文件缺失 → {}
ok('缺失文件读空', JSON.stringify(readFileConfig()) === '{}');

// ② 白名单过滤 + 类型校验
const written = writeFileConfig({ review_model: ' test-model-a ', bad_key: 99, engine_bin: 123, report_dir: '~/r' });
ok('写入过滤未知键', !('bad_key' in written) && !('engine_bin' in written), JSON.stringify(written));
ok('值 trim 后落盘', written.review_model === 'test-model-a', JSON.stringify(written));
const onDisk = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, 'utf8'));
ok('回读一致', onDisk.review_model === 'test-model-a' && onDisk.report_dir === '~/r');
ok('原子写无 tmp 残留', !existsSync(`${PLUGIN_CONFIG_FILE}.tmp`));

// ③ 读回：review_model 在，bad_key/engine_bin 不在
const reread = readFileConfig();
ok('读回含合法覆盖', reread.review_model === 'test-model-a' && reread.report_dir === '~/r');
ok('读回无非法字段', !('bad_key' in reread) && !('engine_bin' in reread));

// ④ 显式清空字段（null）→ 占位保留、读取可见（normalize 层会回退默认）
writeFileConfig({ review_model: null });
ok('清空后读含 null 占位', readFileConfig().review_model === null);

// ⑤ sanitizePatch 行为
ok('sanitize 空入 { }', JSON.stringify(sanitizePatch(undefined)) === '{}');
ok('sanitize 类型拒绝', JSON.stringify(sanitizePatch({ first_run: 'yes', review_timeout_ms: '6h' })) === '{}');

// ⑥ 损坏 JSON → 读 {}
writeFileConfig({ report_dir: '~/x' });
// renameSync 死解构已删（本脚本只 import 实际使用的
// writeFileSync；改名由 src/file-config.js 内部负责，这里造坏文件不需要）。
const { writeFileSync } = await import('node:fs');
writeFileSync(PLUGIN_CONFIG_FILE, '{ 坏 JSON !!', 'utf8');
ok('损坏 JSON 读空', JSON.stringify(readFileConfig()) === '{}');

// ⑦ set-config-tool：只查（无参数）→ 不写；带参 → 写并取回生效值
// 断言由宽松文本匹配改为结构化事实——
//   a) 查询模式不写盘：注入的 writeFileConfig 打计数，查询后必须 0 次调用；
//   b) 写入模式恰好 1 次写盘且文件回读即为新值（持久化真实生效）。
let writeCalls = 0;
// stub 必须保持与生产 writeFileConfig 相同的**同步**
// 契约——async 包装会把写盘抛错变成 rejected promise 而非同步 throw：
// set-config-tool 的同步 try/catch 接不住，wrote 仍置 true（报告 ok:true 实际
// 没写），失败路径被静默击穿；同步 stub 才能测到真实失败路径。
const countingWrite = (...args) => { writeCalls += 1; return writeFileConfig(...args); };
const tool = createSetConfigTool({ logger: { warn: () => {} } }, () => ({ review_model: 'session', report_dir: '~/d', engine_bin: '' }), {
  writeFileConfig: countingWrite,
  PLUGIN_CONFIG_FILE,
});
const query = await tool.execute({}, {});
// 文案以「- 评审模型：`...`」结构行列出当前生效值（set-config-tool 输出契约）。
ok('查询模式 ok 且列出生效配置', query.ok === true && typeof query.text === 'string' && query.text.includes('- 评审模型：'), query.ok ? String(query.text.length) + ' 字符' : '');
ok('查询模式不写盘（无副作用）', writeCalls === 0, `writeCalls=${writeCalls}`);
// 重新生成工具（getConfig stub 反映写后重读值）
const tool2 = createSetConfigTool({ logger: { warn: () => {} } }, () => ({ review_model: 'test-model-b', report_dir: '~/d', engine_bin: '' }), {
  writeFileConfig: countingWrite,
  PLUGIN_CONFIG_FILE,
});
const writeRes = await tool2.execute({ review_model: 'test-model-b' }, {});
ok('写入模式返回生效值', typeof writeRes.text === 'string' && writeRes.text.includes('test-model-b'));
ok('写入模式恰好一次落盘', writeCalls === 1, `writeCalls=${writeCalls}`);
ok('写入后文件回读即新值（持久化生效）', readFileConfig().review_model === 'test-model-b');
} finally {
  // 环境复原 + 临时目录清理（无论成败）
  delete process.env.DSH_REVIEW_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\nfile-config smoke 全过：${passed} 项。`);
