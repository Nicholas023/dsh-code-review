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
 * ══ 本文件职责（对齐 宿主既有插件范式 的 client.js 姿势，刻意简化）══
 *   - 在「插件」页注册一张设置引导卡片（slots `plugins.item` slot）；
 *   - 设置表单本体不在此处：配置 schema 走服务端 settings 命名空间
 *     （src/index.js → registerSettings → settings.register(SETTINGS_NS, schema)），
 *     由 DSH 宿主「设置」页原生渲染「智能代码审查」分区（评审模型下拉等）。
 *     卡片只做说明 + 指路，避免再造一套 configForms 读写通道。
 *
 * ══ 形态约束（照 vision ）══
 *   - 手写 JS + React.createElement（不走构建），React 由浏览器模块表 require('react') 提供；
 *   - 不 require 任何宿主 UI 包（官方劝阻第三方插件依赖 @deepseek-ai/dsh-client-ui-*）。
 *
 * 零敏感：无任何平台内部标识。
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

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
    `;

    /**
     * 设置引导卡片（挂进「插件」页）。
     * 写法约束同 vision：普通函数直出元素、只用 useState/useEffect 类基础 hooks；
     * 本卡片是静态文案，无状态。
     */
    function GuideCard(props) {
      // 插件页折叠态只给一句摘要。
      if (props.view === 'summary') return '智能代码审查：评审模型与报告目录等设置请看 DSH 设置页 →「智能代码审查」分区。';
      return h('div', { className: 'dcr-card' },
        h('style', null, STYLE),
        h('p', { className: 'dcr-desc' },
          '对代码仓库执行「安全脱敏 / 找 bug / 冗余与任务无关代码」三视角评审：会话内返回问题清单，并落一份报告文件留档。'
        ),
        h('div', { className: 'dcr-row' },
          h('span', { className: 'dcr-k' }, '使用方式'),
          h('span', null, '会话里说「审一下 X」，或输入斜杠命令 ', h('code', { className: 'dcr-code' }, '/review'))
        ),
        h('div', { className: 'dcr-row' },
          h('span', { className: 'dcr-k' }, '评审模型'),
          h('span', null, '默认沿用会话模型；另选请到 DSH 设置 →「智能代码审查」分区')
        ),
        h('div', { className: 'dcr-row' },
          h('span', { className: 'dcr-k' }, '报告位置'),
          h('span', null, '每次评审按 日期/仓库 落盘，目录见设置项「报告目录」')
        ),
        h('p', { className: 'dcr-note' },
          '设置面板入口：DSH「设置」页 → 左侧「智能代码审查」分区（评审模型、报告目录、引擎路径、敏感点名开关等）。',
          '引擎 codecheck 未就绪时，会在会话侧给出安装提示。'
        )
      );
    }

    return {
      /** 需要的宿主客户端服务（只激活顺序用，不 require 任何宿主 UI 包）。 */
      inject: ['slots'],
      /**
       * 注册插件页卡片。
       * @param {object} ctx - 浏览器侧插件上下文（slots 注入后可用）。
       */
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'dsh-code-review',
          order: 30,
          label: () => '智能代码审查'
        }, (props) => h(GuideCard, props))), 'dsh-code-review: guide card');
      }
    };
  }
});
