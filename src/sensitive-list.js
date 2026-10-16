/**
 * sensitive-list.js —— 敏感文件点名层（敏感文件内容不送审，逐一点名列入报告）。
 *
 * 语义（不允许静默）：
 *   - 引擎内置敏感路径保护会**静默排除**敏感文件（内容不送审，防二次泄露）——
 *     这本身是对的；
 *   - 但插件层必须自检「本次待提交文件清单」（git status / ls-files），命中
 *     敏感模式的每个文件**点名列入结果报告**（类型=敏感文件，提示检查是否
 *     该提交），作为「发 GitHub 前防开盒」的兜底人眼检查点。
 *
 * 实现：纯函数 + 模式表，零网络、零平台绑定（步骤 6 在此文件上完成判据：
 * 造一个含 .env 的测试仓库，审查后报告出现该文件点名项）。
 *
 * 零敏感：本表是通用规则（不指向任何特定平台），可随开源版本分发。
 */

/**
 * 敏感文件/路径模式表（git ls-files 相对路径，逐项测试）。
 * 命中即点名；内容一律不送审（引擎侧已排除，本层不读取文件内容）。
 */
export const SENSITIVE_PATH_PATTERNS = [
  // 密钥/凭据类：任何平台通用。
  // 纠正失实注释——本模式只匹配「以 . 开头且基名含 key」
  // 的隐藏文件（如 .apikey）；.ssh、.id_rsa、*.pem 并不被它命中（.id_rsa 由
  // 下方 id_* 行覆盖、*.pem 由凭据扩展名行覆盖）；.ssh 目录段单独无覆盖属
  // 已知盲区（引擎侧路径保护另有 .ssh 排除），勿据此删除下方覆盖行。
  /(^|\/)\.[^/]*key[^/]*$/i,
  /(^|\/)\.[^/]*secret/i,
  /(^|\/)\.env(\.[^/]+)?$/i, // .env / .env.production 等
  /(^|\/)(.*\.)?(pem|p12|pfx|keystore|jks|cert|crt|key|kdbx|otpkey)(\.|$)/i,
  /(^|\/)credentials[^/]*$/i,
  // token 模式收紧（形态：独立词段 token(s) + **凭据类扩展名或路径结尾**）——
  // 原 `.*token[^/]*$` 命中路径任意位置含 "token" 的文件（src/tokenizer.js、
  // token-utils/index.js 等业务文件也被点名），噪声淹没「逐个人眼确认」信号。
  // 扩展名收敛到凭据类白名单（与下方 token+分隔符规则同一白名单）：token.json /
  // api_token / my-tokens 命中；token.js（令牌类型定义模块）、tokens.ts、
  // design-tokens.md 等业务源码放出——避免把「代码文件」当凭据文件点名。
  /(^|\/)(.*[.\-_])?tokens?(\.(json|yml|yaml|txt|ini|conf|cfg|config|log|bak|old|tmp|env))?$/i,
  // token 后跟分隔符、且带凭据类扩展名的形态（refresh_token_backup.json、
  // token_store.yaml、my_token.txt）——上一行的「token 作为独立词段 + 点号
  // 扩展名或路径结尾」覆盖不到它们：token 后不是点而是下划线/横线。此处不写
  // `\w*` 前缀——它会让 `subtokens.json`（sub+tokens）这类业务命名也命中，
  // 而词段前缀已由 `(.*[.\-_])?` 负责。
  /(^|\/)(.*[.\-_])?tokens?[._-][^/]*\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
  // 补充常见凭据文件假阴性——.npmrc（含 _authToken）、
  // .netrc、.git-credentials，以及 secrets/、secrets.yml 等未带点前缀的
  // secrets/credentials 命名（原 credentials 行只覆盖含字面量 credentials 的
  // 基名、\.secret 要求点开头）。
  /(^|\/)\.(npmrc|netrc|git-credentials)$/i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  // 个人/隐私信息。
  /(^|\/)(.*\.)?(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  // 常见凭据兜底（作业本/测试台账类命名）。
  // 移除裸 "pass" 备选（passenger.json、pass-through.yml
  // 被误判）；仅保留 password/passwd/pwd。
  /(^|\/)(.*\.)?(password|passwd|pwd)[^/]*\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
  // 凭据扩展名修饰的 pass 词段（pass.txt、db.pass.yml、my.pass.json）：裸
  // "pass" 备选不放回（passenger.json、pass-through.yml 会被误判——历史
  // 教训）。路径段（^|/）或点/横线/下划线分隔（[.\-_]）保证是独立词段，
  // 且 **只匹配凭据类扩展名**（与上方 password 规则同一扩展名白名单）——
  // 原 `(\.[^/]*)?` 会放行任意扩展名与无扩展名，把 pass.ts（登机牌模块）、
  // pass/index.js、src/pass.md 全判成敏感文件，与该注释声称的「误判面已
  // 收敛」矛盾。
  /(^|\/)(.*[.\-_])?pass\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
];

/**
 * 判断单个相对路径是否命中敏感模式。
 *
 * @param {string} relPath git 相对路径（正斜杠分隔）。
 * @returns {boolean} true = 命中（应点名）。
 */
export function isSensitivePath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(relPath));
}

/**
 * 从待提交/待跟踪文件清单中筛出敏感文件。
 *
 * @param {string[]} paths git 相对路径数组。
 * @returns {Array<{path: string}>} 命中清单（内容不读取、不送审）。
 */
export function listSensitiveFiles(paths) {
  return (Array.isArray(paths) ? paths : [])
    // → 口径收敛：过滤非字符串/空值
    // ——原 String(p) 把 null→'null'、对象→'[object Object]' 静默转为无意义
    // 点名单。修后直接丢弃（防御性处理：上游脏数据不进点名单也不进报告，
    // 不抛错不放大；「应该向调用方暴露脏数据」是另一层的职责，不在这里）。
    .filter((p) => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/\\/g, '/'))
    .filter(isSensitivePath)
    .map((path) => ({ path }));
}

/**
 * 组装「敏感文件点名块」正文（判据⑥：报告里出现点名项；会话 tail 也保留一次）。
 * 内容不送审、文件内容不读取——只点名提示人工确认是否该提交。
 *
 * @param {string[]} pendingPaths 本次待提交/待过目文件相对路径。
 * @returns {string} 点名块 markdown（无命中返回空串）。
 */
export function buildSensitiveBlock(pendingPaths) {
  const hits = listSensitiveFiles(pendingPaths);
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    // 路径未经转义直接进反引号代码块——git 文件名可含
    // 反引号/换行（git 允许），会闭合代码块并向报告注入任意 markdown。拼接前
    // 剔除反引号与换行（点名目的是人眼确认路径，替换为空格不影响辨识）。
    const safe = String(h.path).replace(/[`\r\n*_[\]<>|]+/g, ' ');
    return `${i + 1}. \`${safe}\``;
  });
  return [
    '',
    '## ⚠ 敏感文件点名（内容未送审，请人工确认是否该提交）',
    '',
    ...lines,
    '',
    '> 这些文件命中敏感路径模式，引擎已排除其内容（不送审）。请逐一确认：',
    '> 若包含密钥/凭据/隐私信息，提交 GitHub 前应加入 .gitignore 或剔除。',
  ].join('\n');
}
