#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * benchmark-tokens.mjs —— 控制变量基准：native 多轮 vs PTC 单轮。
 *
 * 目的不是「跑分好看」，而是回答一个具体问题：
 *   **把「模型逐个调用工具」换成「模型写程序一次调用」，上下文开销差多少？**
 *
 * 两种模式都从同一个初始 prompt 出发，唯一的变量是工具交互方式：
 *  - native：每轮把工具结果追加进对话，下一轮重发整个历史（token 随轮次累积）
 *  - ptc   ：所有工具在程序内部调用，只有程序返回值进上下文
 *
 * 用法：
 *   node scripts/benchmark-tokens.mjs                    # 只估算，不联网
 *   BENCH_ENDPOINT=... BENCH_KEY=... BENCH_MODEL=... node scripts/benchmark-tokens.mjs --real
 *
 * 注意：估算模式用「字符数 / 3」近似 token，只能看量级；
 * 真实数字必须用 --real 让端点返回 usage。报告里会标明来源。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
void HERE

/** 估算 token（英文代码约 3 字符/token，中文更少；取 3 偏保守）。 */
const estimateTokens = (text) => Math.ceil(String(text).length / 3)

/** 造一份固定的待评审 diff（控制变量：两种模式看到的内容完全相同）。 */
function makeDiff() {
  return [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,5 +1,6 @@',
    ' export function login(user) {',
    '-  if (user.name) {',
    '+  const API_KEY = "sk-live-9f8e7d6c5b4a3210zyxw"',
    '+  if (user.name) {',
    '     return user.name.toUpperCase()',
    '   }',
    ' }',
  ].join('\n')
}

/** 固定 system（两种模式共用）。 */
function makeSystem() {
  return [
    '# 角色',
    '你是代码评审助手。只做评审，不修改代码。',
    '',
    '## 固定评审视角',
    '1. 安全审核（脱敏 / 安全漏洞）',
    '2. 找 bug',
    '3. 冗余与无关代码',
    '',
    '## 语言规则',
    '- Promise 未 await / 未处理的 rejection',
    '- 可选链与空值判断是否覆盖全部路径',
    '',
    '## 输出格式',
    '调用 finish 返回 findings 数组。',
  ].join('\n')
}

/**
 * 模拟 native 模式：每轮发起请求，工具结果进对话并累积。
 * @param {number} rounds 工具调用轮次
 */
function simulateNative(system, diff, rounds) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: diff },
  ]
  let totalPromptTokens = 0
  const perRound = []

  for (let i = 1; i <= rounds; i += 1) {
    // 统计本轮请求的 prompt 大小（= 已有历史 + 本轮提问）
    const promptText = messages.map((m) => m.content).join('\n')
    const promptTokens = estimateTokens(promptText)
    totalPromptTokens += promptTokens
    perRound.push({ round: i, promptTokens })

    // 工具结果进上下文（模拟一次读文件返回 40 行）
    const toolResult = Array.from({ length: 40 }, (_, k) => '  const line' + String(k) + ' = ' + String(k)).join('\n')
    messages.push({ role: 'assistant', content: '读取文件…' })
    messages.push({ role: 'tool', content: toolResult })
  }
  // 最后一轮产出结论
  const finalText = messages.map((m) => m.content).join('\n')
  const finalTokens = estimateTokens(finalText)
  totalPromptTokens += finalTokens
  perRound.push({ round: rounds + 1, promptTokens: finalTokens })

  return { totalPromptTokens, perRound, requests: rounds + 1 }
}

/**
 * 模拟 PTC 模式：模型写程序，工具在程序内执行，只有结果回上下文。
 */
function simulatePtc(system, diff) {
  const program = [
    'const r = tools.read({ path: "src/auth.ts", offset: 1, limit: 60 })',
    'const g = tools.grep({ pattern: "API_KEY", files: ["src/auth.ts"] })',
    'return { lines: r.data.lines.length, hits: g.data.matches.length }',
  ].join('\n')

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: diff },
  ]
  const promptText = messages.map((m) => m.content).join('\n')
  const promptTokens = estimateTokens(promptText)

  // 第二轮：程序与其返回值进上下文（值很小）
  const afterProgram = promptText + '\n' + program + '\n{"lines":60,"hits":1}'
  const finalTokens = estimateTokens(afterProgram)

  return {
    totalPromptTokens: promptTokens + finalTokens,
    perRound: [
      { round: 1, promptTokens },
      { round: 2, promptTokens: finalTokens },
    ],
    requests: 2,
  }
}

/** 调真实端点跑一次，拿 usage。 */
async function realCall(endpoint, key, model, system, userText) {
  const url = endpoint.replace(/\/+$/, '') + '/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  })
  if (!res.ok) {
    return { ok: false, status: res.status, text: await res.text().catch(() => '') }
  }
  const body = await res.json()
  return { ok: true, usage: body.usage ?? null }
}

/** 主流程。 */
async function main() {
  const real = process.argv.includes('--real')
  const system = makeSystem()
  const diff = makeDiff()

  const native = simulateNative(system, diff, 7)
  const ptc = simulatePtc(system, diff)

  const ratio = ptc.totalPromptTokens === 0 ? 0 : native.totalPromptTokens / ptc.totalPromptTokens
  const saved = native.totalPromptTokens - ptc.totalPromptTokens
  const savedPct = native.totalPromptTokens === 0 ? 0 : (saved / native.totalPromptTokens) * 100

  console.log('=== PTC vs native 上下文开销（估算） ===')
  console.log('固定输入：system ' + String(system.length) + ' 字符，diff ' + String(diff.length) + ' 字符')
  console.log('')
  console.log('native（7 轮工具调用）: ' + String(native.totalPromptTokens) + ' tokens / ' + String(native.requests) + ' 次请求')
  console.log('  ' + native.perRound.map((r) => 'r' + String(r.round) + '=' + String(r.promptTokens)).join(' '))
  console.log('ptc   （1 轮程序）    : ' + String(ptc.totalPromptTokens) + ' tokens / ' + String(ptc.requests) + ' 次请求')
  console.log('  ' + ptc.perRound.map((r) => 'r' + String(r.round) + '=' + String(r.promptTokens)).join(' '))
  console.log('')
  console.log('节省: ' + String(saved) + ' tokens（' + savedPct.toFixed(1) + '%），约为 native 的 1/' + ratio.toFixed(1))
  console.log('')
  console.log('注意：以上是字符/3 的估算，只看量级。真实数字请看下面 --real 的结果。')

  if (!real) {
    console.log('')
    console.log('（未启用 --real：不联网，不产生费用）')
    return
  }

  const endpoint = process.env.BENCH_ENDPOINT
  const key = process.env.BENCH_KEY
  const model = process.env.BENCH_MODEL
  if (!endpoint || !key || !model) {
    console.error('')
    console.error('--real 需要 BENCH_ENDPOINT / BENCH_KEY / BENCH_MODEL 三个环境变量')
    process.exitCode = 2
    return
  }

  console.log('')
  console.log('=== 真实端点 usage ===')
  const r = await realCall(endpoint, key, model, system, diff)
  if (!r.ok) {
    console.error('调用失败 status=' + String(r.status) + '：' + String(r.text).slice(0, 300))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(r.usage, null, 2))
  console.log('（真实 usage 只反映这一次请求；多轮对比需要把 runs 拆开跑，属于后续实验）')
}

void main()
