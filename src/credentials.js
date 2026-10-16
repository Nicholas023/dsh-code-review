/**
 * src/credentials.js —— 评审 key 解析（步骤 5 零落盘通道）。
 *
 * 通道优先级（任何一步取到非空即停）：
 *   1. 环境变量（DSH 会话/宿主已注入，如 DEEPSEEK_API_KEY）；
 *   2. DSH 凭据文件（home 下 .dsh 目录的凭据 yaml）同名条目（只读正则解析）。
 *
 * 安全卫生：**凭据值**只在调用进程内存中流转，随后经 spawn env 传给引擎子进程；
 * 绝不写盘、绝不进日志、绝不进工具输出。唯一的 stderr 输出是**读取失败的错误
 * 类别**（如 EACCES / ENOSPC，见 readCredentialsYaml）——不含文件路径、不含任何
 * 值，既能诊断又不扩大泄露面。yaml 解析用细粒度正则——只认
 * `NAME: value` / `NAME=value`（0~4 空格缩进），不做通用 YAML 展开。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 从凭据文本中提取指定引用名的值。
 * 实况（实证 DSH 凭据 yaml）：所有凭据引用在
 * `refs:` 段下（缩进 2），顶层只有 version/refs/records。因此匹配
 * 「0~4 空格缩进 + NAME: value」（兼容顶层无缩进与 refs 段 2 空格），
 * 刻意不匹配更深缩进（如 records 段），避免误读非凭据内容。
 *
 * 返回值区分两种「空」：`null` = 键不存在（未配置）；`''` = 键存在但值是
 * 空串（显式配了空值——用户配错，值得单独提示，如 `NAME: ""`）。
 * @param {string} text 凭据文件文本。
 * @param {string} name 引用名。
 * @returns {string|null} 值 / ''（显式空值）/ null（键不存在）。 */
export function parseCredentialsText(text, name) {
  // 原 `['"]?([^\s'"]+)['"]?` 只认单个无空白 token 且整行
  // 锚定——带引号含空格的值（`NAME: "key value with spaces"`）、行尾内联注释
  // （`NAME: key-value  # prod key`）都会静默返回 ''，与「未配置」无法区分，
  // 调用方无声降级认证。新版支持：双/单引号括起（可含空格）+ 可选行尾
  // `# 注释`；严格不匹配「键存在但值恰为空串」以外的形态。
  const re = new RegExp(`^ {0,4}${escapeRe(name)}\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s'"]+))\\s*(?:#.*)?$`, 'm');
  const m = text.match(re);
  if (m) return m[1] ?? m[2] ?? m[3]; // 三组互斥，命中时必有一组为非 null
  // 裸键（`NAME:` 或 `NAME: # 注释`，冒号后无值）——键**存在**但值为空：
  // 属「显式空值 / 配置写残」，与「键不存在」是两回事（调用方可据此给出
  // 不同提示）。返回 '' 而非 null。
  const bareRe = new RegExp(`^ {0,4}${escapeRe(name)}\\s*[:=]\\s*(?:#.*)?$`, 'm');
  return bareRe.test(text) ? '' : null;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 读 DSH 凭据文件中指定引用名的值（只读 yaml 顶层/refs 段键）。
 * @returns {string|null} 值 / ''（显式空值）/ null（文件缺失、键不存在或读取失败）。 */
function readCredentialsYaml(name) {
  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(file)) return null;
    return parseCredentialsText(readFileSync(file, 'utf8'), name);
  } catch (error) {
    // 不再静默吞错——权限拒绝/文件损坏（YAML 语法层外）
    // 与「未配置」曾全部塌缩为同一空串结果，凭据配置错误无法诊断。仅记录
    // 错误类别（code / 构造名），**不记 error.message**——Node 的 fs 错误消息
    // 会带上完整文件路径，与本模块「绝不进日志」的安全姿态冲突；返回值仍为
    // null，由调用方按未配置降级。
    console.error('[credentials] 读取凭据文件失败（将按未配置处理）:', error?.code ?? String(error?.constructor?.name ?? 'Error'));
    return null;
  }
}

/**
 * 解析指定引用名（apiKeyEnv）的真实 key。
 *
 * 通道优先级（任何一步取到非空即停）：
 *   1. 环境变量（DSH 会话/宿主已注入，如 DEEPSEEK_API_KEY）；
 *   2. DSH 凭据文件（home 下 .dsh 目录的凭据 yaml）同名条目（只读正则解析）。
 *
 * （ctx.credentials seam 分支已删除——所有生产调用方
 * （review-exec.js / 各 e2e）均以 undefined 调用，该分支属不可达死代码。
 * 若未来宿主提供凭据 seam，恢复此处并补对应测试。）
 *
 * 纯同步函数（无 await）：签名保留 async 会误导调用方以为存在异步 IO，
 * 且强制所有调用点做无意义的 await；去除 async 后 `await` 立即取值，
 * 调用方行为不变。
 *
 * @param {object} [_ctx] 保留占位（历史签名兼容，当前不使用）。传入非
 *   undefined 值时会告警——避免未来调用方误以为凭据会从 ctx 解析而
 *   静默拿到 env/yaml 的结果，产生难查的认证失败。
 * @param {string} envName 引用名，如 'DEEPSEEK_API_KEY'。
 * @param {object} [io] 测试注入位：{ env }。
 * @returns {string|null} key（null = 未找到；'' = 显式空值。调用方用
 *   isKeyMissing 统一判定降级）。
 */
export function resolveApiKey(_ctx, envName, io = {}) {
  if (_ctx !== undefined) {
    console.warn('[credentials] resolveApiKey 的 ctx 参数已废弃且被忽略：凭据只从 env / 凭据文件解析。');
  }
  const env = io.env ?? process.env;
  const name = String(envName ?? '').trim();
  if (!name) return null;
  // 与凭据文件通道对齐 trim 与字符串化——env 分支此前
  // 原样返回 raw 值，行首/行尾空白会产出被污染 key（偶发 401 且仅 env 通道
  // 复现），两个通道行为不一致。
  if (env[name]) return String(env[name]).trim();
  return readCredentialsYaml(name);
}

/** 判定 key 是否缺失或为空（供工具结果给出明确降级文案）。
 *  null（键不存在）与 ''（显式空值）统一视为缺失——两者在降级意义上等效
 *  （均无法用于认证）。若需区分「未配置」与「配了空值」，直接比对 null / ''。 */
export function isKeyMissing(key) {
  return typeof key !== 'string' || key.trim() === '';
}
