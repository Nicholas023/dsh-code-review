#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * release.mjs —— 发布前的机械校验与产物清单。
 *
 * 它不负责「发到 GitHub」，只负责回答一个问题：
 *   **现在这个 worktree，能不能打包成别人能装的 0.2.0？**
 *
 * 检查项（对应实施计划 19.3 的门禁）：
 *   1. 工作区干净（没有未提交改动混进产物）
 *   2. 构建成功，dist/ 入口存在且可被 Node 加载
 *   3. package.json 的 main / files / engines 与实际产物一致
 *   4. 产物里不含源码、测试、node_modules
 *   5. LICENSE / NOTICE 存在
 *   6. 生成文件清单 + SHA-256（供发布后核对）
 *
 * 用法：node scripts/release.mjs [--json]
 * 退出码：0 全部通过；1 有硬性失败
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const warnings = []

/** 记一条硬失败。 */
function fail(msg) {
  failures.push(msg)
}

/** 记一条警告（不阻断，但要在清单里体现）。 */
function warn(msg) {
  warnings.push(msg)
}

/** 递归列文件（跳过 .git / node_modules / dist 之外的东西由调用方控制）。 */
function listFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

/** 文件 SHA-256。 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ── 1. 工作区干净 ──
try {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  const lines = status.split('\n').filter((l) => l.trim() !== '')
  // dist/ 与 release/ 是产物目录，允许存在
  const meaningful = lines.filter((l) => !/^.. (dist\/|release\/)/.test(l))
  if (meaningful.length > 0) {
    fail('工作区有未提交改动，发布产物会与仓库不一致：\n  ' + meaningful.slice(0, 10).join('\n  '))
  }
} catch (error) {
  fail('无法读取 git 状态：' + String(error.message ?? error))
}

// ── 2. package.json 自洽 ──
let pkg
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
} catch (error) {
  fail('package.json 无法解析：' + String(error.message ?? error))
}

if (pkg) {
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
    fail('package.json version 不是合法 semver：' + String(pkg.version))
  }
  if (pkg.main !== 'dist/plugin/index.js') {
    fail('package.json main 应指向 dist/plugin/index.js，实际是 ' + String(pkg.main))
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) {
    fail('package.json files 必须包含 dist')
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    warn('存在运行时依赖（' + Object.keys(pkg.dependencies).join(', ') + '），确认它们会被安装')
  }
}

// ── 3. 构建产物 ──
const dist = join(ROOT, 'dist')
const entry = join(dist, 'plugin', 'index.js')
if (!existsSync(entry)) {
  fail('缺少构建产物 dist/plugin/index.js（先跑 npm run build）')
}

const distFiles = existsSync(dist) ? listFiles(dist) : []
if (distFiles.length === 0) {
  fail('dist/ 为空')
}
// 产物里不该有源码或测试
for (const f of distFiles) {
  if (/\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts')) fail('产物里混入 TypeScript 源码：' + f)
  if (f.startsWith('test/') || f.includes('/test/')) fail('产物里混入测试：' + f)
}
if (distFiles.some((f) => f.endsWith('.map'))) {
  warn('产物包含 sourcemap（发布包通常不需要，会增大体积并暴露源码结构）')
}

// ── 4. 许可证与来源 ──
for (const required of ['LICENSE', 'NOTICE']) {
  if (!existsSync(join(ROOT, required))) fail('缺少 ' + required)
}

// ── 5. 入口可加载（真的跑一次） ──
if (existsSync(entry)) {
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "import('./dist/plugin/index.js').then(m => { if (m.name !== 'dsh-code-review') process.exit(1) })"],
      { cwd: ROOT, stdio: 'pipe' },
    )
  } catch (error) {
    fail('入口加载失败：' + String(error.message ?? error))
  }
}

// ── 6. 生成清单 ──
const manifest = {
  name: pkg?.name ?? 'dsh-code-review',
  version: pkg?.version ?? 'unknown',
  generatedAt: new Date().toISOString(),
  fileCount: distFiles.length,
  totalBytes: distFiles.reduce((sum, f) => sum + statSync(join(dist, f)).size, 0),
  entrySha256: existsSync(entry) ? sha256(entry) : null,
  files: distFiles.sort().map((f) => ({ path: f, bytes: statSync(join(dist, f)).size, sha256: sha256(join(dist, f)) })),
  warnings,
  failures,
  ok: failures.length === 0,
}

const outDir = join(ROOT, 'release')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'manifest.json')
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// ── 7. 打包（--pack 时）──
//
// 用系统 tar：这是唯一能保证「解压后权限与目录结构不变」的方案，
// 也比手写 zip 容器可靠。打包只是把 dist + 元数据装进一个文件，
// 不做任何转换 —— 发布产物必须与 manifest 记录的哈希完全一致。
if (process.argv.includes('--pack') && failures.length === 0) {
  // 用相对路径：GNU tar 会把带冒号的 Windows 绝对路径（D:\…）当成「远程主机:路径」。
  const archiveName = 'dsh-code-review-' + String(manifest.version) + '.tar.gz'
  const archive = join('release', archiveName)
  try {
    const inputs = ['dist', 'package.json', 'README.md', 'UPGRADING.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'cordis.patch.yml']
      .filter((p) => existsSync(join(ROOT, p)))
    // --force-local 是双保险：即使路径里出现冒号也按本地文件处理
    execFileSync('tar', ['--force-local', '-czf', archive, ...inputs], { cwd: ROOT, stdio: 'pipe' })
    manifest.archive = { path: archive.replace(/\\/g, '/'), bytes: statSync(join(ROOT, archive)).size }
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    if (!process.argv.includes('--json')) {
      console.log('归档：' + archive + '（' + (statSync(join(ROOT, archive)).size / 1024).toFixed(1) + ' KB）')
    }
  } catch (error) {
    failures.push('打包失败：' + String(error.message ?? error))
  }
}

// ── 8. 报告 ──
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(manifest, null, 2))
} else {
  console.log('=== 发布校验 ===')
  console.log('包：' + manifest.name + '@' + manifest.version)
  console.log('产物：' + String(manifest.fileCount) + ' 个文件，' + (manifest.totalBytes / 1024).toFixed(1) + ' KB')
  console.log('入口哈希：' + String(manifest.entrySha256).slice(0, 16) + '…')
  console.log('清单：' + relative(ROOT, outPath))
  console.log('')
  if (failures.length > 0) {
    console.log('❌ 硬性失败 ' + String(failures.length) + ' 项：')
    for (const f of failures) console.log('  - ' + f)
  } else {
    console.log('✅ 全部硬性检查通过')
  }
  if (warnings.length > 0) {
    console.log('')
    console.log('⚠ 警告 ' + String(warnings.length) + ' 项：')
    for (const w of warnings) console.log('  - ' + w)
  }
}

process.exitCode = failures.length === 0 ? 0 : 1
