// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * path-fence.ts —— 路径围栏：确保任何工具只能访问仓库根之内的普通文件。
 *
 * 这是整个 PTC 沙箱最关键的一层。模型写出的程序会传入任意路径，
 * 它可能是：
 *  - `../../.ssh/id_rsa`        —— 相对逃逸
 *  - `C:/Users/x/.env`          —— 绝对路径
 *  - `link-to-outside/secret`   —— 符号链接/junction 逃逸
 *  - `/dev/zero` 或命名管道     —— 无限流/阻塞
 *
 * 对策是三道关，缺一不可：
 *  1. **拒绝绝对路径与 ..**：先把输入当仓库相对路径，做词法归一；
 *  2. **realpath 校验**：解开符号链接后再比对一次根前缀（词法合法不等于物理在根内）；
 *  3. **类型校验**：只放行普通文件，拒绝目录、设备、管道、socket。
 */

import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

/** 围栏校验结果。 */
export type FenceResult =
  | { readonly ok: true; readonly absPath: string; readonly relPath: string }
  | { readonly ok: false; readonly reason: string }

/**
 * 把仓库相对路径解析为绝对路径，并校验它确实落在仓库根内。
 *
 * @param root    仓库根绝对路径
 * @param relPath 模型给出的路径（应一律视为仓库相对）
 * @param opts    strictSymlinks=true 时用 realpath 校验物理位置（默认开）
 */
export function resolveInsideRoot(
  root: string,
  relPath: string,
  opts: { readonly strictSymlinks?: boolean } = {},
): FenceResult {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return { ok: false, reason: '路径为空' }
  }
  const raw = relPath.trim().replace(/\\/g, '/')

  // 关一：拒绝绝对路径（含 Windows 盘符与 UNC）
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) {
    return { ok: false, reason: `只接受仓库相对路径，收到绝对路径：${raw}` }
  }

  // 关一（续）：词法归一后不得逃出根
  const normalized = normalize(raw).replace(/\\/g, '/')
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, reason: `路径逃逸出仓库根：${raw}` }
  }

  const rootAbs = resolve(root)
  const target = resolve(rootAbs, normalized)

  // 词法前缀校验（大小写不敏感以适配 Windows）
  if (!isUnder(rootAbs, target)) {
    return { ok: false, reason: `路径逃逸出仓库根：${raw}` }
  }

  // 关二：realpath 校验（解开符号链接后再比一次）
  const strict = opts.strictSymlinks !== false
  if (strict) {
    let realTarget: string
    try {
      realTarget = realpathSync(target)
    } catch {
      // 文件不存在：交给上层报「未找到」，这里不误报为逃逸
      return { ok: true, absPath: target, relPath: normalized }
    }
    let realRoot: string
    try {
      realRoot = realpathSync(rootAbs)
    } catch {
      realRoot = rootAbs
    }
    if (!isUnder(realRoot, realTarget)) {
      return { ok: false, reason: `符号链接指向仓库根之外：${raw}` }
    }
  }

  return { ok: true, absPath: target, relPath: normalized }
}

/** 判断 child 是否位于 parent 之下（含相等）。大小写不敏感。 */
export function isUnder(parent: string, child: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const a = norm(parent)
  const b = norm(child)
  if (b === a) return true
  return b.startsWith(a + '/')
}

/**
 * 校验目标是一个可读的普通文件（拒绝目录、设备、管道、socket）。
 * 返回 null 表示通过，否则返回拒绝原因。
 */
export function assertRegularFile(absPath: string): string | null {
  try {
    const st = lstatSync(absPath)
    if (st.isSymbolicLink()) {
      // 符号链接已在上一步 realpath 校验过，这里再 stat 一次确认目标是普通文件
      const real = lstatSync(realpathSync(absPath))
      if (!real.isFile()) return '目标不是普通文件'
      return null
    }
    if (!st.isFile()) return '目标不是普通文件'
    return null
  } catch {
    return '文件不存在或无法访问'
  }
}

/** 路径分隔符（供需要展示平台路径的调用方复用）。 */
export const SEP = sep
