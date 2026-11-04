#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * build-client.mjs —— 把浏览器端打成宿主能加载的 bundle。
 *
 * ⚠️ 这里曾经踩过一个会让整个 DSH 起不来的坑，记下来免得再犯：
 *
 * 第一版打成了 ESM（format: 'esm'），宿主加载时报
 *   Uncaught SyntaxError: Cannot use import statement outside a module
 * 然后 web boot 失败，**整个 DSH 都打不开**（不是插件坏了，是启动流程挂了）。
 *
 * 原因：DSH 的 client-modules 把每个插件的 client 产物当**经典脚本**注入，
 * 期望它调用宿主预先注入的 `window.__ModuleLoader__.load({ id, factory })`，
 * 模块之间的依赖用 factory 收到的 `require` 解析（React 也走这条路）。
 * ESM 的顶层 import 在这种加载方式下非法。
 *
 * 所以产物形态必须是：
 *   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
 *     <CommonJS 代码>
 *     return module.exports
 *   }});
 *
 * 具体做法：先用 esbuild 打成 CommonJS（外部依赖会变成 require("react")），
 * 再包进 factory，把宿主的 require 通过闭包传进去。
 *
 * 用法：node scripts/build-client.mjs
 */

import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = join(ROOT, 'dist', 'client', 'index.js')

/** 与 package.json 的 name 保持一致：加载器用它当模块 id。 */
const MODULE_ID = 'dsh-code-review'

const result = await build({
  entryPoints: [join(ROOT, 'src', 'client', 'index.tsx')],
  bundle: true,
  // 关键：CommonJS，不是 ESM（见文件头说明）
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  // 宿主提供这些：React 与官方客户端包都由 __ModuleLoader__ 的 require 解析
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  // 拿到代码字符串自己包装，不直接落盘
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
})

if (!Array.isArray(result.outputFiles) || result.outputFiles.length === 0) {
  console.error('构建失败：esbuild 没有产出文件')
  process.exit(1)
}
const code = result.outputFiles[0].text

/**
 * 包装成宿主的模块加载协议。
 *
 * 注意 module/exports 必须显式给：CJS 产物会写 `module.exports = {...}`
 * 与 `Object.defineProperty(exports, "__esModule", ...)`，两者都要有对象承接。
 */
const wrapped =
  '/* dsh-code-review client bundle — 由 scripts/build-client.mjs 生成，请勿手改 */\n' +
  'window.__ModuleLoader__.load({id:"' + MODULE_ID + '",factory:(require)=>{\n' +
  'var module={exports:{}};var exports=module.exports;\n' +
  code +
  '\n;return module.exports;\n' +
  '}});\n'

mkdirSync(join(ROOT, 'dist', 'client'), { recursive: true })
writeFileSync(outfile, wrapped, 'utf8')

if (!existsSync(outfile)) {
  console.error('构建失败：产物不存在 ' + outfile)
  process.exit(1)
}

// 自检：产物必须是经典脚本，绝不能出现顶层 import/export
const head = wrapped.slice(0, 400)
if (/^\s*import\s/m.test(code) || /^\s*export\s/m.test(code)) {
  console.error('构建失败：产物里仍有 ESM 的 import/export（会被宿主当经典脚本执行而报错）')
  process.exit(1)
}
if (!wrapped.startsWith('/* dsh-code-review client bundle') || !wrapped.includes('window.__ModuleLoader__.load')) {
  console.error('构建失败：包装格式不对')
  process.exit(1)
}

console.log('客户端 bundle: ' + outfile)
console.log('体积: ' + (statSync(outfile).size / 1024).toFixed(1) + ' KB（经典脚本 + __ModuleLoader__ 协议）')
void head
