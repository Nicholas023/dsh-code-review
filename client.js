/**
 * client.js —— dsh-code-review 的 Web（浏览器）侧插件形态。
 *
 * ══ 为什么必须有这个文件（2026-10-12 生产实装踩坑）══
 * package.json 声明了 `dsh.client: { platform: 'web' }`，宿主就会按「Web 客户端
 * 插件」协议加载本文件：期望其调用 `window.__ModuleLoader__.load({ id, factory })`
 * 注册自身（id 必须等于包名 dsh-code-review）。
 * ❌ 旧版是 `export default { id }`（占位导出）——宿主加载执行后没有任何
 *    `__ModuleLoader__.load` 调用 → 报
 *    `loaded without registering "dsh-code-review" via __ModuleLoader__.load`，
 *    且整个插件激活失败（服务端 settings 分区也没注册上 → 插件页/设置页都无入口）。
 *
 * ══ 设置通道（2026-10-12 版本升级后定稿）══
 * 本机桌面客户端已是 **0.2.0-rc.2**：客户端设置域服务 = `configForms`
 * （旧 0.1.x 的 `settingsScope.bind` 是 0.1.x 形态，0.2.0 客户端已换 configForms）。
 * 姿势对齐 宿主既有插件范式（生产实证）：
 *   - `ctx.configForms.get('dsh-code-review')` → 该插件条目的配置表单
 *     （form 数据 = 服务端 settings 文档中 ns=<插件 id> 的 section；
 *      服务端由 src/index.js registerSettings → settings.register(SETTINGS_NS, schema) 提供，
 *      SETTINGS_NS 恰等于插件条目 id 'dsh-code-review'，全链闭环）；
 *   - 本文件在「插件」页 slots `plugins.item` 注册一张**设置卡片**：
 *     顶部引导说明 + 四字段真实可写表单（暂存草稿 → 点保存才 set/unset 写入）。
 *
 * ══ 形态约束（照 vision ）══
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
     * 设置字段表（键名与服务端 src/settings-schema.js 的 z.object 完全一致；
     * scripts/client-bundle-smoke.mjs 会做「界面字段 ≡ schema 键」双向一致性断言，
     * 字段数量或键名不一致会被拦下）。
     * group: common=常用（默认可见） / advanced=高级选项。
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
    `;

    /* ─────────────── 表单逻辑（照 宿主范式姿势精简） ─────────────── */

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
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      /** 暂存：{ [key]: 文本值 | boolean }；null 表示无未保存改动。 */
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [savedAt, setSavedAt] = React.useState(null);
      /** 「全部恢复默认」的上膛态（破坏性操作两段式确认）。 */
      const [armed, setArmed] = React.useState(null);

      // 订阅 Host 侧快照（写入被接受后会推来新快照）
      React.useEffect(() => {
        const unsubscribe = form.subscribe(() => setSnapshot(form.getSnapshot()));
        return () => { try { unsubscribe && unsubscribe(); } catch { /* 忽略 */ } };
      }, [form]);

      const value = snapshot.value ?? {};
      /** 可写条件：Host 承载 + 状态 ready（诊断串照 宿主范式定位不可写原因）。 */
      const writable = snapshot.writable && snapshot.mode === 'host' && snapshot.status === 'ready';
      const diag = 'status=' + snapshot.status + ' mode=' + snapshot.mode + ' writable=' + snapshot.writable
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
            } else {
              const parsed = parseText(field, raw);
              ok = parsed === undefined ? await form.unset(field.key) : await form.set(field.key, parsed);
            }
            if (!ok) throw new Error('保存被 Host 拒绝：' + field.key);
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
          for (const field of FIELDS) await form.unset(field.key);
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

      /** 渲染一组字段（字段按 GROUPS 顺序平铺，不做折叠加搜索——四项设置足够少）。 */
      const renderGroup = (group) => {
        const fields = FIELDS.filter((field) => field.group === group.id);
        if (fields.length === 0) return null;
        const groupSet = fields.filter(hasValue).length;
        return h('div', { key: group.id },
          h('div', { className: 'dcr-group-title' }, group.title + (groupSet > 0 ? '（已自定义 ' + groupSet + '）' : '')),
          h('div', { className: 'dcr-form-body' }, ...fields.flatMap(renderField))
        );
      };

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
              busy ? '保存中…' : (dirty ? '保存改动（' + dirtyKeys.length + '）' : '保存')),
            h('button', { className: 'dcr-btn', type: 'button', disabled: !writable || busy || !dirty, onClick: discard }, '放弃改动'),
            h('button', { className: 'dcr-btn danger', type: 'button', disabled: !writable || busy, onClick: resetAll },
              armed === 'resetAll' ? '再点一次确认恢复' : '全部恢复默认'),
            h('span', { className: 'dcr-status' },
              !writable ? '（当前不可写入：' + diag + '）'
                : error ? '保存失败：' + error
                  : savedAt ? '已保存 ' + savedAt.toLocaleTimeString()
                    : dirty ? '有未保存的改动' : ''
            )
          )
        ),
        h('p', { className: 'dcr-note' },
          '引擎 codecheck 未就绪时，会在会话侧给出安装提示；',
          '评审模型选项 = DSH 模型设置里已配置的模型（沿用会话模型为默认）。'
        )
      );
    }

    return {
      /** 需要的宿主客户端服务（只做激活顺序，不 require 任何宿主 UI 包）。 */
      inject: ['slots', 'configForms'],
      /**
       * 注册设置卡片到「插件」页。
       * @param {object} ctx - 浏览器侧插件上下文。
       */
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY_ID);
        ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: ENTRY_ID,
          order: 30,
          label: () => '智能代码审查'
        }, (props) => h(SettingsCard, Object.assign({}, props, { form })))), 'dsh-code-review: settings card');
      }
    };
  }
});
