// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * rules.ts —— 评审规则的唯一真源与匹配。
 *
 * 三条固定视角是产品定位（用户 2026-10-12 拍板），不因重写而变：
 *   ① 安全审核（脱敏 + 安全漏洞）
 *   ② 找 bug
 *   ③ 冗余与任务无关代码
 *
 * 语言规则从 0.1.3 的 54 份 rule_docs 收敛为首发常用的几种：
 * 规则越多，system prompt 的稳定前缀越大，每次都付同样的钱。
 * 取舍：覆盖面换 token 成本。后续可按需扩充（扩充时保证顺序稳定，
 * 否则会破坏缓存前缀 —— 见 prompt/system.ts 的排序约定）。
 */

/** 规则文档。 */
export interface RuleDoc {
  /** 稳定 id（报告里引用，也是缓存哈希的一部分）。 */
  readonly id: string
  /** 匹配的扩展名（含点，小写）；空数组表示默认规则。 */
  readonly extensions: readonly string[]
  /** 规则正文。 */
  readonly body: string
}

/** 三条固定视角（永远生效，且永远排在最前）。 */
export const MANDATORY_RULES = [
  '## 固定评审视角（三选一标注，可同时命中）',
  '',
  '### ① 安全审核（category: security / privacy）',
  '- 硬编码密钥、口令、Token、私钥（任何形式的明文凭据）',
  '- 个人身份信息（PII）：手机号、身份证号、邮箱、真实姓名、住址',
  '- 内部信息泄露：内网 IP、内部域名、公司内部项目名、内网服务地址',
  '- 常见安全缺陷：注入（SQL/命令/模板）、越权、不安全的反序列化、',
  '  路径穿越、不安全的随机数、缺失的鉴权、明文传输敏感数据',
  '- 判据：这段代码发布到公开仓库后，是否会暴露不该公开的信息或造成攻击面',
  '',
  '### ② 找 bug（category: bug）',
  '- 逻辑错误：条件写反、边界遗漏、循环越界、错误的默认值',
  '- 空值与类型：可能为 null/undefined 的解引用、类型断言掩盖的真实不匹配',
  '- 异常处理：吞掉异常、错误被当成功、资源未释放',
  '- 并发：竞态、共享可变状态、缺失的同步',
  '- 判据：在什么输入或时序下，这段代码会做出与预期不同的事',
  '',
  '### ③ 冗余与无关代码（category: redundancy / scope-creep）',
  '- 死代码、不可达分支、重复实现',
  '- 与本次改动目标无关的改动（顺手重构、格式化噪声、无关文件）',
  '- 过度设计：为假想需求提前引入的抽象',
  '- 判据：删掉它，功能和可维护性是否都不受影响',
].join('\n')

/** 语言规则（首发集合，顺序固定）。 */
export const LANGUAGE_RULES: readonly RuleDoc[] = [
  {
    id: 'lang-ts-js',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    body: [
      '### TypeScript / JavaScript 关注点',
      '- `any` 与类型断言（as）是否掩盖了真实类型不匹配',
      '- Promise 未 await / 未处理的 rejection',
      '- 可选链与空值判断是否覆盖全部路径',
      '- 闭包捕获的循环变量、事件监听未解绑',
      '- 原型污染（用户输入直接参与对象合并）',
    ].join('\n'),
  },
  {
    id: 'lang-go',
    extensions: ['.go'],
    body: [
      '### Go 关注点',
      '- error 被忽略或只打印不返回',
      '- goroutine 泄漏、channel 无缓冲死锁',
      '- 切片共享底层数组导致的意外修改',
      '- defer 在循环内累积',
      '- 接口 nil 与类型 nil 的区别',
    ].join('\n'),
  },
  {
    id: 'lang-python',
    extensions: ['.py'],
    body: [
      '### Python 关注点',
      '- 可变默认参数（def f(x=[])）',
      '- 裸 except 吞掉 KeyboardInterrupt',
      '- 异常路径下的资源释放（with 缺失）',
      '- 整数除法与浮点精度边界',
    ].join('\n'),
  },
  {
    id: 'lang-java',
    extensions: ['.java', '.kt'],
    body: [
      '### Java / Kotlin 关注点',
      '- 受检异常被包装成 RuntimeException 丢失原因',
      '- 集合遍历中修改集合',
      '- 资源未 try-with-resources',
      '- equals/hashCode 不成对',
      '- 可变对象作为 Map 的 key',
    ].join('\n'),
  },
]

/** 取文件扩展名（小写，含点）。 */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/**
 * 为一组文件解析规则块。
 *
 * 顺序稳定性很重要：同一批文件必须产出**逐字节相同**的规则文本，
 * 否则 prompt 前缀哈希会变，缓存全灭。因此这里按规则 id 排序而非按输入顺序。
 */
export function resolveRules(files: readonly string[]): string {
  const hit = new Map<string, RuleDoc>()
  for (const f of files) {
    const ext = extOf(f)
    for (const rule of LANGUAGE_RULES) {
      if (rule.extensions.includes(ext)) hit.set(rule.id, rule)
    }
  }
  const blocks = [...hit.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.body)
  return [MANDATORY_RULES, ...blocks].join('\n\n---\n\n')
}
