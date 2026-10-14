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
const { buildReviewArgs, runEngine, prepareEngineEnv, collectPendingPaths } = await import(new URL('../src/runner.js', import.meta.url).href);
const { isSensitivePath, listSensitiveFiles } = await import(new URL('../src/sensitive-list.js', import.meta.url).href);
const { reportFilePath, repoNameOf } = await import(new URL('../src/report.js', import.meta.url).href);
const { normalizeConfig, DEFAULT_CONFIG } = await import(new URL('../src/config.js', import.meta.url).href);
const { createSettingsSchema } = await import(new URL('../src/settings-schema.js', import.meta.url).href);
const { createModelSource, SESSION_MODEL, DEEPSEEK_OFFICIAL_DEFAULT } = await import(new URL('../src/model-provider.js', import.meta.url).href);
const { parseCredentialsText } = await import(new URL('../src/credentials.js', import.meta.url).href);

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
  assert.deepEqual(args, ['review', '--audience', 'agent']);
});
t('review/branch：--from + --to（head 缺省回退 HEAD）', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'branch', headRef: 'feature/x', baseRef: 'develop' });
  assert.deepEqual(args, ['review', '--from', 'develop', '--to', 'feature/x', '--audience', 'agent']);
  const args2 = buildReviewArgs({ command: 'review', mode: 'branch', baseRef: 'main' });
  assert.deepEqual(args2, ['review', '--from', 'main', '--to', 'HEAD', '--audience', 'agent']);
});
t('review/commit：--commit', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'commit', commit: 'abc123' });
  assert.deepEqual(args, ['review', '--commit', 'abc123', '--audience', 'agent']);
});
t('focus → --background；repo_path → --repo', () => {
  const args = buildReviewArgs({ command: 'review', focus: '查脱敏', repoPath: 'D:/proj' });
  assert.deepEqual(args, ['review', '--repo', 'D:/proj', '--background', '查脱敏', '--audience', 'agent']);
});
t('scan：--repo + --audience', () => {
  const args = buildReviewArgs({ command: 'scan', repoPath: 'D:/proj', focus: 'x' });
  assert.deepEqual(args, ['scan', '--repo', 'D:/proj', '--background', 'x', '--audience', 'agent']);
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
  const schema = createSettingsSchema([{ value: 'test-model-x', label: 'test-model-x' }]);
  assert.ok(schema && (typeof schema === 'function' || typeof schema === 'object'));
});

/* ---------- 7. model-provider（步骤5） ---------- */
t('createModelSource()：session 恒解析为 DeepSeek 官方端点', () => {
  const src = createModelSource(undefined, {});
  const ep = src.resolveProvider(SESSION_MODEL);
  assert.ok(ep, '应解析出端点');
  assert.equal(ep.url, DEEPSEEK_OFFICIAL_DEFAULT.url);
  assert.equal(ep.model, 'deepseek-flash');
  assert.equal(ep.protocol, 'openai');
  assert.equal(ep.keyEnv, 'DEEPSEEK_API_KEY');
  assert.ok(['fallback', 'session', 'config-deepseek'].includes(ep.resolvedFrom), `resolvedFrom=${ep.resolvedFrom}`);
});
t('createModelSource()：未知模型回退官方默认（选中模型失效语义）', () => {
  const src = createModelSource(undefined, {});
  const ep = src.resolveProvider('no-such-model-xyz');
  assert.ok(ep, '未知模型不应返回 null');
  assert.equal(ep.model, 'deepseek-flash');
  assert.equal(ep.url, DEEPSEEK_OFFICIAL_DEFAULT.url);
});
t('createModelSource()：listCandidates 首项为 session', () => {
  const src = createModelSource(undefined, {});
  const cands = src.listCandidates();
  assert.ok(cands.length >= 2, `候选应≥2（session+模型），实际 ${cands.length}`);
  assert.equal(cands[0].value, SESSION_MODEL);
  assert.ok(cands[0].label.includes('会话'), cands[0].label);
});

/* ---------- 8. credentials（步骤5，纯函数样例） ---------- */
t('parseCredentialsText：refs 段与顶层键均可提取', () => {
  const text = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-abc123\n  THIRD_API_KEY: sk-other\n';
  assert.equal(parseCredentialsText(text, 'DEEPSEEK_API_KEY'), 'sk-abc123');
  assert.equal(parseCredentialsText(text, 'THIRD_API_KEY'), 'sk-other');
});
t('parseCredentialsText：深缩进（records 段）不误读', () => {
  const text = 'records:\n  client-connection/session\n    payload:\n      secret: inner-1\nrefs:\n  DEEPSEEK_API_KEY: sk-abc\n';
  // 6 空格缩进的 secret 不应被当成引用名命中。
  assert.equal(parseCredentialsText(text, 'secret'), '');
  assert.equal(parseCredentialsText(text, 'DEEPSEEK_API_KEY'), 'sk-abc');
});
t('parseCredentialsText：= 与引号变体', () => {
  const text = 'KEY_WITH_EQ=sk-x1\nKEY_QUOTED: "sk-x2"\n';
  assert.equal(parseCredentialsText(text, 'KEY_WITH_EQ'), 'sk-x1');
  assert.equal(parseCredentialsText(text, 'KEY_QUOTED'), 'sk-x2');
});
t('parseCredentialsText：缺名安全空串', () => {
  const text = 'OTHER: xyz\n';
  assert.equal(parseCredentialsText(text, 'DEEPSEEK_API_KEY'), '');
});

/* ---------- 9. prepareEngineEnv（步骤5） ---------- */
t('prepareEngineEnv：端点和 key 齐备时注入 5 个 OCR_LLM_* 键', () => {
  const prep = prepareEngineEnv({
    endpoint: { url: 'https://api.deepseek.com', protocol: 'openai', model: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY', providerLabel: 'DeepSeek 官方' },
    key: 'sk-test',
  });
  assert.ok(prep.injected);
  assert.equal(prep.env.OCR_LLM_URL, 'https://api.deepseek.com');
  assert.equal(prep.env.OCR_LLM_TOKEN, 'sk-test');
  assert.equal(prep.env.OCR_LLM_MODEL, 'deepseek-flash');
  assert.equal(prep.env.OCR_LLM_PROTOCOL, 'openai');
  assert.ok(prep.env.OCR_LLM_TIMEOUT > '0');
  assert.ok(prep.note.includes('DeepSeek 官方'));
});
t('prepareEngineEnv：缺 key 不注入（引擎回退自身配置）', () => {
  const prep = prepareEngineEnv({ endpoint: { url: 'https://x.example', protocol: 'openai', model: 'm', keyEnv: 'K', providerLabel: 'X' }, key: '' });
  assert.ok(!prep.injected);
  assert.deepEqual(prep.env, {});
});
t('prepareEngineEnv：timeoutMs 折算为秒（下限 30s）', () => {
  const prep = prepareEngineEnv({ endpoint: { url: 'u', protocol: 'openai', model: 'm', keyEnv: 'K', providerLabel: 'X' }, key: 'k', timeoutMs: 90_000 });
  assert.equal(prep.env.OCR_LLM_TIMEOUT, '90');
  const prep2 = prepareEngineEnv({ endpoint: { url: 'u', protocol: 'openai', model: 'm', keyEnv: 'K', providerLabel: 'X' }, key: 'k', timeoutMs: 5_000 });
  assert.equal(prep2.env.OCR_LLM_TIMEOUT, '30');
});

/* ---------- 10. collectPendingPaths（步骤6，临时 git 仓库） ---------- */
t('collectPendingPaths：untracked+modified 并集（步骤6 待提交清单）', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmpdir(), 'dcr-pp-'));
  try {
    spawnSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    writeFileSync(join(repo, 'tracked.py'), 'x = 1\n', 'utf8');
    spawnSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@i', 'commit', '-m', 'd'], { stdio: 'ignore' });
    writeFileSync(join(repo, 'tracked.py'), 'x = 2\n', 'utf8'); // modified
    writeFileSync(join(repo, 'new.env'), 'K=v\n', 'utf8'); // untracked
    writeFileSync(join(repo, 'ignored.tmp'), 'x\n', 'utf8'); // 在 .gitignore 里 → 不收集
    writeFileSync(join(repo, '.gitignore'), '*.tmp\n', 'utf8');
    const pending = collectPendingPaths(repo);
    assert.deepEqual(pending.sort(), ['.gitignore', 'new.env', 'tracked.py'].sort());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
t('collectPendingPaths：空路径/非 git 目录 → []（点名层静默跳过）', async () => {
  const { tmpdir } = await import('node:os');
  assert.deepEqual(collectPendingPaths(''), []);
  assert.deepEqual(collectPendingPaths(join(tmpdir(), 'no-such-git-repo-xyz')), []);
});

/* ---------- 7. 后台任务化（2026-10-13）新增 ---------- */
t('buildReviewArgs：excludePaths → 每个 --exclude <p>（scan 全仓库时排除引擎目录）', () => {
  const args = buildReviewArgs({ command: 'scan', repoPath: '/repo', excludePaths: ['engine/**', 'dist/**'] });
  assert.ok(args.includes('--exclude'));
  const i = args.indexOf('--exclude');
  assert.equal(args[i + 1], 'engine/**');
  assert.equal(args[i + 3], 'dist/**');
  // 不传 excludePaths 时无 --exclude 尾巴（默认行为不回归）。
  const plain = buildReviewArgs({ command: 'scan', repoPath: '/repo' });
  assert.ok(!plain.includes('--exclude'));
});

t('DEFAULT_CONFIG.review_timeout_ms：进程级兜底放宽到 6 小时（2026-10-13 用户拍板取消严格超时，只防挂死）', () => {
  assert.equal(DEFAULT_CONFIG.review_timeout_ms, 6 * 60 * 60 * 1000);
});

t('task-book：入队/读/更新/列表 状态机 + 原子落盘（隔离目录，不碰生产任务簿）', async () => {
  const { tmpdir } = await import('node:os');
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'dcr-tb-'));
  const prev = process.env.DSH_REVIEW_HOME;
  process.env.DSH_REVIEW_HOME = home;
  try {
    const tb = await import(new URL('../src/task-book.js', import.meta.url).href);
    // enqueueTask 默认字段。
    const id = tb.enqueueTask({ repoPath: '/r', command: 'scan', excludePaths: ['engine/**'] });
    assert.ok(/^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id), `任务 id 格式：${id}`);
    let task = tb.readTask(id);
    assert.equal(task.status, 'queued');
    assert.equal(task.repoPath, '/r');
    assert.equal(task.command, 'scan');
    assert.deepEqual(task.excludePaths, ['engine/**']);
    assert.equal(task.result, null);
    // 原子落盘：任务文件存在且无 .tmp 残留。
    const files = readdirSync(join(home, 'tasks'));
    assert.ok(files.includes(`${id}.json`));
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
    JSON.parse(readFileSync(join(home, 'tasks', `${id}.json`), 'utf8'));
    // updateTask：字段合并 + 状态流转。
    const run = tb.updateTask(id, { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(run.status, 'running');
    assert.equal(run.repoPath, '/r');
    const done = tb.updateTask(id, { status: 'done', result: { ok: true, text: 'ok' } });
    assert.equal(done.status, 'done');
    assert.equal(done.result.ok, true);
    // listTasks：倒序（后创建的排前面）且能读出状态。
    // ⚠ 同一秒内创建的两个任务文件名时间戳前缀相同，字典序由 4 位随机后缀
    //   决定、先后无保证（task-api-smoke 已踩同一坑）——这里等 1.05s 让 id2
    //   的时间戳一定大于 id，倒序断言才稳定。
    await new Promise((r) => setTimeout(r, 1050));
    const id2 = tb.enqueueTask({ repoPath: '/r2' });
    const list = tb.listTasks(10);
    assert.equal(list[0].id, id2);
    assert.equal(list[1].id, id);
  } finally {
    process.env.DSH_REVIEW_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

t('review-exec：模块可加载，executeReview 为异步执行函数（后台 serve 与工具共用同一执行体）', async () => {
  const { executeReview } = await import(new URL('../src/review-exec.js', import.meta.url).href);
  assert.equal(typeof executeReview, 'function');
  const p = executeReview({ repoPath: '/nonexistent-repo-xyz', config: { review_timeout_ms: 30_000 } });
  assert.ok(p instanceof Promise);
  // 引擎在包内 bin/ 时此任务会真实启动引擎（不等待完成）；仅验证函数契约。
  p.catch(() => {});
});

console.log(`\n${n} 项单元自检通过${process.exitCode ? '（有失败）' : '，全部 OK'}`);
