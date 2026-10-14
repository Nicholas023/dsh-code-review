/**
 * src/credentials.js —— 评审 key 解析（步骤 5 零落盘通道）。
 *
 * 通道优先级（任何一步取到非空即停）：
 *   1. 环境变量（DSH 会话/宿主已注入，如 DEEPSEEK_API_KEY）；
 *   2. DSH 凭据文件（home 下 .dsh 目录的凭据 yaml）同名条目（只读正则解析）；
 *   3. ctx.credentials（DSH 凭据 seam 官方取数口，尽力而为）。
 *
 * 安全卫生：返回值只在调用进程内存中流转，随后经 spawn env 传给引擎子进程；
 * 绝不写盘、绝不进日志、绝不进工具输出。yaml 解析用细粒度正则——只认
 * `NAME: value` / `NAME=value`（0~4 空格缩进），不做通用 YAML 展开。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 从凭据文本中提取指定引用名的值。
 * 实况（2026-10-12 实证 DSH 凭据 yaml）：所有凭据引用在
 * `refs:` 段下（缩进 2），顶层只有 version/refs/records。因此匹配
 * 「0~4 空格缩进 + NAME: value」（兼容顶层无缩进与 refs 段 2 空格），
 * 刻意不匹配更深缩进（如 records 段），避免误读非凭据内容。 */
export function parseCredentialsText(text, name) {
  const re = new RegExp(`^ {0,4}${escapeRe(name)}\\s*[:=]\\s*['"]?([^\\s'"]+)['"]?\\s*$`, 'm');
  const m = text.match(re);
  return m ? m[1] : '';
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 读 DSH 凭据文件中指定引用名的值（只读 yaml 顶层/refs 段键）。 */
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
 * @param {string} envName 引用名，如 'DEEPSEEK_API_KEY'。
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
