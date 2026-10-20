// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * scripts/engine-e2e-smoke.mjs —— 判据⑤引擎侧端到端实证：
 * 「评审模型（用户配置的端点，经 OCR_LLM_* 环境变量注入）
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
 * 用法：node scripts/engine-e2e-smoke.mjs（引擎 bin 取 包内 bin/，平台后缀由
 * runner.js 的 engineBinName() 决定——与 sensitive-e2e 同款平台化）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { engineBinName } from '../src/runner.js';

// PKG_ROOT 用 dirname(fileURLToPath()) 一次解出脚本
// 所在目录，再上一级到包根——此前 join(fileURLToPath(import.meta.url), '..',
// '..') 把「脚本文件路径 + 两级 ..」当目录拼接，等价但与 dirname 语义重复。
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// codecheck.exe 硬编码在 Linux/macOS（含 CI
// runner）必然 NotFound——平台化的 exe 后缀只在 win32 生效，与 sensitive-e2e
// 修法保持一致。
// 平台后缀统一从 runner.js 的 engineBinName() 取
// （曾在 4 份冒烟各写一份映射，拷贝会漂移），这里只拼接包 bin/ 路径。
const BIN = join(PKG_ROOT, 'bin', engineBinName());

/** 平台判定单点（避免脚本内散落内联 process.platform 比较——风格红线）。 */
const IS_WIN = process.platform === 'win32';

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
check('DEEPSEEK_API_KEY 可解析（.credentials.yaml）', typeof key === 'string' && key.length >= 8,
  // 绝不回显 key 本体/前缀——终端与 CI 日志会被复制存档，
  // 任何真实密钥字符都不得出现；只报告「是否可解析」。
  key ? `已找到（${key.length} 字符）` : '未找到');

/* ---------- 2. 临时测试仓库 ---------- */
const repo = mkdtempSync(join(tmpdir(), 'dcr-e2e-'));
try {
  // git 初始化/提交结果逐一捕获——git 缺失、版本不支持
  // `-b`、缺 user.name 等失败此前被静默吞掉，仓库实际无提交基线，后续断言会
  // 因错误原因通过/失败且无诊断。捕获 stdout/stderr（encoding: 'utf8'），
  // stdio: 'ignore' 会把 stderr 整个丢弃、error 字段
  // 也拿不到——三个 git 调用全部捕获，失败时逐一列在诊断里（此前只报 commit
  // 一步，git 整体缺失时把原因错怪给 commit）。
  const gitInit = spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  writeFileSync(join(repo, 'demo.py'),
    [
      'def query(user_input):',
      "    # 初始版本：简单拼接",
      '    return "SELECT * FROM users WHERE name = \'" + user_input + "\'"',
      '',
      'print("demo")',
    ].join('\n') + '\n', 'utf8');
  writeFileSync(join(repo, 'README.md'), '# e2e demo repo\n', 'utf8');
  const gitAdd = spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' });
  const gitCommit = spawnSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'demo'], { encoding: 'utf8' });
  check('git init/add/commit 全部成功（已提交基线）',
    gitInit.status === 0 && gitAdd.status === 0 && gitCommit.status === 0,
    // 三路 stderr 全部聚合进诊断——老版本 git 不
    // 支持 `init -b`、add 索引/权限失败、`not a git repository` 都写在各自
    // stderr 而 error 字段为空；只带回 commit.stderr 会只剩 `init=129` 无原因。
    `init=${gitInit.status}, add=${gitAdd.status}, commit=${gitCommit.status}` +
    `${(gitInit.stderr || '').trim() ? ' initStderr=' + (gitInit.stderr || '').trim() : ''}` +
    `${(gitAdd.stderr || '').trim() ? ' addStderr=' + (gitAdd.stderr || '').trim() : ''}` +
    `${(gitCommit.stderr || '').trim() ? ' commitStderr=' + (gitCommit.stderr || '').trim() : ''}` +
    `${gitInit.error ? ' initError=' + gitInit.error.message : ''}` +
    `${gitAdd.error ? ' addError=' + gitAdd.error.message : ''}` +
    `${gitCommit.error ? ' commitError=' + gitCommit.error.message : ''}`);
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
    // 提示不再硬编码 codecheck.exe——平台化路径由
    // BIN 计算得出，提示直接引用它（Linux/macOS 上出现 .exe 字面会误导）。
    check(`引擎存在（${BIN}）`, false, `请先把引擎二进制放到插件包 bin/（预期 ${BIN}）`);
  } else if (typeof key !== 'string' || key.length === 0) {
    // issue #22：key 未解析（无 .credentials.yaml / 未配置 DEEPSEEK_API_KEY）时，
    // 此前仍把 undefined 塞进 OCR_LLM_TOKEN → spawn 成字面量 'undefined'，引擎
    // 拿它空等 180s 必败且无明确归因。显式短路跳过引擎调用，并输出明确 check
    // （无 key 环境下跑 e2e 是「预期跳过」形态，不是挂死也不是假失败）。
    check('codecheck review（需 DEEPSEEK_API_KEY）', false, '跳过引擎调用（key 缺失）——本机未配置评审凭据，引擎实证无法执行');
  } else {
    const env = {
      ...process.env,
      OCR_LLM_URL: 'https://api.deepseek.com',
      OCR_LLM_TOKEN: key,
      OCR_LLM_MODEL: 'deepseek-flash',
      OCR_LLM_PROTOCOL: 'openai',
      OCR_LLM_TIMEOUT: '150', // 引擎侧 LLM 超时（秒）；外层 spawnSync timeout 为 180_000ms（毫秒），两者单位不同勿混
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
    // 中文关键词不包 \b（\b 是 ASCII 词边界，中文非 \w 字符，
    // `\b风险\b` 在纯中文文本里永不匹配 = 死分支）；英文关键词保留 \b 收紧
    // （comment/issue/BUG 等普通词需要词边界，避免报错文案被误判为审查产物）。
    // 中英负向双过滤：仅有英文 `no valid LLM endpoint` 不够——引擎的中文报错
    // 文案可能含「未发现…」等与审查产物同形的词，会被正向分支误命中。
    const hasStrongSignal = /(demo\.py|✓ 完成|review complete)/i.test(out);
    // 变量名不含「Chinese」——正则同时含英文关键词（comment/issue/BUG）。
    const hasReviewKeyword = /(风险|问题|评论|缺陷|注入|泄露|未发现|无问题|\bcomment\b|\bissue\b|\bBUG\b)/i.test(out);
    const looksLikeEndpointError = /no valid LLM endpoint|未发现.*(端点|配置)|配置缺失|连接失败|LLM 端点/i.test(out);
    const looksLikeReport = (hasStrongSignal || hasReviewKeyword) && !looksLikeEndpointError;
    check('输出为审查结果（非配置缺失报错）', looksLikeReport, looksLikeReport ? '命中审查标记' : '未命中审查标记');
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
  console.log(`\n临时仓库已清理${IS_WIN ? '（libuv fetch 断言与本脚本无关，见 probe 记录）' : ''}`);
}

// 自然退出（process.exit 在 Windows libuv 下可能触发 fetch 句柄断言崩溃）。
if (failures > 0) {
  console.log(`\n✘ ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\n✔ 引擎端到端实证通过：评审模型（用户配置端点）真实审查跑通');
}
