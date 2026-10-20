// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scripts/sensitive-e2e-smoke.mjs —— 判据⑥「敏感文件点名层」实证：
 * 造一个含 .env 的测试仓库 → 插件全链路评审 → 报告出现点名项。
 *
 * 验证三点：
 *   1. 报告落盘且含「⚠ 敏感文件点名」节；
 *   2. .env（含占位串样例）被点名列入，但**内容不送审**——引擎评审
 *      输出与报告正文不出现 .env 内容/密钥值（即使 .env 内容含危险字符串）；
 *   3. pending_paths 缺省时插件自动收集待提交清单（git），无需用户手工传。
 *
 * 不触碰任何真实仓库（临时目录自建 selfdestruct），不读取真实凭据
 * （key 通道走正规 resolveApiKey；评审模型取配置默认值 session）。
 *
 * 用法：node scripts/sensitive-e2e-smoke.mjs（真实 API ≈15s）。
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { reviewOnce } from '../src/index.js';
import { listSensitiveFiles } from '../src/sensitive-list.js';
import { engineBinName } from '../src/runner.js';

// 按平台解析引擎可执行文件名（与 src/runner.js 同一口径）——
// 原硬编码 codecheck.exe 在 Linux/macOS（含 GitHub Actions ubuntu runner）必然
// 文件不存在而失败；发布到 GitHub 的仓库必须可在 CI 平台跑。
// 平台后缀统一从 runner.js 的 engineBinName() 取。
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', engineBinName());
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ---------- 0. 确定性前验：点名层本身 ---------- */
const hits = listSensitiveFiles(['README.md', '.env', 'src/app.js', 'deploy/credentials.json']);
check('listSensitiveFiles 点名 .env/credentials.json，不点名 README/app.js',
  hits.map((h) => h.path).sort().join(',') === '.env,deploy/credentials.json',
  hits.map((h) => h.path).join(','));

/* ---------- 1. 造含 .env 的测试仓库 ---------- */
const work = mkdtempSync(join(tmpdir(), 'dcr-sensitive-'));
const repo = join(work, 'demo-repo');
const reportDir = join(work, 'reports');
let reportPath = '';
try {
  // git 调用一律带 encoding 并校验退出码：静默失败（git 未装/-b 不支持）会让
  // 后续评审在「未初始化的仓库」上跑，报错形态误导排查方向。
  const gitInit = spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  check('git init 成功', gitInit.status === 0, `status=${gitInit.status}${gitInit.error ? ' ' + gitInit.error.message : ''}`);
  // 初始提交：app.py（后续有未提交改动作为评审对象）。
  writeFileSync(join(repo, 'app.py'), ['def calc(a, b):', '    return a / b', ''].join('\n'), 'utf8');
  const gitAdd = spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' });
  check('git add 成功', gitAdd.status === 0, `status=${gitAdd.status}${gitAdd.error ? ' ' + gitAdd.error.message : ''}`);
  const gitCommit = spawnSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@i', 'commit', '-m', 'init'], { encoding: 'utf8' });
  check('git commit 成功', gitCommit.status === 0, `status=${gitCommit.status}${gitCommit.error ? ' ' + gitCommit.error.message : ''}`);
  // 待提交清单：一个 .env（跟踪文件之外的 untracked）+ app.py 未提交改动。
  // 夹具值用明显占位串（不用真实形态的密钥前缀/AWS 示例 key）——测试只断言
  // 「.env 内容未出现在报告里」，不依赖值的格式；用 AKIA… 这类会被外部
  // secret 扫描器误报，给仓库公开流程添噪声。
  writeFileSync(join(repo, '.env'),
    ['DATABASE_URL=postgres://user:EXAMPLE_PLACEHOLDER@db.example:5432/prod',
      'AWS_SECRET_ACCESS_KEY=EXAMPLE_NOT_A_REAL_KEY_12345',
      ''].join('\n'), 'utf8');
  writeFileSync(join(repo, 'app.py'), ['def calc(a, b):', '    return a / b  # 未提交改动：除法未判零', ''].join('\n'), 'utf8');

  /* ---------- 2. 全链路评审（不传 pending_paths，验证自动收集） ---------- */
  const getConfig = () => normalizeConfig({
    engine_bin: BIN,
    report_dir: reportDir,
    review_model: DEFAULT_CONFIG.review_model, // session → 会话当前模型/用户配置首条路由
    review_timeout_ms: 180_000,
    first_run: false,
  });
  const text = await reviewOnce(undefined, getConfig, { repo_path: repo, mode: 'uncommitted' });
  // 显式断言非空：评审静默失败（返回 null/空串且未落报告）时，后续报告文件
  // 检查可能整体跳过 → 零失败项假绿。先把「有输出」钉成一条判据。
  check('评审返回非空文本', typeof text === 'string' && text.length > 0, text ? `${text.length} 字符` : '(空)');
  // 评审输出原样打日志会泄出被审仓库代码片段/评审内容，
  // 将来审到真实敏感文件时日志即泄露渠道——默认只打摘要，DEBUG_SMOKE=1 才全量。
  if (process.env.DEBUG_SMOKE) {
    console.log('\n----- 会话返回文本（点名段可见；DEBUG_SMOKE 开启时全量） -----');
    console.log(text.slice(-1400));
    console.log('----- 截断说明见上 -----\n');
  } else {
    console.log('（评审返回 ' + (text ? text.length : 0) + ' 字符；DEBUG_SMOKE=1 可展开全文）');
  }

  /* ---------- 3. 报告落盘 + 点名断言 ---------- */
  const candidates = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.md')) candidates.push(p);
    }
  };
  if (existsSync(reportDir)) walk(reportDir);
  check('报告文件已落盘（按日期/仓库分目录）', candidates.length >= 1, candidates[0] ?? '无');
  // 内容不送审的探针串（issue #22：断言从 candidates 嵌套中提出——
  // 断言值必须与上方写入 .env 的夹具**同一串**（改夹具不改断言 = 断言恒真假绿）。
  const envProbes = ['EXAMPLE_PLACEHOLDER', 'EXAMPLE_NOT_A_REAL_KEY_12345'];
  if (candidates.length > 0) {
    reportPath = candidates[0];
    const report = readFileSync(reportPath, 'utf8');
    check('报告含「敏感文件点名」节', report.includes('敏感文件点名'), '命中' );
    check('报告点名 .env（内容未送审的兜底人眼检查点）', report.includes('.env'), '点名项出现');
    const leaked = envProbes.filter((s) => report.includes(s));
    check('报告未含 .env 内容（密钥值不出现 = 内容未送审）', leaked.length === 0, leaked.join(',') || '无泄露');
  }
  // 引擎输出泄露断言**不嵌套在** candidates.length > 0 内（issue #22）：
  // reviewOnce 静默失败（报告未落盘）时此断言也必须执行——评审失败本身由
  // 上方「评审返回非空文本」判据显式记录，杜绝「评审失败 → 整段跳过 → 假绿」。
  // text 为空/非字符串时 includes 恒 false = 无泄露，断言仍给出可观察结论。
  const engineOut = typeof text === 'string' ? text : '';
  const leakedOut = envProbes.filter((s) => engineOut.includes(s));
  check('引擎输出未含 .env 内容（送审链路也未触碰）', leakedOut.length === 0, leakedOut.join(',') || '无泄露');
} finally {
  rmSync(work, { recursive: true, force: true });
  console.log('临时仓库/报告目录已清理。');
}

if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\n✔ 判据⑥实证通过：含 .env 测试仓库 → 报告点名项出现，内容不送审');
}
