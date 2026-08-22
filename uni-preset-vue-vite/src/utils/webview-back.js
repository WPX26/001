/**
 * 物理返回键 → H5「软件返回」桥接（方案 A，王总 2026-08-20 批准）
 *
 * 优先级：
 *   ① window.__memomapBack()（H5 全局钩子，页内面板/弹层返回；返回 true 表示已消费本次返回）
 *   ② web-view 浏览器历史返回（H5 跨页 location.href 跳转）
 *   ③ 放行 uni 默认行为（有上级页则返回上级页，首页则退出 App）
 *
 * 仅 APP-PLUS 生效；Web 端（H5 浏览器）不引入任何额外行为。
 */
export default {
  onBackPress() {
    // #ifdef APP-PLUS
    try {
      const wv = getChildWebview()
      if (!wv) return false
      // ① H5 页内返回钩子（软件返回同一逻辑）
      try {
        const handled = wv.evalJS(
          '(function(){ try { var f = window.__memomapBack; return (typeof f === "function" && f()) ? "1" : "0"; } catch (e) { return "0"; } })()'
        )
        if (String(handled).indexOf('1') >= 0) return true
      } catch (e) {}
      // ② 浏览器历史返回（location.href 跨页）
      try {
        if (wv.canBack && wv.canBack()) {
          wv.back()
          return true
        }
      } catch (e) {}
    } catch (e) {}
    // #endif
    // ③ 放行 uni 默认行为
    return false
  },
}

function getChildWebview() {
  try {
    const pages = getCurrentPages()
    const page = pages && pages[pages.length - 1]
    if (page && page.$getAppWebview) {
      const children = page.$getAppWebview().children()
      if (children && children[0]) return children[0]
    }
  } catch (e) {}
  try {
    const cur = plus.webview.currentWebview()
    const children = cur && cur.children()
    return (children && children[0]) || null
  } catch (e) {
    return null
  }
}
