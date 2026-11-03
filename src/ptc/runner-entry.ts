// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * runner-entry.ts —— run_code 子进程入口。
 *
 * 进程模型（为什么不是同线程 vm）：
 *  模型写出的代码不可信。同线程 vm 里一个死循环会卡住内核整个事件循环，
 *  内核连「杀掉它」都排不上队。所以执行放到独立子进程：
 *  - 死循环 → 父进程硬超时 kill 进程；
 *  - 内存爆炸 → 进程被杀，内核还活着；
 *  - 恶意代码 → 只能碰仓库文件，且必须过路径围栏。
 *
 * 子进程内部再用 node:vm 构造能力受限的上下文（不给 require/process/fs），
 * 但那只是纵深防御的第二层，真正的隔离边界是操作系统进程。
 *
 * 通信：stdin 一行 JSON 请求 → stdout 一行 JSON 响应。
 */

import { createContext, runInContext } from 'node:vm'
import { globFiles } from './glob.js'
import { grepFiles } from './grep.js'
import { readFileRange } from './read.js'
import { RETURN_BYTES_DEFAULT, RETURN_BYTES_MAX } from './types.js'

/** 请求体。 */
export interface RunnerRequest {
  readonly program: string
  readonly root: string
  readonly tools: readonly ('read' | 'glob' | 'grep')[]
  readonly returnBytes?: number
}

/** 响应体。 */
export interface RunnerResponse {
  readonly ok: boolean
  readonly value?: unknown
  readonly truncated?: boolean
  readonly error?: { readonly code: string; readonly message: string }
  readonly logs?: readonly string[]
}

/** 构造只读 SDK。 */
function buildSdk(request: RunnerRequest): Record<string, unknown> {
  const sdk: Record<string, unknown> = {};
  const allowed = new Set(request.tools);
  if (allowed.has('read')) sdk.read = (args: unknown) => readFileRange(request.root, args as never);
  if (allowed.has('glob')) sdk.glob = (args: unknown) => globFiles(request.root, args as never);
  if (allowed.has('grep')) {
    sdk.grep = (args: unknown) => {
      const a = args as { files?: readonly string[] };
      const files = Array.isArray(a.files) ? a.files : [];
      return grepFiles(request.root, files, args as never);
    };
  }
  return sdk;
}

/** 安全转字符串（避免循环引用炸掉日志）。 */
function safeString(v: unknown): string {
  try {
    return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    return '[unserializable]';
  }
}

/** 执行一段程序。 */
export async function executeProgram(request: RunnerRequest): Promise<RunnerResponse> {
  const logs: string[] = [];
  const MAX_LOGS = 50;

  const sandbox: Record<string, unknown> = {
    tools: buildSdk(request),
    console: {
      log: (...args: unknown[]) => {
        if (logs.length < MAX_LOGS) logs.push(args.map((a) => safeString(a)).join(' '));
      },
    },
    JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise,
    Error, TypeError, isNaN, parseInt, parseFloat,
  };

  const context = createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });

  // 把程序包成 async IIFE，模型可直接 return
  const wrapper = '(async () => {\n' + request.program + '\n})()';
  let raw: unknown;
  try {
    raw = runInContext(wrapper, context, { timeout: 25000, displayErrors: true });
    if (raw !== null && typeof raw === 'object' && typeof (raw as { then?: unknown }).then === 'function') {
      raw = await (raw as Promise<unknown>);
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: 'RUNTIME_PROGRAM_INVALID', message: error instanceof Error ? error.message : String(error) },
      logs,
    };
  }

  const limit = Math.min(RETURN_BYTES_MAX, Math.max(64, request.returnBytes ?? RETURN_BYTES_DEFAULT));
  let serialized: string;
  try {
    serialized = JSON.stringify(raw ?? null);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'RUNTIME_PROGRAM_INVALID', message: '返回值无法序列化：' + (error instanceof Error ? error.message : String(error)) },
      logs,
    };
  }

  if (Buffer.byteLength(serialized, 'utf8') <= limit) {
    return { ok: true, value: raw ?? null, logs };
  }

  // 超限不静默截断：明确标记，让模型知道拿到的只是预览
  return {
    ok: true,
    value: {
      truncated: true,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      limit,
      preview: serialized.slice(0, Math.max(0, limit - 64)),
    },
    truncated: true,
    logs,
  };
}

/** stdin → 执行 → stdout。 */
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (input === '') {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'RUNTIME_RUNNER_PROTOCOL_ERROR', message: '空请求' } }) + '\n');
    return;
  }
  let request: RunnerRequest;
  try {
    request = JSON.parse(input) as RunnerRequest;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'RUNTIME_RUNNER_PROTOCOL_ERROR', message: '请求不是合法 JSON：' + String(error) } }) + '\n');
    return;
  }
  const response = await executeProgram(request);
  process.stdout.write(JSON.stringify(response) + '\n');
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('runner-entry.js')) {
  void main();
}
