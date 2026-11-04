// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * read.ts —— 有界文件读取。
 *
 * 三个约束缺一不可：
 *  - **行数有界**：默认 64 行，否则模型一次读几千行，上下文直接爆；
 *  - **字节有界**：防止单行超长（压缩文件、min.js）绕过行数限制；
 *  - **敏感路径拒绝**：连内容都不读，直接返回 rejected。
 *
 * 截断时返回 partial + coverage + continuation，让模型知道「还有后半段」，
 * 而不是以为自己已经看完。这个区别决定了它是「没发现问题」还是「没看完」。
 */

import { readFileSync, statSync } from 'node:fs'
import { isSensitivePath } from '../selection/sensitive.js'
import { assertRegularFile, resolveInsideRoot } from './path-fence.js'
import {
  READ_BYTES_DEFAULT,
  READ_BYTES_MAX,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
  type ReadArgs,
  type ReadData,
  type ReadLine,
  type ToolResult,
} from './types.js'

/** 判断是否二进制（含 NUL 字节）。 */
function looksBinary(content: string): boolean {
  return content.includes('\u0000')
}

/**
 * 读取仓库内某文件的一段。
 * @param root 仓库根绝对路径
 * @param args 参数
 */
export function readFileRange(root: string, args: ReadArgs): ToolResult<ReadData> {
  const fence = resolveInsideRoot(root, args.path)
  if (!fence.ok) {
    return {
      status: 'rejected',
      error: { code: 'RUNTIME_PATH_FENCE_VIOLATION', message: fence.reason, retry: 'never', effectState: 'none' },
    }
  }
  if (isSensitivePath(fence.relPath)) {
    return {
      status: 'rejected',
      error: {
        code: 'RUNTIME_PATH_FENCE_VIOLATION',
        message: `敏感路径，内容不送审：${fence.relPath}`,
        retry: 'never',
        effectState: 'none',
        nextAction: '该文件已在报告中点名，请人工确认是否应提交',
      },
    }
  }
  const badType = assertRegularFile(fence.absPath)
  if (badType !== null) {
    return {
      status: 'rejected',
      error: { code: 'REPO_READ_FAILED', message: `${badType}：${fence.relPath}`, retry: 'never', effectState: 'none' },
    }
  }

  // 参数归一与钳制
  const offset = Math.max(1, Math.floor(args.offset ?? 1))
  const limit = Math.min(READ_LIMIT_MAX, Math.max(1, Math.floor(args.limit ?? READ_LIMIT_DEFAULT)))

  let text: string
  try {
    // 先看大小：超过字节上限的文件不整个读进内存（避免大文件拖垮 runner）
    const size = statSync(fence.absPath).size
    if (size > 8 * 1024 * 1024) {
      return {
        status: 'rejected',
        error: {
          code: 'RUNTIME_OUTPUT_LIMIT_PLACEHOLDER',
          message: `文件过大（${size} 字节），拒绝整体读取`,
          retry: 'never',
          effectState: 'none',
        },
      }
    }
    text = readFileSync(fence.absPath, 'utf8')
  } catch (error) {
    return {
      status: 'error',
      error: {
        code: 'REPO_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retry: 'safe',
        effectState: 'none',
      },
    }
  }

  if (looksBinary(text)) {
    return {
      status: 'rejected',
      error: { code: 'REPO_READ_FAILED', message: `二进制文件：${fence.relPath}`, retry: 'never', effectState: 'none' },
    }
  }

  const allLines = text.split(/\r?\n/)
  // 结尾换行会产生一个空元素；保留真实行数语义
  const totalLines = allLines.length > 0 && allLines[allLines.length - 1] === '' ? allLines.length - 1 : allLines.length
  const startIdx = offset - 1
  if (startIdx >= totalLines) {
    return {
      status: 'completed',
      data: { path: fence.relPath, lines: [], totalLines },
    }
  }

  // 按行截取，同时受字节上限约束
  const picked: ReadLine[] = []
  let bytes = 0
  let cursor = startIdx
  let byteTruncated = false
  while (cursor < totalLines && picked.length < limit) {
    const lineText = allLines[cursor] ?? ''
    const cost = Buffer.byteLength(lineText, 'utf8') + 1
    if (bytes + cost > READ_BYTES_MAX) { byteTruncated = true; break }
    picked.push({ n: cursor + 1, text: lineText })
    bytes += cost
    cursor += 1
  }

  const data: ReadData = { path: fence.relPath, lines: picked, totalLines }
  const reachedEnd = cursor >= totalLines
  if (reachedEnd && !byteTruncated) {
    return { status: 'completed', data }
  }

  // 未读完：明确声明缺口与续取方式
  return {
    status: 'partial',
    data,
    coverage: {
      processed: picked.length,
      total: totalLines,
      omitted: byteTruncated ? '达到单次字节上限，后续行未读取' : `第 ${cursor + 1} 行之后未读取`,
    },
    continuation: { kind: 'offset', offset: cursor + 1 },
  }
}

/** 导出字节上限供测试与 SDK 声明使用。 */
export { READ_BYTES_DEFAULT, READ_BYTES_MAX, READ_LIMIT_DEFAULT, READ_LIMIT_MAX }
