/**
 * scripts/engine-e2e-smoke.mjs —— 判据⑤引擎侧端到端实证：
 * 「默认评审模型（DeepSeek 官方 deepseek-flash，OCR_LLM_* 环境变量注入）
 * 在真实仓库上完成一次代码审查」。
 *
 * 流程（安全卫生：key 只在本进程内存，不落盘、不出现于参数/日志）：
 *   1. 只读解析 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY；
 *   2. 临时目录造一个含已知缺陷的小仓库（未提交改动）;
 *   3. env 注入 OCR_LLM_URL/TOKEN/MODEL/PROTOCOL/TIMEOUT 跑 codecheck
 *      review --repo <tmp> --audience agent；
 *   4. 断言：退出 0 + 输出非空且含审查产物标记；
 *   5. 清理临时仓库。
 *
 * 用法：node scripts/engine-e2e-smoke.mjs（引擎 bin 取 包内 bin/codecheck.exe）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const BIN = join(PKG_ROOT, 'bin', 'codecheck.exe');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ---------- 1. key 解析（不回显本体） ---------- */
const credFile = join(homedir(), '.dsh', '.credentials.yaml');
const key = existsSync(credFile)
  ? readFileSync(credFile, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1]
  : undefined;
check('DEEPSEEK_API_KEY 可解析（.credentials.yaml）', typeof key === 'string' && key.length >= 8, key ? `前缀 ${key.slice(0, 3)}…` : '未找到');

/* ---------- 2. 临时测试仓库 ---------- */
const repo = mkdtempSync(join(tmpdir(), 'dcr-e2e-'));
try {
  spawnSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'demo.py'),
    [
      'def query(user_input):',
      "    # 初始版本：简单拼接",
      '    return "SELECT * FROM users WHERE name = \'" + user_input + "\'"',
      '',
      'print("demo")',
    ].join('\n') + '\n', 'utf8');
  writeFileSync(join(repo, 'README.md'), '# e2e demo repo\n', 'utf8');
  spawnSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  spawnSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'demo'], { stdio: 'ignore' });
  // 制造工作区未提交改动（review 默认 diff 模式审它）。
  writeFileSync(join(repo, 'demo.py'),
    [
      'def query(user_input):',
      "    # SQL 注入（未提交）：用户输入直接拼进查询",
      '    return "SELECT * FROM users WHERE name = \'" + user_input + "\'"',
      '',
      'def risky():',
      '    try:',
      '        return 1 / 0',
      '    except ZeroDivisionError:',
      '        pass  # 吞异常',
      '',
      "print(query(\"' OR '1'='1\"))",
    ].join('\n') + '\n', 'utf8');
  check('临时测试仓库就绪（含未提交缺陷改动）', existsSync(join(repo, '.git')), repo);

  /* ---------- 3. 注入 env 跑真实评审 ---------- */
  if (!existsSync(BIN)) {
    check(`引擎存在（${BIN}）`, false, '请先把 codecheck.exe 放到插件包 bin/');
  } else {
    const env = {
      ...process.env,
      OCR_LLM_URL: 'https://api.deepseek.com',
      OCR_LLM_TOKEN: key,
      OCR_LLM_MODEL: 'deepseek-flash',
      OCR_LLM_PROTOCOL: 'openai',
      OCR_LLM_TIMEOUT: '150',
    };
    const t0 = Date.now();
    const r = spawnSync(BIN, ['review', '--repo', repo, '--audience', 'agent'], {
      encoding: 'utf8',
      env,
      timeout: 180_000,
      windowsHide: true,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const out = (r.stdout || '') + (r.stderr || '');

    check('codecheck review 退出码 0（进程正常完成）', r.status === 0, `status=${r.status}, error=${r.error ?? '无'}`);
    check(`审查输出非空（${secs}s 返回）`, out.trim().length > 50, `输出 ${out.trim().length} 字符`);
    if (out.length > 0) {
      console.log('\n----- 引擎输出前 1400 字符 -----');
      console.log(out.slice(0, 1400));
      console.log('----- 截断说明：完整输出在本会话上方已存档于事件 -----\n');
    }
    // 判据⑤核心：输出必须是「审查产物」（找到问题或明确说没问题），不是报错文案。
    const looksLikeReport =
      /\b(demo\.py|风险|问题|评论|comment|issue|缺陷|BUG|注入|泄露|未发现|无问题|✓ 完成|review complete)\b/i.test(out) && !/no valid LLM endpoint/i.test(out);
    check('输出为审查结果（非配置缺失报错）', looksLikeReport, looksLikeReport ? '命中审查标记' : '未命中审查标记');
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
  console.log(`\n临时仓库已清理${process.platform === 'win32' ? '（libuv fetch 断言与本脚本无关，见 probe 记录）' : ''}`);
}

// 自然退出（process.exit 在 Windows libuv 下可能触发 fetch 句柄断言崩溃）。
if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\n✔ 引擎端到端实证通过：默认评审模型（deepseek-flash）真实审查跑通');
}
