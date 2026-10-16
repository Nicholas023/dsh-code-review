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
/**
 * 用例注册表。
 *
 * ⚠ 此处原先写成 `function t(label, fn) { try { fn(); ... } }`——
 * 对 **async 用例**（task-book / review-exec 两例）而言，`fn()` 返回的 Promise 既没被
 * await 也没被 catch，于是：① `✔` 与计数在用例真正跑完**之前**就打印了（"40 项通过"
 * 是虚的）；② 异步体内的异常变成 unhandledRejection 直接崩进程（实测在 task-book
 * 用例的 readdirSync 处抛 ENOENT，且报错堆栈与 console.log 的输出顺序完全对不上）。
 * 改为**先注册、末尾串行 await**：计数真实、异常被收敛、用例之间顺序确定（隔离 env 的
 * 用例不再与后续用例交错）。
 */
const CASES = [];
function t(label, fn) {
  CASES.push({ label, fn });
}

/** 串行跑完全部用例（顺序执行，避免隔离 env 的用例互相交错）。 */
async function runAll() {
  for (const { label, fn } of CASES) {
    try {
      await fn();
      console.log(`✔ ${label}`);
      n += 1;
    } catch (error) {
      console.log(`✘ ${label} —— ${error.message}`);
      process.exitCode = 1;
    }
  }
}

/* ---------- 1. buildReviewArgs ---------- */
t('review/uncommitted 默认：不带 diff 定位参数；未开并发 = 显式单线 --concurrency 1', () => {
  const args = buildReviewArgs({ command: 'review' });
  assert.deepEqual(args, ['review', '--concurrency', '1', '--audience', 'agent']);
});
t('review/branch：--from + --to（head 缺省回退 HEAD）', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'branch', headRef: 'feature/x', baseRef: 'develop' });
  assert.deepEqual(args, ['review', '--from', 'develop', '--to', 'feature/x', '--concurrency', '1', '--audience', 'agent']);
  const args2 = buildReviewArgs({ command: 'review', mode: 'branch', baseRef: 'main' });
  assert.deepEqual(args2, ['review', '--from', 'main', '--to', 'HEAD', '--concurrency', '1', '--audience', 'agent']);
});
t('review/commit：--commit', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'commit', commit: 'abc123' });
  assert.deepEqual(args, ['review', '--commit', 'abc123', '--concurrency', '1', '--audience', 'agent']);
});
t('focus → --background；repo_path → --repo', () => {
  const args = buildReviewArgs({ command: 'review', focus: '查脱敏', repoPath: 'D:/proj' });
  assert.deepEqual(args, ['review', '--repo', 'D:/proj', '--background', '查脱敏', '--concurrency', '1', '--audience', 'agent']);
});
t('scan：--repo + --audience（未开并发 = 单线）', () => {
  const args = buildReviewArgs({ command: 'scan', repoPath: 'D:/proj', focus: 'x' });
  assert.deepEqual(args, ['scan', '--repo', 'D:/proj', '--background', 'x', '--concurrency', '1', '--audience', 'agent']);
});
t('并发开启：默认广度 8（与引擎默认对齐）', () => {
  const args = buildReviewArgs({ command: 'scan', repoPath: '/repo', concurrencyEnabled: true });
  assert.ok(args.includes('--concurrency'));
  assert.equal(args[args.indexOf('--concurrency') + 1], '8');
});
t('并发开启：指定广度 4', () => {
  const args = buildReviewArgs({ command: 'review', mode: 'uncommitted', concurrencyEnabled: true, concurrency: 4 });
  assert.ok(args.includes('--concurrency'));
  assert.equal(args[args.indexOf('--concurrency') + 1], '4');
});
t('并发开启：越界广度钳制（100→32，0→1，非数→8）', () => {
  const clamp = (v) => {
    const a = buildReviewArgs({ command: 'scan', concurrencyEnabled: true, concurrency: v });
    return a[a.indexOf('--concurrency') + 1];
  };
  assert.equal(clamp(100), '32');
  assert.equal(clamp(0), '1');
  assert.equal(clamp(-5), '1');
  assert.equal(clamp('abc'), '8');
});
t('并发关闭/缺省：一律显式 --concurrency 1（防引擎默认 8 漂移）', () => {
  const off = buildReviewArgs({ command: 'scan', concurrencyEnabled: false, concurrency: 12 });
  assert.equal(off[off.indexOf('--concurrency') + 1], '1');
  const absent = buildReviewArgs({ command: 'review', mode: 'commit', commit: 'a' });
  assert.equal(absent[absent.indexOf('--concurrency') + 1], '1');
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
t('敏感命中：token 带分隔符 + 凭据扩展名形态', () => {
  assert.equal(isSensitivePath('refresh_token_backup.json'), true);
  assert.equal(isSensitivePath('config/token_store.yaml'), true);
  assert.equal(isSensitivePath('my-tokens.txt'), true);
});
t('敏感命中：pass 词段 + 凭据扩展名/结尾', () => {
  assert.equal(isSensitivePath('db.pass.yml'), true);
  assert.equal(isSensitivePath('config/pass.txt'), true);
});
t('敏感不命中：业务命名不误伤', () => {
  assert.equal(isSensitivePath('token-utils/parser.js'), false);
  assert.equal(isSensitivePath('tokenization.js'), false);
  assert.equal(isSensitivePath('passenger.json'), false);
  assert.equal(isSensitivePath('pass-through.yml'), false);
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
t('repoNameOf：纯点/空路径回落 repo', () => {
  assert.equal(repoNameOf('.'), 'repo');
  assert.equal(repoNameOf('..'), 'repo');
  assert.equal(repoNameOf(''), 'repo');
});
t('reportFilePath：~ 展开 + 日期分目录 + 仓库名前缀', () => {
  // 本地时间构造（new Date(y, m, d, h, m)）：任何机器时区下「本地日期」都是
  // 若用带偏移/UTC 的字符串构造，在偏西时区会落成前一天/后一
  // 天的本地日期，dateKey 断言随机器时区漂移。
  const now = new Date(2026, 9, 12, 10, 30);
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
  // 并发（默认关（单线）+ 广度默认 8。
  assert.equal(cfg.concurrency_enabled, false);
  assert.equal(cfg.concurrency, 8);
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
t('normalizeConfig：并发开关类型清洗 + 广度钳制 1..32', () => {
  assert.equal(normalizeConfig({ concurrency_enabled: true }).concurrency_enabled, true);
  assert.equal(normalizeConfig({ concurrency_enabled: 'yes' }).concurrency_enabled, false); // 非布尔 → 默认关
  assert.equal(normalizeConfig({ concurrency: 16 }).concurrency, 16);
  assert.equal(normalizeConfig({ concurrency: 100 }).concurrency, 32);   // 上限
  // 口径统一为「≤0 不采纳、回退默认」——
  // 旧断言期待 0 被钳到 1，与 file-config.sanitizePatch 的「非正值剔除」分叉；
  // 同输入两个入口两个结果已裁决为回退默认（面板/工具写入 0 都读回默认 8）。
  assert.equal(normalizeConfig({ concurrency: 0 }).concurrency, 8);      // ≤0 → 默认
  assert.equal(normalizeConfig({ concurrency: 'x' }).concurrency, 8);    // 非数 → 默认
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
// 密闭化：路由来自本机 ~/.dsh/profiles，CI / 新克隆等干净环境无路由。
// 断言对「有路由」与「无路由」两种环境都成立（两条都是红线要求的行为）：
//   - 有用户配置路由 → session/未知模型都回退表首，绝不落官方付费端点；
//   - 无任何路由 → 返回 null（官方付费兜底已移除），由调用方报错并提示配置。
t('createModelSource()：session 无会话上下文 → 表首回退；无路由 → null（绝不落官方付费端点·红线）', () => {
  const src = createModelSource(undefined);
  const hasRoutes = src.listCandidates().length >= 2;
  const ep = src.resolveProvider(SESSION_MODEL);
  if (!hasRoutes) {
    assert.equal(ep, null, '无用户配置路由 → null（红线：不落官方付费端点，由调用方报错）');
    return;
  }
  // 红线：官方付费兜底已整体移除——session 拿不到会话模型时
  // 走 routes 表首（用户配置优先），任何路径都不得隐式落到官方付费端点。
  assert.ok(ep, '有用户配置路由，应解析出端点');
  assert.notEqual(ep.url, DEEPSEEK_OFFICIAL_DEFAULT.url, '不得回退官方付费端点');
  assert.ok(ep.url && ep.model && ep.protocol, '回退端点/模型/协议必非空');
  assert.equal(ep.resolvedFrom, 'fallback', 'session 兜底应标 fallback');
});
t('createModelSource()：未知模型回退表首；无路由 → null（官方兜底已禁用）', () => {
  const src = createModelSource(undefined);
  const hasRoutes = src.listCandidates().length >= 2;
  const ep = src.resolveProvider('no-such-model-xyz');
  if (!hasRoutes) {
    assert.equal(ep, null, '无路由表 → null（官方兜底已禁用）');
    return;
  }
  assert.ok(ep, '有路由表，未知模型应回退表首（非 null）');
  // + 红线：回退优先第一条有 url 的既有路由（保持用户
  // 配置的端点/凭证/协议语义）；**路由表全空返回 null**（旧行为=回官方付费
  // 默认，已移除）——由调用方（review-exec）失败并提示配置，绝不隐式花钱。
  assert.equal(ep.resolvedFrom, 'fallback-from-explicit', '显式选择不存在 → fallback-from-explicit');
  assert.ok(ep.url && ep.model, '回退端点/模型必非空');
  assert.ok(!String(ep.url).includes('api.deepseek.com'), '回退端点不得是官方付费端点');
  assert.ok(
    ['config-deepseek', 'config-alternate'].includes(ep.source),
    `回退 source 应来自既有用户配置路由，实际 ${ep.source}`
  );
});
t('createModelSource()：listCandidates 首项为 session', () => {
  const src = createModelSource(undefined);
  const cands = src.listCandidates();
  assert.ok(cands.length >= 1, `候选至少含 session，实际 ${cands.length}`);
  assert.equal(cands[0].value, SESSION_MODEL);
  assert.ok(cands[0].label.includes('会话'), cands[0].label);
});

/* ---------- 8. credentials（步骤5，纯函数样例） ---------- */
t('parseCredentialsText：refs 段与顶层键均可提取', () => {
  const text = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: key-abc123\n  THIRD_API_KEY: other-key\n';
  assert.equal(parseCredentialsText(text, 'DEEPSEEK_API_KEY'), 'key-abc123');
  assert.equal(parseCredentialsText(text, 'THIRD_API_KEY'), 'other-key');
});
t('parseCredentialsText：深缩进（records 段）不误读', () => {
  // 夹具值去掉 sk- 前缀——仓库公开后 sk- 形态字串
  // 会被外部敏感扫描误报成真实密钥形态（零敏感红线连夹具也不放过）。
  const text = 'records:\n  client-connection/session\n    payload:\n      secret: inner-1\nrefs:\n  DEEPSEEK_API_KEY: key-abc\n';
  // 6 空格缩进的 secret 不应被当成引用名命中（键不存在 → null，与显式空值区分）。
  assert.equal(parseCredentialsText(text, 'secret'), null);
  assert.equal(parseCredentialsText(text, 'DEEPSEEK_API_KEY'), 'key-abc');
});
t('parseCredentialsText：= 与引号变体', () => {
  const text = 'KEY_WITH_EQ=key-x1\nKEY_QUOTED: "key-x2"\n';
  assert.equal(parseCredentialsText(text, 'KEY_WITH_EQ'), 'key-x1');
  assert.equal(parseCredentialsText(text, 'KEY_QUOTED'), 'key-x2');
});
t('parseCredentialsText：键不存在 → null；显式空值 → 空串（两者可区分）', () => {
  assert.equal(parseCredentialsText('OTHER: xyz\n', 'DEEPSEEK_API_KEY'), null);
  assert.equal(parseCredentialsText('DEEPSEEK_API_KEY: ""\n', 'DEEPSEEK_API_KEY'), '');
});

/* ---------- 9. prepareEngineEnv（步骤5） ---------- */
t('prepareEngineEnv：端点和 key 齐备时注入 5 个 OCR_LLM_* 键', () => {
  const prep = prepareEngineEnv({
    endpoint: { url: 'https://api.deepseek.com', protocol: 'openai', model: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY', providerLabel: 'DeepSeek 官方' },
    key: 'key-test',
  });
  assert.ok(prep.injected);
  assert.equal(prep.env.OCR_LLM_URL, 'https://api.deepseek.com');
  assert.equal(prep.env.OCR_LLM_TOKEN, 'key-test');
  assert.equal(prep.env.OCR_LLM_MODEL, 'deepseek-flash');
  assert.equal(prep.env.OCR_LLM_PROTOCOL, 'openai');
  // 数值断言——原 `> '0'` 是字符串首字符比较，
  // '9' > '0' 也通过（'90'、'300' 这类值全部误判），测不出「秒数为正」。
  assert.ok(Number(prep.env.OCR_LLM_TIMEOUT) > 0, `OCR_LLM_TIMEOUT=${prep.env.OCR_LLM_TIMEOUT}`);
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

/* ---------- 7. 后台任务化新增 ---------- */
t('buildReviewArgs：excludePaths → 单个 --exclude 逗号分隔（引擎 --exclude 是单值多模式，重复传只有最后一个生效）', () => {
  const args = buildReviewArgs({ command: 'scan', repoPath: '/repo', excludePaths: ['engine/**', 'dist/**'] });
  // 只允许出现一个 --exclude：引擎侧 --exclude 是单值、逗号分隔多模式语义，不是可重复
  // flag；逐个 push 会让只有最后一个生效（5 个独立 --exclude → 待审 227
  // 个文件，合并成逗号分隔 → 待审 36 个）。
  assert.equal(args.filter((a) => a === '--exclude').length, 1);
  const i = args.indexOf('--exclude');
  assert.equal(args[i + 1], 'engine/**,dist/**');
  // 空串/非字符串项被丢弃；全部为空时不加 --exclude（默认行为不回归）。
  const plain = buildReviewArgs({ command: 'scan', repoPath: '/repo' });
  assert.ok(!plain.includes('--exclude'));
  const blank = buildReviewArgs({ command: 'scan', repoPath: '/repo', excludePaths: ['', '   ', null] });
  assert.ok(!blank.includes('--exclude'));
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
    // 删除原 1.05s 睡眠——睡眠赌「跨秒」本质是
    // 碰运气（边界差几十 ms 就同秒，倒序断言反例），且每次自检白等一秒多；
    // task-api-smoke 已踩同一坑。改为断言排序性质本身：id 按字典序降序
    // （id 以创建时间戳前缀开头），同秒创建时先后无保证但性质恒成立——
    // 「latest first」排序函数是否正确的可观测证据不变，且不再依赖时钟。
    const id2 = tb.enqueueTask({ repoPath: '/r2' });
    const list = tb.listTasks(10);
    const ids = list.map((t) => t.id);
    assert.deepEqual([...ids].sort().reverse(), ids, `列表应按 id 降序：${ids.join(',')}`);
    assert.ok(ids.includes(id2) && ids.includes(id), '两个任务都在列表内');
  } finally {
    process.env.DSH_REVIEW_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

t('review-exec：模块可加载，executeReview 为异步执行函数（后台 serve 与工具共用同一执行体）', async () => {
  // 报告目录隔离到临时目录：执行体失败路径也可能写报告，不能碰用户默认目录。
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const reportTmp = mkdtempSync(join(tmpdir(), 'dcr-review-exec-'));
  try {
    const { executeReview } = await import(new URL('../src/review-exec.js', import.meta.url).href);
    assert.equal(typeof executeReview, 'function');
    const p = executeReview({ repoPath: '/nonexistent-repo-xyz', config: { review_timeout_ms: 30_000, report_dir: reportTmp } });
    assert.ok(p instanceof Promise);
    // executeReview 从不 reject（执行体内错误全部
    // 归一化为 {ok:false,...} 结果对象）——原先 `await p.catch(() => {})` 的
    // catch 是死代码，结果什么都没验。改为断言结果对象 shape：无论 ok 与否
    // 都必须带 ok/code/elapsedSec 等固定字段（仓库不存在 → ok 应为 false，
    // 但不断言具体值——本用例只验函数契约，行为验证归 engine-e2e）。
    const res = await p.catch((error) => ({ ok: false, rejected: String(error) }));
    assert.ok(res && typeof res === 'object', 'executeReview 应返回结果对象');
    assert.equal(typeof res.ok, 'boolean', '结果对象必须带布尔 ok');
    // 结果契约补全断言——code/elapsedSec/timedOut
    // 是 executeReview 固定返回字段（成功/失败/超时路径都有），缺字段 = 契约
    // 漂移立刻暴露（此前只断言 ok，其余字段可静默丢失）。
    // code 只断言「字段存在且为数值或 null」——
    // executeReview 的失败路径（缺 repo_path/引擎未定位/spawn 错/超时）契约
    // 都是 code: null，只有引擎真跑出才给数值；unit 是「确定性模块自检」，
    // 不该隐式依赖本机是否有编译好的引擎二进制（新克隆 / CI 未构建引擎时
    // locateEngineBin 返回 null，code 恒 null）。
    assert.ok('code' in res && (res.code === null || typeof res.code === 'number'), '结果对象必须带 code 字段（数值或 null）');
    assert.equal(typeof res.elapsedSec, 'number', '结果对象必须带数值 elapsedSec（秒）');
    assert.equal(typeof res.timedOut, 'boolean', '结果对象必须带布尔 timedOut');
    // repoPath 空 → 显式失败（不带引擎裸跑 cwd——
    // detached serve 的 cwd 是宿主 profile 目录，裸跑必报伪失败「not a git
    // repository」；显式失败的错误信息引导补参）。
    const pNoRepo = executeReview({ repoPath: '', config: {} });
    const resNoRepo = await pNoRepo.catch((error) => ({ ok: false, rejected: String(error) }));
    assert.equal(resNoRepo.ok, false, '空 repo_path 必须显式失败');
    assert.ok(
      typeof resNoRepo.stderr === 'string' && resNoRepo.stderr.includes('repo_path'),
      '失败信息必须含 repo_path 引导（stderr 实读）'
    );
  } finally {
    rmSync(reportTmp, { recursive: true, force: true });
  }
});

await runAll();
console.log(`\n${n} 项单元自检通过${process.exitCode ? '（有失败）' : '，全部 OK'}`);
