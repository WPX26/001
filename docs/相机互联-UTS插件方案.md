# 相机互联·App 壳内 USB：UTS 插件方案（二期，2026-08-16 调研定案）

> 背景：r17 实锤 App 内 web-view 的 Native.js 桥**无法创建 Java byte[]**（probeByteArray=throw），
> USB 读方向（bulkTransfer 预分配 byte[] buffer）架构性无解 → Native.js 路线判死。
> r18 WebUSB 传输层（browser-usb-transport.js）解决**浏览器**场景（电脑 Chrome + Android Chrome）；
> **App 壳内**（产品主路径）走本方案：UTS 原生插件（DCloud 官方主推）。

## 一、为什么 UTS（调研实锤）
- 官方正式表述：「Native.js 功能/性能不及真正原生」，UTS 编译为 Kotlin 是真原生，**官方主推方案**
- UTS 里 `ByteArray` 直接可用：`new ByteArray(size)`（bulkTransfer 读方向正需要）、`byteArrayOf(...)` 字面量
- 社区已有多个 UTS USB Host 插件（串口/扫码枪/热敏打印机）：**estplugin-usbserial（ext.dcloud id=28207，源码随插件，最值得对照）**、usb-serial id=24882、leven-uts-printer id=22445
- 云打包自动把 UTS 编译成 Kotlin 进 APK，**无需 Gradle/Android Studio**（本机工具链缺失无碍，走王总 HBuilderX 云打包）
- 已知坑：UTS 的 `[]`/`Array()` 编译成 **MutableList 不是 ByteArray**（传 byte[] 接口报 Type mismatch），必须显式 ByteArray/byteArrayOf；JS 传 Uint8Array 进 UTS 形参须写 `Uint8Array | null` 并判空（混编模式下 JS 数组可能变 null）

## 二、架构：web-view 页面 ↔ UTS 插件的桥

web-view 页面是纯浏览器 JS，**无法直接 import UTS 插件**（UTS 是 App vue 层模块）→ 必须走官方通信路径：

```
页面(H5, web-view)  ⇄  uni.webview.js postMessage  ⇄  App vue 层（调用 UTS 插件）  ⇄  Android USB
```

- **命令/响应（小数据）**：postMessage 双向请求-响应（页面 transport 封装，bulkOut 命令包、bulkIn 响应头/结果码）
- **大文件（照片 6.1-15MB）**：postMessage 传 base64 太慢（~8-20MB 字符串）→ **App 侧写临时文件 + 页面 plus.io 读回**（web-view 页面有 plus，plus.io 可用）
- 页面侧实现 `bridge-transport.js`（transport 接口 bulkOut/bulkIn/release，内部 postMessage 往返）——**页面代码零改动**（usbCam 模块只认 transport 接口）

## 三、UTS 插件实现要点（对照 browser-usb-transport.js，逻辑同构）

```
uni_modules/uts-usb-camera/
  package.json
  index.uts                 // JS 侧 import 入口（类型声明）
  utssdk/app-android/
    index.uts               // Android 实现（编译为 Kotlin）
    config.json             // minSdkVersion
```

接口（与 browser-usb-transport.js 对齐）：
- `listDevices(): UTSJSONObject[]` — UsbManager.deviceList 枚举（vid/pid/name/serial）
- `requestConnect(deviceId: string): Promise<UTSJSONObject>` — requestPermission（**USB_PERMISSION 非 dangerous 组，须 UsbManager.requestPermission 显式发起 + BroadcastReceiver 收 EXTRA_PERMISSION_GRANTED**，Android 11+ 隐式广播受限需显式注册）→ openDevice → **setConfiguration（Android 不自动激活配置，UsbDeviceConnection.getConfiguration() 返回 int 判断，r13 实锤）** → 找 class=6 PTP 接口的 bulk 端点 → claimInterface(force=true)
- `bulkOut(ep, data: Uint8Array, timeoutMs): number` — `bulkTransfer(ep, byteArray, len, timeout)`，STALL→clear halt 重试一次
- `bulkIn(ep, len, timeoutMs): Uint8Array` — `new ByteArray(len)` 读入 → 转 Uint8Array 回传
- `release()`

传输层模式（参考 remoteyourcam-usb，Apache-2.0）：
- 命令/响应：**同步 bulkTransfer + 200ms 超时 + 3 次重试**（简单可靠）
- 大文件（0x9104 取图）：**16KB × 3 UsbRequest 管道化**（API 28+ 单次可更大；老系统 16KB 上限）
- 保留我们的 clear halt 层（三套开源实现均无，是超越点；5D2 偶发 STALL 恢复靠它）
- 协议栈（camera-ptp.js）不动：0x9128 快门路径、GetEvent 0x9116 轮询、双取图路径全部已验证

## 四、实施步骤与验收

1. HBuilderX 建 UTS 插件（uni_modules/uts-usb-camera）→ 云打包自定义基座 → 真机联调
2. 页面加 `bridge-transport.js` + 环境探测（App 内优先 UTS 桥；无桥回退现有 plus 版）
3. 验收 = 与 WebUSB 同一标准：OPEN_SESSION → 工作台 → 快门（0x9128）→ JPEG 落 pendingPhotos
4. 与 EVF 实时取景二期**合并开发**（EVF 1-2fps 常驻轮询必须原生线程，UTS 天然满足）

## 五、排期（预估）
- UTS 插件传输层 + 桥：约 2-3 天（含云打包迭代，每轮 10-20 分钟）
- EVF 合并：+2-3 天
- 前置：**先完成 r18 WebUSB 真机验证**（电脑 Chrome 当天可验、Android Chrome OTG 随后）——WebUSB 验证过的传输参数（buffer 大小/重试/粘包）直接照抄 UTS，风险前置消解

相关：[[camera-usb-link]] 部署时序纪律（推送后先确认线上再喊测）
