/**
 * scripts/sensitive-e2e-smoke.mjs —— 判据⑥「敏感文件点名层」实证：
 * 造一个含 .env 的测试仓库 → 插件全链路评审 → 报告出现点名项。
 *
 * 验证三点：
 *   1. 报告落盘且含「⚠ 敏感文件点名」节；
 *   2. .env（含真实感密钥样例）被点名列入，但**内容不送审**——引擎评审
 *      输出与报告正文不出现 .env 内容/密钥值（即使 .env 内容含危险字符串）；
 *   3. pending_paths 缺省时插件自动收集待提交清单（git），无需用户手工传。
 *
 * 不触碰任何真实仓库（临时目录自建 selfdestruct），不读取真实凭据
 * （key 通道走正规 resolveApiKey，但测试用官方 deepseek-flash 默认评审）。
 *
 * 用法：node scripts/sensitive-e2e-smoke.mjs（真实 API ≈15s）。
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { reviewOnce } from '../src/index.js';
import { listSensitiveFiles } from '../src/sensitive-list.js';

const BIN = fileURLToPath(new URL('../bin/codecheck.exe', import.meta.url));
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
  spawnSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  // 初始提交：app.py（后续有未提交改动作为评审对象）。
  writeFileSync(join(repo, 'app.py'), ['def calc(a, b):', '    return a / b', ''].join('\n'), 'utf8');
  spawnSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@i', 'commit', '-m', 'init'], { stdio: 'ignore' });
  // 待提交清单：一个 .env（跟踪文件之外的 untracked）+ app.py 未提交改动。
  writeFileSync(join(repo, '.env'),
    ['DATABASE_URL=postgres://user:sup3r-s3cret@db.example:5432/prod',
      'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE',
      ''].join('\n'), 'utf8');
  writeFileSync(join(repo, 'app.py'), ['def calc(a, b):', '    return a / b  # 未提交改动：除法未判零', ''].join('\n'), 'utf8');

  /* ---------- 2. 全链路评审（不传 pending_paths，验证自动收集） ---------- */
  const getConfig = () => normalizeConfig({
    engine_bin: BIN,
    report_dir: reportDir,
    review_model: DEFAULT_CONFIG.review_model, // session → 官方默认
    review_timeout_ms: 180_000,
    first_run: false,
  });
  const text = await reviewOnce(undefined, getConfig, { repo_path: repo, mode: 'uncommitted' });
  console.log('\n----- 会话返回文本（点名段可见） -----');
  console.log(text.slice(-1400));
  console.log('----- 截断说明见上 -----\n');

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
  if (candidates.length > 0) {
    reportPath = candidates[0];
    const report = readFileSync(reportPath, 'utf8');
    check('报告含「敏感文件点名」节', report.includes('敏感文件点名'), '命中' );
    check('报告点名 .env（内容未送审的兜底人眼检查点）', report.includes('.env'), '点名项出现');
    // 内容不送审：报告正文不得出现 .env 内容里的真实感密钥值。
    const leaked = ['sup3r-s3cret', 'AKIAIOSFODNN7EXAMPLE'].filter((s) => report.includes(s));
    check('报告未含 .env 内容（密钥值不出现 = 内容未送审）', leaked.length === 0, leaked.join(',') || '无泄露');
    // 引擎评审输出同样不得含密钥值（送审对象只有 app.py diff）。
    const engineOut = text;
    const leakedOut = ['sup3r-s3cret', 'AKIAIOSFODNN7EXAMPLE'].filter((s) => engineOut.includes(s));
    check('引擎输出未含 .env 内容（送审链路也未触碰）', leakedOut.length === 0, leakedOut.join(',') || '无泄露');
  }
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
