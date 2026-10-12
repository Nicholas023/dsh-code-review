/**
 * client.js —— dsh-code-review 浏览器（Web 半侧）最小实现。
 *
 * 本插件设置面板全部走宿主 settings 命名空间（设置页原生渲染），因此
 * 半侧暂不需要注入任何自定义 UI 组件；本文件作为 exports["./client"]
 * 的占位存在，保持双形态导出位齐备（与 宿主既有插件范式 的位一致），
 * 后续若需要「评审结果在 Web 侧自带展示」再在此注入。
 *
 * 零敏感：无任何平台内部标识。
 */
export default {
  id: 'dsh-code-review',
};
