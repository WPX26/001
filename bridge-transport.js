/* ============================================================
 * bridge-transport.js — r72 起为空操作（不再覆盖全局 UsbTether）
 *
 * 历史：r69-r71 尝试用 uni.postMessage / plus.android.importClass
 * 把 USB 转发给 App 原生层。真机五连实锤（2026-08-16）：web-view 桥
 * 对 importClass / 字符串类名 invoke / Class 对象静态 invoke 全部
 * SyntaxError；window.uni 在目标设备上根本不存在。两条路都是死路。
 *
 * r72 正解：usb-transport.js（Native.js plus 版）直接用桥安全原语
 * （newObject + 实例 invoke）完成全部 USB 操作，byte[] 双向桥改走
 * String(ISO-8859-1)+getBytes 路径。本文件保留仅为兼容页面 script
 * 引用与 Dockerfile COPY，内容为空操作。
 * ============================================================ */
(function () {
  'use strict';
  // 空操作：不注册、不覆盖、不轮询。UsbTether 由 usb-transport.js 提供。
  if (typeof console !== 'undefined') {
    try { console.log('[usb-bridge] r72：桥已停用，USB 走 usb-transport.js Native.js 直连'); } catch (e) {}
  }
})();
