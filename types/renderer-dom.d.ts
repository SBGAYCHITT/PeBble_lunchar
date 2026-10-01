// 渲染层环境声明 —— 只在开发期的 `tsc --checkJs` 生效，不参与打包（不在 build.files 里）。
//
// 为什么需要它：window.api / window.PL / window.Pages 分别由 preload.js 的 contextBridge、
// renderer.js 和 pages.js 在运行时注入，DOM 库自带的类型里没有这些属性。
// 不声明的话，类型检查会被几百条"属性不存在"淹没，真正想抓的逻辑错误反而看不见。
//
// 原则：只放宽"确实由运行时注入"和"DOM 查询返回过窄"这两类，
// 具体业务逻辑（参数类型、返回值形状）仍然严格检查。

interface Window {
  /** preload.js 通过 contextBridge 暴露的主进程 API */
  api: any;
  /** renderer.js 挂上的全局状态（PL = Pebble Lunchar） */
  PL: any;
  /** pages.js 挂上的页面函数集合 */
  Pages: any;
  /** i18n.js 以 UMD 方式挂上的字典模块 */
  I18N: any;
}

interface Document {
  // DOM 库自带重载返回 Element / HTMLElement，而渲染层几乎每处都要直接读写
  // dataset / onclick / value / checked，逐处写断言没有意义，统一放宽。
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): NodeListOf<any>;
}

interface Element {
  // 同上：row.querySelector('[data-act=del]').onclick = ... 这类写法在渲染层到处都是。
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): NodeListOf<any>;
}
