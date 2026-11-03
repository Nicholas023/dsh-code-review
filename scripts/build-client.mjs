#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * build-client.mjs —— 把浏览器端打包成宿主可加载的单个 ESM bundle。
 *
 * 为什么必须打包成单文件：DSH 的 client-modules 读的是
 * package.json 里 exports["./client"] 指向的**一个文件**，
 * 它不做模块图的递归解析。
 *
 * external 列表的含义：
 *  - react / react/jsx-runtime：宿主提供，插件不能自带一份（否则 React 双实例，
 *    hooks 直接崩）；
 *  - @deepseek-ai/*：宿主的客户端包，同理不能打进我们的 bundle。
 *
 * 用法：node scripts/build-client.mjs
 */

import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, statSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = join(ROOT, 'dist', 'client', 'index.js')

await build({
  entryPoints: [join(ROOT, 'src', 'client', 'index.tsx')],
  outfile,
  bundle: true,
  // 浏览器 ESM：宿主用 <script type="module"> 或动态 import 加载
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  // 宿主提供这些，插件不自带
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  // 不压缩：客户端 bundle 会被宿主缓存并在浏览器里执行，保留可读性便于排障
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
})

if (!existsSync(outfile)) {
  console.error('构建失败：产物不存在 ' + outfile)
  process.exit(1)
}
const size = statSync(outfile).size
console.log('客户端 bundle: ' + outfile)
console.log('体积: ' + (size / 1024).toFixed(1) + ' KB')
