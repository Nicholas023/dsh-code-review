/**
 * src/credentials.js —— 评审 key 解析（步骤 5 零落盘通道）。
 *
 * 通道优先级（任何一步取到非空即停）：
 *   1. 环境变量（DSH 会话/宿主已注入，如 DEEPSEEK_API_KEY）；
 *   2. ~/.dsh/.credentials.yaml 同名条目（只读正则解析，引用名 → 值）；
 *   3. ctx.credentials（DSH 凭据 seam 官方取数口，尽力而为）。
 *
 * 安全卫生：返回值只在调用进程内存中流转，随后经 spawn env 传给引擎子进程；
 * 绝不写盘、绝不进日志、绝不进工具输出。yaml 解析用细粒度正则——只认
 * `NAME: value` / `NAME=value` 顶层条目，不做通用 YAML 展开（避免误读嵌套）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 从文本中提取顶层 `NAME: value` / `NAME=value`（带引号宽容）。
 * 语义：只认「行首无缩进」的顶层条目——嵌套（如 refs: 下的键）不匹配，
 * 避免误读非本项目凭据。 */
export function parseCredentialsText(text, name) {
  const re = new RegExp(`^${escapeRe(name)}\\s*[:=]\\s*['"]?([^\\s'"]+)['"]?\\s*$`, 'm');
  const m = text.match(re);
  return m ? m[1] : '';
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 读 ~/.dsh/.credentials.yaml 中指定引用名的值（只读 yaml 顶层键）。 */
function readCredentialsYaml(name) {
  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(file)) return '';
    return parseCredentialsText(readFileSync(file, 'utf8'), name);
  } catch {
    return '';
  }
}

/**
 * 解析指定引用名（apiKeyEnv）的真实 key。
 *
 * @param {object} [ctx] DSH 会话上下文（有则尝试 ctx.credentials seam）。
 * @param {string} envName 引用名，如 'DEEPSEEK_API_KEY' / 'PARTNER_API_KEY'。
 * @param {object} [io] 测试注入位：{ env }。
 * @returns {Promise<string>} key（空串 = 未找到，调用方决定降级行为）。
 */
export async function resolveApiKey(ctx, envName, io = {}) {
  const env = io.env ?? process.env;
  const name = String(envName ?? '').trim();
  if (!name) return '';
  if (env[name]) return env[name];
  const fromYaml = readCredentialsYaml(name);
  if (fromYaml) return fromYaml;
  try {
    // DSH 凭据 seam：credentialRef(name) 品牌化引用交给宿主解析（逐请求，改凭据免重启）。
    const ref = ctx?.credentials?.credentialRef?.(name);
    if (ref) {
      const v = await ref.resolve();
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* 尽力而为，回空由调用方降级 */
  }
  return '';
}

/** 判定 key 是否缺失（供工具结果给出明确降级文案）。 */
export function isKeyMissing(key) {
  return typeof key !== 'string' || key.trim() === '';
}
