/**
 * set-config-tool.js —— 原生工具 code_review_set_config。
 *
 * 作用：会话/AI 程序化读写插件运行配置（评审模型、报告目录、引擎路径等）。
 * 写入目标是插件自有配置文件（~/.dsh/dsh-code-review/plugin-config.json，
 * 见 file-config.js）——这是 0.2.0-rc.2 宿主回传链路失效后插件自己的运行真源，
 * 写入后**下一次评审立即生效**（getConfig 每次调用都重新读文件，无需重启客户端）。
 *
 * 语义：
 *  - 传了哪个字段就写哪个（merge）；传空串 '' 或 null = 清空该字段恢复默认；
 *  - 一个字段都不传 = 只查询当前生效配置；
 *  - 返回值含生效配置全量（含默认值补齐）+ 配置文件路径，供发起方确认；
 *  - engine_bin 写入前做存在性校验（外部可控的可执行路径——防提示注入把后续
 *    评审变成任意可执行文件执行；传空串清空跳过校验）。
 *
 * 零敏感：字段值是用户传入的模型标识/路径文本，工具描述不点名任何供应商；
 * 配置文件在用户态 DSH_HOME。
 *
 * @module dsh-code-review/set-config-tool
 */
import { writeFileConfig, PLUGIN_CONFIG_FILE } from './file-config.js';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { cwdOfExec } from './exec-context.js';

/** 配置工具名（独立于 code_review / code_review_status 的第三入口）。 */
export const SET_CONFIG_TOOL_NAME = 'code_review_set_config';

/** 受支持的写入键：presentCall 谓词与 execute 的 patch 生成必须同源（写
 * 行为标定、title 文案取自同一集合，另加键只改这一处）。 */
const WRITABLE_KEYS = ['review_model', 'report_dir', 'engine_bin'];

/**
 * 创建配置读写工具。
 *
 * @param {object} ctx        Cordis 上下文（仅用于日志）。
 * @param {Function} getConfig 实时配置读取函数（返回归一化后的完整生效配置）。
 * @param {object} [io]       依赖注入（测试用）：writeFileConfig/PLUGIN_CONFIG_FILE。
 * @returns {object} 工具对象（ctx.tools.register 直接消费）。
 */
export function createSetConfigTool(ctx, getConfig, io = {}) {
  const store = io.writeFileConfig || writeFileConfig;
  const configFile = io.PLUGIN_CONFIG_FILE || PLUGIN_CONFIG_FILE;
  const tool = SET_CONFIG_TOOL_NAME;
  return {
    name: tool,
    description: [
      '读写代码审查插件的运行配置（评审模型、报告目录、引擎路径等）。',
      '【写入即生效】本工具把配置写入插件自有配置文件（用户目录下），后续评审任务立即按新值执行——',
      '不需要改客户端设置面板、不需要重启（0.2.0 宿主「面板保存」对第三方插件暂不回传运行层，面板改值会落盘但不到运行时，以本工具为准）。',
      '参数：review_model（评审模型标识：留空/省略 = 沿用会话模型；传其他值 = 显式另选，如 DSH 模型配置里已有的模型名）；',
      'report_dir（评审报告落盘目录，支持 ~；传空串恢复默认 ~/dsh-code-review-reports）；',
      'engine_bin（引擎 codecheck 路径；留空 = 自动探测。写入路径前请先确认文件存在——不存在/目录会被拒绝写入）；',
      '一个参数都不传 = 只查询当前生效配置（含默认值补齐），返回全量字段。',
    ].join(' '),
    parameters: {
      type: 'object',
      // 只认 review_model / report_dir / engine_bin 三个键——
      // 此前 additionalProperties:true 时拼错键名（reviewModel 等）会静默不写入
      // 却返回「已写入」，产生误报；未知键由宿主参数校验拦下。
      additionalProperties: false,
      properties: {
        review_model: { type: ['string', 'null'], description: '评审模型标识。省略/空串/null = 沿用会话模型；其他值 = 显式另选的模型。' },
        report_dir: { type: ['string', 'null'], description: '报告目录（支持 ~）。空串/null 恢复默认。' },
        engine_bin: { type: ['string', 'null'], description: '引擎二进制路径。空串/null 恢复自动探测。传路径前请先确认文件存在——不存在/目录会被拒绝写入。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          config_path: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
    // 并发安全声明：writeFileConfig 是「读旧文件 → merge →
    // 写 tmp → rename」的读-改-写流程（file-config.js），无进程内互斥——两个
    // 会话/两次调用同时写会丢更新（后者基于旧快照覆盖前者的字段）；且 store
    // 后重读 getConfig 也可能混入其它会话刚写的值，回显成误导性确认。回退
    // false 让宿主串行化调用（本工具是低频管理操作，串行代价可忽略）。
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `${tool}：${WRITABLE_KEYS.some((k) => args?.[k] !== undefined) ? '写入配置' : '查询配置'}`,
      // 写配置文件是明显写行为——此前恒标 read 会误导权限判断/审计/UI 呈现；
      // 有字段待写即标 write。
      // 判定谓词与 execute 的 patch 生成同源——此前按 `Object.keys(args).length
      // > 0` 近似计数：传未知杂键（{foo: 1}）会标 write，而 execute 实际无事
      // 可做（patch 空 = 查询）。统一为「受支持字段是否被显式请求」，present
      // 与执行侧口径一致。
      kind: WRITABLE_KEYS.some((k) => args?.[k] !== undefined) ? 'write' : 'read',
      locations: [],
    }),
    async execute(args, _exec) {
      // 归一化：文档语义「传空串 '' 或 null = 清空该字段
      // 恢复默认」，但此前只判 !== undefined——传 null 会被 String(null) 写成
      // 字面量 "null" 落盘，而 normalizeConfig 只认非空字符串，于是 "null" 被
      // 当合法值生效（review_model: "null" 传给引擎 = 评审必失败，配置被污染）。
      // 统一归一化：null / 全空白串 → null（占位，normalizeConfig 跳过回退默认）。
      // 字符串值整体 trim——带首尾空格的路径按原样
      // resolve 会解析出「带空格的路径」落盘而校验及消费端都按 trim 后的语义
      // （落盘侧 sanitizePatch 同样 trim），两侧口径必须一致：写入即 trim。
      const normalizeValue = (v) => {
        // 只接受字符串与 null：宿主 schema 之外若传入 undefined/数字/对象，
        // 旧实现 String(v) 会把 undefined 写成字面量 "undefined"（配置被污染）。
        // 非字符串一律按 null（占位清空语义）处理，绝不做隐式字符串化。
        if (v === null || v === undefined) return null;
        if (typeof v !== 'string') return null;
        const s = v;
        return s.trim() === '' ? null : s.trim();
      };
      const patch = {
        ...(args?.review_model !== undefined ? { review_model: normalizeValue(args.review_model) } : {}),
        ...(args?.report_dir !== undefined ? { report_dir: normalizeValue(args.report_dir) } : {}),
        ...(args?.engine_bin !== undefined ? { engine_bin: normalizeValue(args.engine_bin) } : {}),
      };
      // engine_bin 安全校验：该值原样落盘后会被引擎定位
      // 逻辑作为 spawn 候选二进制（cfg.engine_bin 优先级最高），且支持相对
      // 路径/`~`——恶意输入（提示注入写 /tmp/evil、../../foo）即可把后续评审
      // 变成任意可执行文件执行。写入前校验：展开 ~、resolve 规范化后必须
      // 存在且是文件（目录/不存在一律拒绝，整体拒绝本次写入）；null（清空）
      // 跳过校验。
      // #1 这里曾用 `!= null` + 嵌套三元（`~`/`~/`/其他），
      // 违反项目禁嵌套三元规约且 loose 比较掩盖 null 语义；#2 校验通过后的
      // 落盘值改为规范化绝对路径——此前存原始形态（`~/x`/相对路径），消费端
      // locateEngineBin 用 existsSync 按字面值判断（不展开 `~`、相对 cwd 解析），
      // 与校验时的展开结果不一致，必然「校验通过、运行时找不到」；
      // #3 `~`（仅 home）之外补 `~\`（Windows 风格 home 前缀），与 report.js
      // expandHome 的判定面一致。
      // 严格双判（!== null && !== undefined）：normalizeValue 只产出 string|null，
      // undefined 不可达，但防御未来改动引入。
      // 引擎路径校验结果；null = 通过或无需校验（
      // 校验失败不再整体拒绝本次写入——与「逐字段合并」语义一致：只剔除
      // engine_bin，其余字段照常落盘，原因进回显；整单只剩该字段时下方
      // 统一按拒绝收尾，保证失败可见）。
      let engineBinRejected = null;
      if (patch.engine_bin !== null && patch.engine_bin !== undefined) {
        // candidate 构造（resolve/join）纳入 try——
        // 含 NUL 字节等非法字符的路径会让 resolve 抛 ERR_INVALID_ARG_VALUE，
        // 此前这条异常逃出 execute（不经校验 catch），工具执行直接爆炸而非
        // 返回结构化拒绝。现在统一走「校验异常」拒绝路径。
        let candidate;
        try {
          if (patch.engine_bin === '~') {
            candidate = homedir();
          } else if (patch.engine_bin.startsWith('~/') || patch.engine_bin.startsWith('~\\')) {
            candidate = join(homedir(), patch.engine_bin.slice(2));
          } else {
            // 相对路径以**调用方会话目录**为基准解析（宿主进程自身 cwd 恒为
            // 安装 profile 目录，相对用户路径在那里 resolve 必然错位）；取不到
            // 会话目录才回落 process.cwd()（至少不是宿主目录？不——process.cwd()
            // 就是这个宿主目录，此时相对路径几乎必错，但校验会拦下并回显解析
            // 结果，用户能看出路径不对；绝不在校验层悄悄猜一个目录）。
            candidate = resolve(cwdOfExec(_exec) ?? process.cwd(), patch.engine_bin);
          }
          // win32 下消费端 locateEngineBin 对
          // engine_bin 会同时试字面与加 .exe 两个形态（EXE 候选），校验只查
          // 字面会把 `C:\tools\codecheck` 这类合法输入误拒（用户手里就是
          // codecheck.exe）。字面不存在时回退候选 + '.exe'，命中则落盘该形态。
          if (process.platform === 'win32'
            && (!existsSync(candidate) || !statSync(candidate).isFile())) {
            const withExe = `${candidate}.exe`;
            if (existsSync(withExe) && statSync(withExe).isFile()) candidate = withExe;
          }
          if (!existsSync(candidate) || !statSync(candidate).isFile()) {
            engineBinRejected = `engine_bin 校验失败：\`${patch.engine_bin}\` 解析为 \`${candidate}\`，不存在或不是文件（传空串可恢复自动探测）。`;
          } else {
            // 补可执行位校验（accessSync X_OK；Windows
            // 上 X_OK 按 Node 语义只验存在性，POSIX 验可执行位）——「存在且是
            // 文件」仍挡不住把 .txt 之类不可执行的普通文件填进来。注释口径收敛：
            // 本校验是**提示性防线**（拦截明显的错误输入/常规投毒路径），不是
            // 安全边界——用户显式指定任意文件本就是授权行为（engine_bin 的
            // 语义就是「用户自选引擎路径」）。
            try {
              accessSync(candidate, constants.X_OK);
            } catch {
              engineBinRejected = `engine_bin 校验失败：\`${candidate}\` 存在但不可执行（权限不足或非可执行文件，传空串可恢复自动探测）。`;
            }
          }
        } catch (error) {
          engineBinRejected = `engine_bin 校验异常：${String(error?.message ?? error)}（该字段未写入，其余字段不受影响）`;
        }
        if (engineBinRejected !== null) {
          delete patch.engine_bin;
        } else {
          // 落盘规范化绝对路径（校验与消费端同一视角）。
          patch.engine_bin = candidate;
        }
      }
      // 整单只剩被拒的 engine_bin（其余字段时照写，拒绝原因进回显）。
      if (Object.keys(patch).length === 0 && engineBinRejected !== null) {
        return {
          ok: false,
          config_path: configFile,
          text: `## 代码审查插件配置（写入被拒）\n\n- ${engineBinRejected}\n- 已拒绝写入，现有配置未改动。`,
        };
      }
      let wrote = false;
      if (Object.keys(patch).length > 0) {
        // 写盘异常透出：writeFileConfig 在 mkdir/write/rename
        // 失败时抛错（其注释明确「调用方负责透出」）——此前无 try/catch，失败
        // 时整个 execute 抛异常而成功路径 ok 恒 true，调用方无法区分
        // 「已写入 / 写入失败 / 仅查询」。失败返回 ok:false + 原因。
        try {
          store(patch); // 同步实现，失败会抛出
          wrote = true;
        } catch (error) {
          return {
            ok: false,
            config_path: configFile,
            text: `## 代码审查插件配置（写入失败）\n\n- 配置文件：\`${configFile}\`\n- 错误：${String(error?.message ?? error)}`,
          };
        }
      }
      // 写后重读：getConfig 每次调用都读文件 → 立即包含新值。
      const active = getConfig();
      const lines = [
        `## 代码审查插件配置${wrote ? '（已写入）' : '（当前生效）'}`,
        '',
        `- 配置文件：\`${configFile}\``,
        `- 评审模型：\`${active.review_model}\``,
        `- 报告目录：\`${active.report_dir}\``,
        `- 引擎路径：\`${active.engine_bin || '（自动探测）'}\``,
        // 部分字段被拒（engine_bin 校验失败）时
        // 成功回显必须带拒绝说明——「写入成功」只是其余字段成功，被拒字段
        // 不可静默消失。
        ...(engineBinRejected !== null ? ['', `- ⚠ ${engineBinRejected}（该字段未写入，其余字段已生效）`] : []),
        '- 提示：面板「设置」里的同名字段在 0.2.0 宿主对第三方插件的回传通道修复前暂不生效，以本工具/本配置文件为准。',
      ];
      return { ok: true, config_path: configFile, text: lines.join('\n') };
    },
  };
}
