/**
 * sensitive-list.js —— 敏感文件点名层（ 五.6 / 词汇表「敏感文件点名」）。
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
  /(^|\/)\.[^/]*key[^/]*$/i, // .ssh、.id_rsa、*.pem(key) 等
  /(^|\/)\.[^/]*secret/i,
  /(^|\/)\.env(\.[^/]+)?$/i, // .env / .env.production 等
  /(^|\/)(.*\.)?(pem|p12|pfx|keystore|jks|cert|crt|key|kdbx|otpkey)(\.|$)/i,
  /(^|\/)credentials[^/]*$/i,
  /(^|\/).*token[^/]*$/i,
  // 个人/隐私信息。
  /(^|\/)(.*\.)?(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  // 常见凭据兜底（作业本/测试台账类命名）。
  /(^|\/)(.*\.)?(password|passwd|pass|pwd)[^/]*\.(txt|yml|yaml|json|ini|conf|cfg|config|log|bak|old|tmp)$/i,
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
    .map((p) => String(p).replace(/\\/g, '/'))
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
  const lines = hits.map((h, i) => `${i + 1}. \`${h.path}\``);
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
