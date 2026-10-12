/**
 * scripts/unit-smoke.mjs —— 确定性模块单元自检（骨架期验证「可观察行为」）。
 *
 * 覆盖（全部判据落盘可核）：
 *   1. buildReviewArgs：diff 三模式 + scan + 重点领域 → 参数组装；
 *   2. isSensitivePath / listSensitiveFiles：敏感模式命中/不命中；
 *   3. reportFilePath：~ 展开、日期分目录、仓库名约定；
 *   4. normalizeConfig：默认值兜底、类型清洗、未知键剔除；
 *   5. runEngine：stdout/stderr/退出码/超时路径（spawn node 自证）。
 *
 * 零敏感：全部用通用样例，不触碰任何真实仓库与配置。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const { buildReviewArgs, runEngine } = await import(new URL('../src/runner.js', import.meta.url).href);
const { isSensitivePath, listSensitiveFiles } = await import(new URL('../src/sensitive-list.js', import.meta.url).href);
const { reportFilePath, repoNameOf } = await import(new URL('../src/report.js', import.meta.url).href);
const { normalizeConfig, DEFAULT_CONFIG } = await import(new URL('../src/config.js', import.meta.url).href);
const { createSettingsSchema } = await import(new URL('../src/settings-schema.js', import.meta.url).href);

let n = 0;
function t(label, fn) {
  try {
    fn();
    console.log(`✔ ${label}`);
    n += 1;
  } catch (error) {
    console.log(`✘ ${label} —— ${error.message}`);
    process.exitCode = 1;
  }
}

/* ---------- 1. buildReviewArgs ---------- */
t('review/uncommitted 默认：不带 diff 定位参数', () => {
  const args = buildReviewArgs({ command: 'review' });
  assert.deepEqual(args, ['review']);
});
t('review/branch：--branch + --base', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'branch', headRef: 'feature/x', baseRef: 'develop' });
  assert.deepEqual(args, ['review', '--branch', 'feature/x', '--base', 'develop']);
});
t('review/commit：--commit', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'commit', commit: 'abc123' });
  assert.deepEqual(args, ['review', '--commit', 'abc123']);
});
t('focus → --background；repo_path → --dir', () => {
  const args = buildReviewArgs({ command: 'review', focus: '查脱敏', repoPath: 'D:/proj' });
  assert.deepEqual(args, ['review', '--background', '查脱敏', '--dir', 'D:/proj']);
});
t('scan：直接收路径', () => {
  const args = buildReviewArgs({ command: 'scan', repoPath: 'D:/proj' });
  assert.deepEqual(args, ['scan', 'D:/proj']);
});

/* ---------- 2. 敏感路径 ---------- */
t('敏感命中：.env / .env.production', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('src/.env.production'), true);
});
t('敏感命中：.ssh/id_rsa、credentials.json、app.pem、token.txt', () => {
  assert.equal(isSensitivePath('.ssh/id_rsa'), true);
  assert.equal(isSensitivePath('deploy/credentials.json'), true);
  assert.equal(isSensitivePath('certs/app.pem'), true);
  assert.equal(isSensitivePath('scripts/api_token.txt'), true);
});
t('敏感不命中：.gitignore、README.md、src/main.go', () => {
  assert.equal(isSensitivePath('.gitignore'), false);
  assert.equal(isSensitivePath('README.md'), false);
  assert.equal(isSensitivePath('src/main.go'), false);
});
t('listSensitiveFiles 混合清单只点名命中项', () => {
  const hits = listSensitiveFiles(['README.md', '.env', 'src/main.go', '.ssh/id_ed25519']);
  assert.deepEqual(hits.map((h) => h.path).sort(), ['.env', '.ssh/id_ed25519'].sort());
});

/* ---------- 3. 报告路径 ---------- */
t('repoNameOf：剥 .git 尾巴', () => {
  assert.equal(repoNameOf('D:/proj/dsh-code-review'), 'dsh-code-review');
  assert.equal(repoNameOf('D:/proj/repo.git'), 'repo');
});
t('reportFilePath：~ 展开 + 日期分目录 + 仓库名前缀', () => {
  const now = new Date('2026-10-12T10:30:00+08:00');
  const p = reportFilePath({ reportDir: '~/reports', repoPath: 'myrepo', now });
  // 绝对路径（~ 已展开到用户主目录）。
  assert.ok(p.includes('myrepo-'), p);
  assert.ok(p.includes('2026-10-12'), p);
  assert.ok(p.startsWith(process.env.USERPROFILE || '/'), p);
  assert.ok(p.endsWith('.md'), p);
});

/* ---------- 4. normalizeConfig ---------- */
t('normalizeConfig：默认值全部兜底', () => {
  const cfg = normalizeConfig(undefined);
  assert.equal(cfg.review_model, DEFAULT_CONFIG.review_model);
  assert.equal(cfg.first_run, true);
  assert.ok(cfg.review_timeout_ms > 0);
});
t('normalizeConfig：类型清洗与未知键剔除', () => {
  const cfg = normalizeConfig({ review_model: 123, engine_bin: '  C:/x/codecheck.exe  ', bogus_key: 1 });
  assert.equal(cfg.review_model, 'session'); // 非字符串 → 默认
  assert.equal(cfg.engine_bin, 'C:/x/codecheck.exe'); // trim
  assert.ok(!('bogus_key' in cfg));
});
t('normalizeConfig：volatile 解包（{value} 形态）', () => {
  const cfg = normalizeConfig({ first_run: { value: false } });
  assert.equal(cfg.first_run, false);
});

/* ---------- 5. runEngine ---------- */
t('runEngine：stdout 收集 + 退出码', async () => {
  const r = await runEngine({ bin: process.execPath, args: ['-e', 'console.log("hello")'], timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('hello'));
});
t('runEngine：stderr 收集 + 非零退出', async () => {
  const r = await runEngine({ bin: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'], timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes('boom'));
});
t('runEngine：超时中（sleep 长于 timeout）', async () => {
  const r = await runEngine({ bin: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.ok(r.timedOut === true, '应标记 timedOut');
});

/* ---------- 6. settings schema 可构造 ---------- */
t('createSettingsSchema() 默认 schema 可构造', () => {
  const schema = createSettingsSchema();
  // koishi schemastery 的 Type 是函数式对象（typeof === 'function'，宿主内部
  // 消费其 .inner/.meta 等元数据渲染表单）；能构造 + 能出描述即证明可用。
  assert.ok(schema, 'schema 应为 truthy');
  assert.ok(typeof schema === 'function' || typeof schema === 'object');
  assert.ok(String(schema.toString()).length > 0);
});
t('createSettingsSchema(带模型列表) 接收选项（步骤5 动态选项位）', () => {
  const schema = createSettingsSchema([{ value: 'review-model-x', label: 'review-model-x' }]);
  assert.ok(schema && (typeof schema === 'function' || typeof schema === 'object'));
});

console.log(`\n${n} 项单元自检通过${process.exitCode ? '（有失败）' : '，全部 OK'}`);
