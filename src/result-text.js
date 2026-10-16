/**
 * result-text.js —— 评审执行结果 → 会话内文本的组装（唯一定义点）。
 *
 * 两个消费者共享同一组装逻辑：index.js 的同步回退形态（buildSyncResultText
 * 曾为此保留一份拷贝）与 serve-entry.js 的后台完成通知。两处此前各写一份
 * 「同源组装」，编辑不同步就会漂移（「非零退出但仍有部分 stdout」的失败
 * 路径呈现曾因此不一致）。抽到本模块后只有一个入口，改一处即两边生效。
 *
 * 组装契约：
 *  - 成功：stdout 空时给「(引擎无输出)」占位，不以空串糊弄调用方；
 *  - 失败：stderr 优先（异常栈/报错原因），stdout 附后，两者都空才走占位；
 *  - 报告路径/模型注记/敏感点名段统一收尾（tail），与落盘报告互补不重复。
 *
 * 零敏感：不包含任何平台标识。
 */

/**
 * 组装评审结果文本。
 *
 * @param {object} exec 执行结果（executeReview 返回值或任务 result）：
 *   ok / code / stdout / stderr / elapsedSec / reportPath / modelNote /
 *   sensitiveBlock。
 * @returns {string} 会话内呈现的完整文本。
 */
export function buildResultText(exec) {
  // elapsedSec 契约为 number（秒，失败路径为 0）；Number() 兜底历史任务簿
  // 里的 string 残留（早期版本可能落过字符串），toFixed(1) 统一展示精度。
  const elapsedText = `${Number(exec.elapsedSec ?? 0).toFixed(1)}s`;
  // 退出码可能是 null（catch / 参数非法 / 引擎缺失 / spawn 错误 / 超时等路径），
  // 直接插值会渲染成「退出码 null」。缺码时整段省略（不提退出码）。
  const codeText = (exec.code !== null && exec.code !== undefined) ? `，退出码 ${exec.code}` : '';
  const header = exec.ok
    ? `## 代码审查完成（${elapsedText}）\n\n以下为引擎 codecheck 的评审结果：`
    : `## 代码审查失败（${elapsedText}${codeText}）\n\n引擎报错：`;
  // 失败路径 stderr 优先、stdout 附后；String 兜底防执行体返回缺省字段。
  const stdout = String(exec.stdout ?? '').trim();
  const stderr = String(exec.stderr ?? '').trim();
  const bodyText = exec.ok
    ? (stdout || '(引擎无输出)')
    : [stderr, stdout].filter(Boolean).join('\n\n') || '(引擎无输出)';
  // 提前算出两个分支各自的「报告行」，避免在模板串里嵌三元（禁嵌套三元红线）。
  const reportNote = exec.reportPath ? `，但已留档记录：${exec.reportPath}` : '';
  const reportLine = exec.ok
    ? `报告已留档：${exec.reportPath ?? '（落盘失败）'}`
    : `（本次失败未产生有效报告${reportNote}）`;
  const tail = [
    '',
    '---',
    reportLine,
    exec.modelNote ? `> ${exec.modelNote}` : null,
    exec.sensitiveBlock || null,
  ]
    .filter(Boolean)
    .join('\n');
  return `${header}\n\n${bodyText}\n${tail}`;
}
