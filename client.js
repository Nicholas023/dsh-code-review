// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * client.js —— dsh-code-review 的 Web（浏览器）侧插件形态。
 *
 * ══ 为什么必须有这个文件 ══
 * package.json 声明了 `dsh.client: { platform: 'web' }`，宿主就会按「Web 客户端
 * 插件」协议加载本文件：期望其调用 `window.__ModuleLoader__.load({ id, factory })`
 * 注册自身（id 必须等于包名 dsh-code-review）。
 * ❌ 旧版是 `export default { id }`（占位导出）——宿主加载执行后没有任何
 *    `__ModuleLoader__.load` 调用 → 报
 *    `loaded without registering "dsh-code-review" via __ModuleLoader__.load`，
 *    且整个插件激活失败（服务端 settings 分区也没注册上 → 插件页/设置页都无入口）。
 *
 * ══ 设置通道（版本升级后定稿）══
 * 本机桌面客户端已是 **0.2.0-rc.2**：客户端设置域服务 = `configForms`
 * （旧 0.1.x 的 `settingsScope.bind` 是 0.1.x 形态，0.2.0 客户端已换 configForms）。
 *   - `ctx.configForms.get('dsh-code-review')` → 该插件条目的配置表单
 *     （form 数据 = 服务端 settings 文档中 ns=<插件 id> 的 section；
 *      服务端由 src/index.js registerSettings → settings.register(SETTINGS_NS, schema) 提供，
 *      SETTINGS_NS 恰等于插件条目 id 'dsh-code-review'，全链闭环）；
 *   - 本文件在「插件」页 slots `plugins.item` 注册一张**设置卡片**：
 *     顶部引导说明 + 四字段真实可写表单（暂存草稿 → 点保存才 set/unset 写入）。
 * 
 *   - 手写 JS + React.createElement（不走构建），React 由浏览器模块表 require('react') 提供；
 *   - 不 require 任何宿主 UI 包（官方劝阻第三方插件依赖 @deepseek-ai/dsh-client-ui-*）；
 *   - 字段渲染必须是普通函数而不是 React 组件（宿主可能重复求值）。
 *
 * 零敏感：无任何平台内部标识。
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ─────────────── 常量与样式 ─────────────── */

    /** 插件条目 id：configForms 入口 + slots 卡片 id + 服务端 SETTINGS_NS 三处同值。 */
    const ENTRY_ID = 'dsh-code-review';

    /**
     * 配置表单快照的形状校验（从 SettingsCard 的
     * useState 初始化与 subscribe 回调各复制一份改为模块级单源——这是防渲染
     * 崩溃的关键判据，两份漂移会让崩溃静默回归）。
     * @param {unknown} snap 宿主 form.getSnapshot() 的返回值。
     * @returns {boolean} 是否可用（对象 + 含 value 键 + writable 为布尔）。
     */
    // 除 value/writable 外还要求 status 是字符串：下游可写判定与诊断文案直接读
    // snapshot.status，缺字段时 writable 恒 false、界面显示「status=undefined」这类
    // 无从排查的只读态。
    // ⚠ DSH 0.2.1 起客户端 ConfigFormSnapshot 移除了 `mode` 字段
    // （0.2.0 为 'host' | 'memory'）——校验与可写判定都不再读它，否则快照判为坏形状、
    // 卡片永久只读（docs/upgrade-guide 无此条，属 0.2.1 客户端 API 变更）。
    const isUsableSnapshot = (snap) => !!(
      snap && typeof snap === 'object'
      && 'value' in snap
      && typeof snap.writable === 'boolean'
      && typeof snap.status === 'string'
    );

    /**
     * 设置字段表（键名与服务端 src/settings-schema.js 的 z.object 完全一致；
     * scripts/client-bundle-smoke.mjs 会做「界面字段 ≡ schema 键」双向一致性断言，
     * 字段数量或键名不一致会被拦下）。
     * group: common=常用（默认可见） / advanced=高级选项。
     * type: text=文本框 / boolean=开关 / number=数字输入（并发广度）。
     */
    const FIELDS = [
      {
        key: 'review_model', type: 'text', group: 'common', label: '评审模型',
        hint: '留空 = 沿用会话模型；可填 DSH 模型设置里已配置的其他模型 id（异构评审）。',
        placeholder: 'session',
      },
      {
        key: 'report_dir', type: 'text', group: 'common', label: '报告目录',
        hint: '评审报告按 日期/仓库 落盘的根目录；留空用默认值。',
        placeholder: '~/dsh-code-review-reports',
      },
      // 并发评审（默认关 = 单线；开启 = 并行。成本控制权在用户：
      // 开关 + 并发广度（条件展开）两字段，保存时同时写宿主表单与插件运行真源
      // （POST /api/code-review/config → plugin-config.json，见 save()）。
      {
        key: 'concurrency_enabled', type: 'boolean', group: 'common', label: '并发评审',
        hint: '关闭 = 单线顺序审查（默认）。开启 = 并行审查、提速明显，但 token 消耗随之增加（成本由你控制）。',
      },
      {
        key: 'concurrency', type: 'number', group: 'common', label: '并发广度',
        hint: '并行审查的会话数（1–32，默认 8）。越大越快，但 token 消耗与端点限流风险越高。',
        placeholder: '8', min: 1, max: 32,
      },
      {
        key: 'engine_bin', type: 'text', group: 'advanced', label: '引擎路径（可选）',
        hint: 'codecheck 可执行文件路径；留空自动在 PATH 查找。',
        placeholder: 'codecheck',
      },
      {
        key: 'first_run', type: 'boolean', group: 'advanced', label: '首次运行引导',
        hint: '勾选时首次评审会附带引擎安装指引；评审过一次后自动关闭。',
      },
    ];

    /** 按 key 取字段定义（条件展开 / 保存逻辑用）。 */
    const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

    /** 并发广度取值域（与服务端 src/config.js 的 CONCURRENCY_* 常量对齐）。 */
    const CONCURRENCY_DEFAULT = 8;
    const CONCURRENCY_MIN = 1;
    const CONCURRENCY_MAX = 32;

    /** 并发广度钳制：1..32 整数；非有限（含空串/乱填）回退默认 8。 */
    function clampConcurrency(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return CONCURRENCY_DEFAULT;
      return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.round(n)));
    }

    /** 宿主 webServer 数据路由（相对路径 fetch 走宿主认证通道，同源可用）。
     *  收敛为模块级常量：接口路径变更时只需改一处，避免 save()/resetAll()/任务卡漏改。 */
    const CONFIG_API = '/api/code-review/config';
    const TASKS_API = '/api/code-review/tasks';

    /**
     * 并发设置同步写运行真源（POST CONFIG_API → 插件 webServer 路由 →
     * plugin-config.json）。0.2.0 宿主「面板保存」对第三方插件不回传运行层
     * （定案），设置面板保存时必须同步落运行真源，下一次评审
     * getConfig 热读取立即生效。save() 与 resetAll() 复用同一段 fetch 逻辑。
     *
     * @param {object} patch 白名单键补丁（服务端 file-config sanitizePatch 只收白名单键）。
     * @returns {Promise<Response>} 原始响应；调用方自行判断 resp.ok 并给出各自的界面提示。
     */
    async function postConfig(patch) {
      return window.fetch(CONFIG_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
    }

    /** 字段分组（渲染顺序 = 数组顺序）。 */
    const GROUPS = [
      { id: 'common', title: '常用', desc: '' },
      { id: 'advanced', title: '高级选项', desc: '' },
    ];

    /** 卡片样式：继承宿主主题色（currentColor 混色），随组件挂载。 */
    const STYLE = `
      .dcr-card { display: block; }
      .dcr-desc { margin: 0 0 10px; opacity: .78; font-size: 13px; line-height: 1.7; }
      .dcr-row { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 6px 0; }
      .dcr-k { opacity: .6; min-width: 84px; flex: 0 0 auto; }
      .dcr-note { font-size: 12px; opacity: .62; margin-top: 12px; line-height: 1.7;
        border-top: 1px solid color-mix(in srgb, currentColor 13%, transparent); padding-top: 8px; }
      .dcr-code { font-family: ui-monospace, Consolas, monospace; font-size: 12px;
        background: color-mix(in srgb, currentColor 6%, transparent); padding: 1px 5px; border-radius: 4px; }
      .dcr-form { margin-top: 14px; border-top: 1px solid color-mix(in srgb, currentColor 13%, transparent); padding-top: 10px; }
      .dcr-group-title { font-size: 12px; font-weight: 600; opacity: .72; margin: 12px 0 6px; }
      .dcr-field { display: grid; grid-template-columns: minmax(110px, 1fr) 2.2fr; gap: 10px;
        align-items: center; margin: 8px 0; font-size: 13px; }
      .dcr-field label { opacity: .92; line-height: 1.45; }
      .dcr-field .dcr-hint { font-size: 12px; opacity: .6; margin-top: 2px; line-height: 1.5; }
      .dcr-input { width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
        background: color-mix(in srgb, currentColor 5%, transparent); color: inherit; font-size: 13px; }
      .dcr-input:disabled { opacity: .55; }
      .dcr-check { display: flex; align-items: center; gap: 8px; }
      .dcr-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
      .dcr-btn { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 6px;
        padding: 5px 12px; font-size: 13px; background: transparent; color: inherit; cursor: pointer; }
      .dcr-btn:disabled { opacity: .45; cursor: default; }
      .dcr-btn.primary { background: color-mix(in srgb, currentColor 14%, transparent); border-color: currentColor; }
      .dcr-btn.danger { border-color: color-mix(in srgb, #d33 55%, transparent); color: #d33; }
      .dcr-status { font-size: 12px; opacity: .62; margin-left: auto; }
      /* 任务卡（第二层：GUI 实时刷新） */
      .dcr-tasks { margin-top: 14px; border-top: 1px solid color-mix(in srgb, currentColor 13%, transparent); padding-top: 10px; }
      .dcr-task { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 0;
        border-bottom: 1px dashed color-mix(in srgb, currentColor 10%, transparent); }
      .dcr-task:last-child { border-bottom: none; }
      .dcr-task-icon { flex: 0 0 auto; width: 18px; text-align: center; }
      .dcr-task-main { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .dcr-task-id { font-family: ui-monospace, Consolas, monospace; font-size: 12px; opacity: .85; }
      .dcr-task-repo { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; opacity: .62; }
      .dcr-task-meta { margin-left: auto; flex: 0 0 auto; font-size: 12px; opacity: .72; text-align: right; }
      .dcr-task.done .dcr-task-icon { color: #2e8b57; }
      .dcr-task.failed .dcr-task-icon { color: #d33; }
      .dcr-em { color: #2e8b57; font-weight: 600; }
      .dcr-warn { color: #d33; }
    `;

    /** 文本值 → 显示串（undefined/null 视为空）。 */
    function toText(value) {
      return value === undefined || value === null ? '' : String(value);
    }

    /** 布尔 checkbox：勾选 = 显式 true；取消勾选 = 清除覆盖（回落默认）。 */
    function boolValue(value) {
      return Boolean(value);
    }

    /**
     * 设置卡片：暂存编辑 → 点保存才写入（与官方设置页交互一致）。
     * @param {object} props - slot 注入的视图参数 + 由 apply 闭包传入的 form（configForms 表单）。
     */
    function SettingsCard(props) {
      const form = props.form;
      // configForms 服务缺失 / 该条目未注册（宿主降级场景）时，apply 传入的 form
      // 会是 null/undefined：直接判空渲染只读提示卡，绝不让下方
      // form.getSnapshot()/form.subscribe() 抛异常打崩整个插件页。
      // ⚠️ hooks 规则：useState/useEffect 必须无条件执行，降级早退只能放在所有 hook 之后。
      // formUsable 不能只问「方法在不在」——getSnapshot
      // 实现异常或返回坏形状（undefined/null/缺 value 字段）会让渲染中途解引用抛错。
      // 初次快照求值包 try/catch + 对象形状校验；subscribe 回调同样兜底（坏快照
      // 保留当前显示，不 crash）。形状校验只认关键字段（value + 布尔 writable），
      // 其余字段由读取方各自容错。
      const formUsable = !!(form && typeof form.getSnapshot === 'function' && typeof form.subscribe === 'function');
      const [snapshot, setSnapshot] = React.useState(() => {
        const fallback = { value: {}, writable: false, status: 'unavailable' };
        if (!formUsable) return fallback;
        try {
          const snap = form.getSnapshot();
          if (isUsableSnapshot(snap)) return snap;
        } catch {
          /* 快照坏 → 走降级占位 */
        }
        return fallback;
      });
      /** 暂存：{ [key]: 文本值 | boolean }；null 表示无未保存改动。 */
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [savedAt, setSavedAt] = React.useState(null);
      /** 「全部恢复默认」的上膛态（破坏性操作两段式确认）。 */
      const [armed, setArmed] = React.useState(null);

      // 订阅 Host 侧快照（写入被接受后会推来新快照）；form 不可用时跳过订阅。
      React.useEffect(() => {
        if (!formUsable) return undefined;
        // 订阅回调的 getSnapshot 同样可能抛/返回坏形状
        // ——try/catch + 形状校验后再 setState，坏快照保留当前显示不 crash。
        const take = () => {
          try {
            const snap = form.getSnapshot();
            if (isUsableSnapshot(snap)) setSnapshot(snap);
          } catch {
            /* 忽略坏快照，保留当前 */
          }
        };
        let unsub = null;
        try {
          unsub = form.subscribe(take);
        } catch {
          return undefined;
        }
        return () => { try { unsub && unsub(); } catch { /* 忽略 */ } };
      }, [form]);

      // 降级早退（所有 hook 之后）：表单不可用 → 渲染只读提示卡，说明修复路径。
      if (!formUsable) {
        // 折叠态契约 = 返回摘要**字符串**（宿主按字符串
        // 消费/序列化），此前 summary 检查在降级分支之后——折叠且表单不可用
        // 时降级分支先命中，返回的是元素（h('div'...)），契约被破坏。summary
        // 优先于降级内容。
        if (props.view === 'summary') return '智能代码审查：设置表单暂不可用（configForms 未就绪），评审功能不受影响。';
        return h('div', { className: 'dcr-card' },
          h('style', null, STYLE),
          h('p', { className: 'dcr-desc' }, '设置表单暂不可用：宿主 configForms 服务未就绪，或插件条目未注册。'),
          h('p', { className: 'dcr-note' },
            '评审功能不受影响。设置项可在会话中用 code_review_set_config 调整，',
            // 表单在 apply 时解析一次、formUsable 此后
            // 不再变——「宿主服务恢复后自动变回可写」不可能发生，改述为真实
            // 恢复路径（重载插件页重新 apply）。
            '或直接编辑插件配置目录下的 plugin-config.json；重载插件页后恢复可写表单。'
          )
        );
      }


      const value = snapshot.value ?? {};
      /** 可写条件：Host 承载 + 状态 ready（0.2.1 起快照无 mode 字段，见 isUsableSnapshot 注释）。 */
      const writable = snapshot.writable && snapshot.status === 'ready';
      const diag = 'status=' + snapshot.status + ' writable=' + snapshot.writable
        + ' revision=' + (snapshot.revision === undefined ? '-' : snapshot.revision)
        + ' 生效字段=' + Object.keys(value).length;

      /** 该字段是否已被显式设置过（区别于「留空 = 回落默认」）。 */
      const hasValue = (field) => {
        const raw = value[field.key];
        if (field.type === 'boolean') return raw === true || raw === false;
        return raw !== undefined && raw !== null && String(raw) !== '';
      };
      const isDirtyKey = (key) => !!(draft && Object.prototype.hasOwnProperty.call(draft, key));

      /** 当前显示值：优先暂存值，其次 Host 生效值。 */
      const shown = (field) => {
        if (draft && Object.prototype.hasOwnProperty.call(draft, field.key)) {
          if (field.type === 'boolean') return Boolean(draft[field.key]);
          return toText(draft[field.key]);
        }
        if (field.type === 'boolean') return boolValue(value[field.key]);
        return toText(value[field.key]);
      };

      /**
       * 写入草稿。若改回原值则从草稿里删掉该键——否则「改了又改回来」会一直显示有未保存改动。
       */
      const edit = (field, next) => {
        setSavedAt(null);
        setError(null);
        setArmed(null);
        setDraft((prev) => {
          const base = Object.assign({}, prev || {});
          const original = field.type === 'boolean' ? boolValue(value[field.key]) : toText(value[field.key]);
          if (String(original) === String(next)) delete base[field.key];
          else base[field.key] = next;
          return Object.keys(base).length > 0 ? base : null;
        });
      };

      const dirtyKeys = draft ? Object.keys(draft) : [];
      const dirty = dirtyKeys.length > 0;

      /** 文本字段解析：trim 后空串 = 清除覆盖（回落默认）。 */
      const parseText = (field, raw) => {
        const t = typeof raw === 'string' ? raw.trim() : toText(raw).trim();
        return t === '' ? undefined : t;
      };

      /** 保存：逐个字段 set（有值）或 unset（清空 = 恢复默认）。 */
      const save = async () => {
        if (!dirty) return;
        setBusy(true);
        setError(null);
        try {
          for (const field of FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue;
            const raw = draft[field.key];
            let ok;
            if (field.type === 'boolean') {
              // 勾选 = 显式 true；取消勾选 = 清除覆盖（回落默认）
              ok = raw ? await form.set(field.key, true) : await form.unset(field.key);
            } else if (field.type === 'number') {
              // 并发广度：空 = 清除覆盖（回落默认 8）；非空 = 钳制 1..32 后写入数字值。
              const trimmed = toText(raw).trim();
              ok = trimmed === '' ? await form.unset(field.key) : await form.set(field.key, clampConcurrency(trimmed));
            } else {
              const parsed = parseText(field, raw);
              ok = parsed === undefined ? await form.unset(field.key) : await form.set(field.key, parsed);
            }
            if (ok === false) throw new Error('保存被 Host 拒绝：' + field.key);
            // 宿主 configForms 表单 API 的
            // set/unset 以**显式 false** 表示拒绝（拒绝也走 throw 通道，见
            // save 外层 catch）；保持 `=== false` 精确判定而不改 `!== true`
            // ——后者会把「成功但返回 undefined」的宿主实现误判成失败（噪
            // 声比漏判更糟）。若某宿主改用 undefined 表示拒绝，需同步此判定。
            // 注：本仓库的 client-bundle-smoke 用 stub 表单（set/unset 恒返回
            // true）验证渲染链路，**不覆盖**拒绝语义——该语义是对宿主行为的
            // 契约描述，留待接入真实宿主时按实测校准。
          }
          // 并发两字段同步写运行真源（0.2.0 宿主「面板保存」对
          // 第三方插件不回传运行层（定案），只写宿主表单 = 开关摆设；
          // 这里 POST /api/code-review/config → 插件 webServer 路由 → plugin-config.json，
          // 下一次评审 getConfig 热读取立即生效。成本旋钮写失败必须明示用户。
          const ccEnabledField = FIELD_BY_KEY['concurrency_enabled'];
          const ccField = FIELD_BY_KEY['concurrency'];
          const ccPatch = {};
          if (Object.prototype.hasOwnProperty.call(draft, ccEnabledField.key)) {
            ccPatch.concurrency_enabled = Boolean(draft[ccEnabledField.key]);
          }
          if (Object.prototype.hasOwnProperty.call(draft, ccField.key)) {
            const trimmed = toText(draft[ccField.key]).trim();
            ccPatch.concurrency = trimmed === '' ? null : clampConcurrency(trimmed);
          }
          if (Object.keys(ccPatch).length > 0) {
            const resp = await postConfig(ccPatch);
            if (!resp.ok) throw new Error('界面已保存，但并发设置运行层写入失败（HTTP ' + resp.status + '，webServer 路由不可用？）');
          }
          setDraft(null);
          setSavedAt(new Date());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      /** 丢弃草稿（恢复为 Host 当前生效值）。 */
      const discard = () => { setDraft(null); setError(null); setSavedAt(null); setArmed(null); };

      /** 全部恢复默认：清空所有字段的覆盖（两段式确认）。 */
      const resetAll = async () => {
        if (armed !== 'resetAll') { setArmed('resetAll'); setError(null); return; }
        setArmed(null);
        setBusy(true);
        setError(null);
        try {
          // 逐字段清除覆盖；显式拒绝（返回 false）时立即报错，杜绝「界面显示已恢复
          // 默认、宿主实际仍生效」的不一致（与 save() 的 ok === false 判定对齐）。
          for (const field of FIELDS) {
            const ok = await form.unset(field.key);
            if (ok === false) throw new Error('恢复默认被 Host 拒绝：' + field.key);
          }
          // 并发两字段同步清空运行真源（恢复默认：单线 + 并发广度 8）。
          // 清理失败只提示不抛——界面恢复默认本身已成功，成本旋钮下次保存会重写。
          try {
            const resp = await postConfig({ concurrency_enabled: null, concurrency: null });
            if (!resp.ok) setError('界面已恢复默认，但并发设置运行层清理失败（HTTP ' + resp.status + '）');
          } catch (err) {
            setError('界面已恢复默认，但并发设置运行层清理失败：' + String((err && err.message) || err));
          }
          setDraft(null);
          setSavedAt(new Date());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      };

      // 插件页折叠态只需要一句摘要
      if (props.view === 'summary') return '智能代码审查：安全脱敏 / 找 bug / 冗余检测三视角评审，设置项在本卡下方。';

      /** 渲染单个字段 → 两列 grid 子项（标签 + 控件）。⚠ 普通函数而非 React 组件。 */
      const renderField = (field) => {
        if (field.type === 'boolean') {
          return [
            h('div', { key: field.key + '-label' },
              h('div', null, field.label),
              field.hint ? h('div', { className: 'dcr-hint' }, field.hint) : null
            ),
            h('label', { key: field.key + '-input', className: 'dcr-check' },
              h('input', {
                type: 'checkbox',
                checked: boolValue(shown(field)),
                disabled: !writable || busy,
                onChange: (event) => edit(field, event.target.checked)
              }),
              h('span', null, boolValue(shown(field)) ? '开启' : '关闭（默认）')
            )
          ];
        }
        if (field.type === 'number') {
          // 数字输入（并发广度）：HTML number 控件 + 1..32 约束；编辑仍走文本草稿。
          return [
            h('div', { key: field.key + '-label' },
              h('div', null, field.label),
              field.hint ? h('div', { className: 'dcr-hint' }, field.hint) : null
            ),
            h('input', {
              key: field.key + '-input',
              className: 'dcr-input',
              type: 'number',
              min: field.min ?? CONCURRENCY_MIN,
              max: field.max ?? CONCURRENCY_MAX,
              step: 1,
              value: toText(shown(field)),
              disabled: !writable || busy,
              placeholder: field.placeholder || '（默认）',
              onChange: (event) => edit(field, event.target.value)
            })
          ];
        }
        return [
          h('div', { key: field.key + '-label' },
            h('div', null, field.label),
            field.hint ? h('div', { className: 'dcr-hint' }, field.hint) : null
          ),
          h('input', {
            key: field.key + '-input',
            className: 'dcr-input',
            type: 'text',
            value: toText(shown(field)),
            disabled: !writable || busy,
            placeholder: field.placeholder || '（默认）',
            onChange: (event) => edit(field, event.target.value)
          })
        ];
      };

      /** 渲染一组字段（字段按 GROUPS 顺序平铺；并发广度按开关条件展开）。 */
      const renderGroup = (group) => {
        // 条件展开（用户拍板 UI 形态）：默认只显示「并发评审」开关；
        // 开关开启后才展开「并发广度」设置项。concurrency_enabled 本身恒显示。
        const switchField = FIELD_BY_KEY['concurrency_enabled'];
        const concurrencyOn = switchField ? Boolean(shown(switchField)) : false;
        const fields = FIELDS
          .filter((field) => field.group === group.id)
          .filter((field) => field.key !== 'concurrency' || concurrencyOn);
        if (fields.length === 0) return null;
        const groupSet = fields.filter(hasValue).length;
        return h('div', { key: group.id },
          h('div', { className: 'dcr-group-title' }, group.title + (groupSet > 0 ? '（已自定义 ' + groupSet + '）' : '')),
          h('div', { className: 'dcr-form-body' }, ...fields.flatMap(renderField))
        );
      };

      // 状态文案：按「不可写 > 保存失败 > 已保存 > 有未保存改动」优先级取一。
      // 用 if/else 计算而非嵌套三元（项目规约禁嵌套三元，可读性差且易加错优先级）。
      let statusText = '';
      if (!writable) statusText = '（当前不可写入：' + diag + '）';
      else if (error) statusText = '保存失败：' + error;
      else if (savedAt) statusText = '已保存 ' + savedAt.toLocaleTimeString();
      else if (dirty) statusText = '有未保存的改动';

      // 保存按钮文案：同 statusText 的处理方式（if/else 取值），不再用内联 IIFE
      // ——每次渲染都会新建一个函数对象，且与上方规约（禁嵌套三元、分支直写）
      // 风格不一致。
      let saveLabel = '保存';
      if (busy) saveLabel = '保存中…';
      else if (dirty) saveLabel = '保存改动（' + dirtyKeys.length + '）';

      return h('div', { className: 'dcr-card' },
        h('style', null, STYLE),
        h('p', { className: 'dcr-desc' },
          '对代码仓库执行「安全脱敏 / 找 bug / 冗余与任务无关代码」三视角评审：会话内返回问题清单，并落一份报告文件留档。'
        ),
        h('div', { className: 'dcr-row' },
          h('span', { className: 'dcr-k' }, '使用方式'),
          h('span', null, '会话里说「审一下 X」，或输入斜杠命令 ', h('code', { className: 'dcr-code' }, '/review'))
        ),
        h('div', { className: 'dcr-form' },
          h('p', { className: 'dcr-desc' },
            '下面的设置写入 DSH profile 并立即生效；留空的项沿用插件默认值。'
          ),
          ...GROUPS.map(renderGroup).filter(Boolean),
          h('div', { className: 'dcr-actions' },
            h('button', { className: 'dcr-btn primary', type: 'button', disabled: !writable || busy || !dirty, onClick: save },
              saveLabel),
            h('button', { className: 'dcr-btn', type: 'button', disabled: !writable || busy || !dirty, onClick: discard }, '放弃改动'),
            h('button', { className: 'dcr-btn danger', type: 'button', disabled: !writable || busy, onClick: resetAll },
              armed === 'resetAll' ? '再点一次确认恢复' : '全部恢复默认'),
            h('span', { className: 'dcr-status' }, statusText)
          )
        ),
        h('p', { className: 'dcr-note' },
          '引擎 codecheck 未就绪时，会在会话侧给出安装提示；',
          '评审模型选项 = DSH 模型设置里已配置的模型（沿用会话模型为默认）。',
          '并发评审默认关闭（单线）；开启后并发广度 1–32，并行多路会成倍增加 token 消耗，成本由你控制。'
        )
      );
    }

    /* ─────────────── 任务卡（第二层：GUI 实时刷新） ─────────────── */

    /** 任务状态图标与文案（与 src/task-api.js 的列表摘要字段一一对应）。 */
    const TASK_ICON = { queued: '🕐', running: '⏳', done: '✅', failed: '❌' };
    const TASK_TEXT = { queued: '排队中', running: '评审中', done: '已完成', failed: '失败' };

    /** 任务耗时人类化（elapsedSec 为秒；Number()
     *  归一化——任务簿里历史任务的 elapsedSec 曾是字符串（toFixed 产物），
     *  数值比较/除法在 string 下全靠「字典序碰巧方向对」才没炸）。 */
    function fmtElapsed(raw) {
      if (raw === null || raw === undefined || raw === '') return '';
      const sec = Number(raw);
      // 非有限/负值（时钟回拨、脏数据）一律不展示——否则渲染成「-5s」或
      // 「Infinity 分钟」（Infinity >= 60 走分钟分支）。
      if (!Number.isFinite(sec) || sec < 0) return '';
      if (sec >= 60) return (sec / 60).toFixed(1) + ' 分钟';
      return Math.round(sec) + 's';
    }

    /** 仓库路径 → 展示名（取末端一段）。 */
    function repoName(p) {
      const parts = String(p || '').split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '(默认目录)';
    }

    /**
     * 后台评审任务卡：轮询宿主路由 /api/code-review/tasks（5s 一次，
     * 相对路径 fetch 走宿主认证通道，同源可用）。发起评审即见任务行，
     * 完成/失败自动翻身为 ✅/❌ + 报告落盘提示——「GUI 里能看到后台任务」。
     * 路由不可用（宿主未提供 webServer / 插件页外环境）→ 静默降级一行提示。
     */
    function TasksCard(props) {
      // 钩子（useState/useEffect）必须无条件执行——
      // 摘要早退移到所有 hook 之后，与 SettingsCard 同款（宿主在同一个实例上
      // 切换 view 时 hook 数量恒定，跨视图渲染不会触发 React hooks 数量校验）。
      // summary 优先于正文返回摘要字符串（宿主折叠视图按字符串消费）。
      const [tasks, setTasks] = React.useState(null); // null = 尚未加载/加载失败
      const [loaded, setLoaded] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        let timer = null;
        // in-flight 保护：上一次请求未返回前不重叠发起（默认 5s 轮询，若请求耗时
        // 超过 5s，setInterval 会并发叠请求 → 慢网络下累积、响应乱序用旧数据覆盖新
        // 数据）。这里双重防线：timer 侧检查 + load 开头再挡一次（首次手动 load 同样受保护）。
        let inflight = false;
        // 请求序号守卫（fetch 悬挂时 inflight 由兜底
        // 定时器放行、新请求照发——旧请求的晚到响应必须按序号丢弃，否则乱序覆盖。
        let seq = 0;
        const load = async () => {
          if (inflight || !alive) return;
          inflight = true;
          const mySeq = ++seq;
          // fetch 悬挂（宿主路由进程挂死/网络黑洞）会让
          // inflight 永久 true、轮询停摆——8s 超时逃生：宿主有 AbortController 时
          // 中止请求走 catch（静默降级路径）；宿主无 AbortController 时退化为
          // 「定时器放行 inflight + 序号守卫」——下一轮轮询照常发起，悬挂请求的
          // 晚到响应按序号丢弃。两条路径都保证下一轮能发出。
          const ac = typeof AbortController === 'function' ? new AbortController() : null;
          const to = setTimeout(() => {
            if (ac) ac.abort();
            inflight = false; // 无 abort 能力时至少放行下一轮（序号守卫防乱序覆盖）
          }, 8000);
          try {
            const res = await window.fetch(TASKS_API, {
              headers: { accept: 'application/json' },
              signal: ac ? ac.signal : undefined,
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const body = await res.json();
            if (!alive || mySeq !== seq) return;
            setTasks(Array.isArray(body.tasks) ? body.tasks.slice(0, 5) : []);
            setLoaded(true);
          } catch {
            if (mySeq !== seq) return;
            // 静默降级：路由未挂载/网络不可用——保留已加载的旧列表
            // （首次失败显示空态），错误细节不外露，不打扰设置卡。失败不重试、不
            // 弹错：下一轮轮询自会再试，无需每 5s 重写相同状态（loaded 只翻转一次）。
            if (!alive) return;
            setLoaded(true);
            setTasks((prev) => (Array.isArray(prev) ? prev : []));
          } finally {
            clearTimeout(to);
            // 仅最新请求有权释放 inflight——降级路径
            // 8s 定时器已把 inflight 置 false，更新的请求（seq 更大）可能已
            // 接管标志；老请求 settle 时再清一次会放行第三重轮询（挂起请求
            // 逐个累积）。mySeq === seq 才清，「无重叠轮询」不变量才成立。
            if (mySeq === seq) inflight = false;
          }
        };
        load();
        timer = setInterval(() => { if (!inflight) load(); }, 5000);
        return () => { alive = false; if (timer) clearInterval(timer); };
      }, []);

      if (props.view === 'summary') return '智能代码审查：后台评审任务实时状态（发起评审返回任务 id，完成后自动落盘报告）。';

      const rows = Array.isArray(tasks) ? tasks : [];
      const latestDone = rows.find((t) => t.status === 'done');
      const runningCount = rows.filter((t) => t.status === 'running').length;

      return h('div', { className: 'dcr-card' },
        h('style', null, STYLE),
        h('div', { className: 'dcr-tasks' },
          h('div', { className: 'dcr-row' },
            h('span', { className: 'dcr-k' }, '后台任务'),
            h('span', null, runningCount > 0 ? h('span', { className: 'dcr-em' }, '『 ' + runningCount + ' 个评审进行中，不阻塞前台，慢模型没关系』') : '无进行中的评审'),
            h('span', { className: 'dcr-status' }, '5 秒自动刷新')
          ),
          loaded && rows.length === 0
            ? h('p', { className: 'dcr-note' }, '还没有评审任务。会话里说「审一下 X」，或输入 /review。')
            : rows.map((t) => {
                const icon = TASK_ICON[t.status] || '•';
                const text = TASK_TEXT[t.status] || t.status;
                const shortId = String(t.id).slice(-8);
                const when = (t.finishedAt || t.createdAt || '').slice(11, 19);
                // 任务行样式类：done/failed 各自着色，其余不加类（if/else 取代嵌套三元，项目规约）。
                let taskCls = '';
                if (t.status === 'done') taskCls = 'done';
                else if (t.status === 'failed') taskCls = 'failed';
                const meta =
                  (text + (t.elapsedSec !== null && t.elapsedSec !== undefined ? ' · ' + fmtElapsed(t.elapsedSec) : ''))
                  + (t.status === 'done' && t.reportPath ? ' · 报告已落盘' : '')
                  + (t.status === 'failed' ? ' · 看 code_review_status' : '')
                  + ' · ' + when;
                return h('div', { key: t.id, className: 'dcr-task ' + taskCls },
                  h('span', { className: 'dcr-task-icon' }, icon),
                  h('span', { className: 'dcr-task-main' },
                    h('span', { className: 'dcr-task-id' }, shortId),
                    h('span', { className: 'dcr-task-repo' }, repoName(t.repoPath))
                  ),
                  h('span', { className: 'dcr-task-meta' }, meta)
                );
              }),
          latestDone
            ? h('p', { className: 'dcr-desc' },
                h('span', { className: 'dcr-em' }, '✅ 最近完成：' + repoName(latestDone.repoPath)),
                ' 报告已留档（' + (latestDone.reportPath || '路径见会话') + '），结果全文用 code_review_status 查。'
              )
            : null
        )
      );
    }

    return {
      /** 需要的宿主客户端服务（只做激活顺序，不 require 任何宿主 UI 包）。 */
      inject: ['slots', 'configForms'],
      /**
       * 界面字段清单（key 序列）——冒烟测试用真源：
       * client-bundle-smoke 断言「client 字段 ≡ 插件 Config 键」双向一致。
       * 宿主只消费 inject/apply，额外的 __fields__ 字段被忽略，无协议影响；
       * 但它让冒烟不用脆弱的源码正则，字段改名的漂移在测试期就暴露。
       * 客户端界面字段由 client.js 导出替代正则抽取。
       */
      __fields__: FIELDS.map((f) => ({ key: f.key })),
      /**
       * 注册设置卡片到「插件」页。
       * @param {object} ctx - 浏览器侧插件上下文。
       */
      apply(ctx) {
        // configForms 取条目表单：宿主未提供该服务 / 条目未注册时 get 可能返回
        // undefined —— 判空后再绑定，宁可渲染降级提示卡也不让卡片渲染抛异常
        // （SettingsCard 内部还有第二道 formUsable 判防线，双保险）。
        // get 本身也包 try/catch——宿主实现异常或
        // 条目未注册走 throw（而非返回 undefined）时，不兜底会让 apply 抛错，
        // 跳过下面两个 slots.register（设置卡/任务卡全灭），比降级渲染更糟。
        let rawForm = null;
        try {
          rawForm = ctx.configForms && typeof ctx.configForms.get === 'function'
            ? ctx.configForms.get(ENTRY_ID)
            : null;
        } catch {
          rawForm = null;
        }
        const form = rawForm && typeof rawForm.getSnapshot === 'function' && typeof rawForm.subscribe === 'function'
          ? rawForm
          : null;
        ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: ENTRY_ID,
          order: 30,
          label: () => '智能代码审查'
        }, (props) => h(SettingsCard, Object.assign({}, props, { form })))), 'dsh-code-review: settings card');
        // 第二层：后台任务卡（页面可见的实时任务面板）。与设置卡同 slot 分开注册，
        // id 不同即互不干扰；路由不可用时卡片内静默降级，不影响设置卡。
        ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: ENTRY_ID + '.tasks',
          order: 31,
          label: () => '代码审查任务'
        }, (props) => h(TasksCard, props))), 'dsh-code-review: tasks card');
      }
    };
  }
});
