# 阶段②a UTS 插件设计文档 — 相机 FTP 直传手机热点

> 本文档为"阶段②：相机 FTP 直传手机热点"第一阶段的 UTS 插件设计稿。
> 依据《阶段②规划 v1.0》已定事实细化，供王总确认后进入编码（D1 决策：先出设计文档，确认后再写代码）。

---

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 文档名称 | 阶段②_UTS插件设计文档.md |
| 版本 | v1.0（王总确认冻结；含架构评审修订 H1–H3 / M1–M10 / L1–L7，见 1.3） |
| 日期 | 2026-08-09（v0.9 初稿）→ 2026-08-09（v1.0 修订） |
| 状态 | **已冻结**（API 签名与 v0.9 完全一致，仅实现细节修订） |
| 适用范围 | Android（iOS 接口占位，见第 9 章） |
| 关联实现 | `uni_modules/ftp-receiver/`（UTS 插件）+ `src/composables/useFtpServer.uts`（JS 封装，后续阶段） |

### 1.1 关联决策状态（D1–D8）

| 决策 | 内容 | 状态 |
|---|---|---|
| D1 | 打包路径：UTS 插件为主路径，离线打包为兜底 | ✅ 已确认 |
| D2 | 阶段②规划 v1.0 中的既有决策（与本插件无直接关联） | 沿用规划 v1.0，不重复 |
| D3 | iOS 延期：Android 先实现，iOS 接口占位 | ✅ 已确认（本文档只细化 Android 侧） |
| D4 | 阶段②规划 v1.0 中的既有决策（与本插件无直接关联） | 沿用规划 v1.0，不重复 |
| D5 | 存储策略：原图（含 CR3）落应用私有目录，**不做 DCIM 镜像** | ✅ 已确认（阶段②a 按"只落私有目录"实施，镜像能力后续评估） |
| D6 | FTP 账号策略：每次启动随机生成，引导页展示 | ✅ 已确认（随机账号，插件 API 不变） |
| D7 | 阶段②规划 v1.0 中的既有决策（与本插件无直接关联） | 沿用规划 v1.0，不重复 |
| D8 | FGS 常驻通知文案 | ✅ 已确认：「📷 相机连接中 · 照片实时接收中」 |

> 注：D2/D4/D7 的具体内容如需核对，见《阶段②规划 v1.0》原文，本设计不涉及。

### 1.2 修订记录（v0.9 → v1.0）

| 编号 | 严重度 | 修订内容 | 涉及章节 |
|---|---|---|---|
| H1 | 高 | **PORT 模式拓扑修正**：相机 PORT 命令携带的是手机自身 AP 地址（192.168.43.1），手机连自己必然失败。改为 `connectData` 的 host 一律取**控制连接对端 IP**（相机实际 LAN 地址），仅采用 PORT 参数中的端口；原生层记录相机真实 PORT 原始报文供验证；`connectData` 执行器加有界重试（相机可能延迟绑定数据端口） | §4.5、§5.x |
| H2 | 高 | **状态机改两阶段协议**：命令步只产 effect（不产最终响应）→ 执行器执行后以内部事件回注（PASV：`dataListening(port)` → 227；PORT：`dataConnected` → 200 / `dataConnectFailed` → 425+LOGGED_IN）。补齐 `FtpInternalEvent` 的 `dataListening`/`dataConnectFailed`/`dataTimeout` 成员；§4.1 写明执行器协议 | §4.1、§4.2、§4.4、§4.5 |
| H3 | 高 | **端口范围改 1–65535**（默认 21）；删除"1024 以下必失败"断言，改为"个别 ROM 可能 EACCES → 走 1000 错误码" | §3.1 |
| M1 | 中 | 补「状态 × 定时器」矩阵：控制空闲 60s 在 TRANSFER 期间挂起；PASV 数据连接建立后 30s 无 STOR 的超时定义 | §4.7 |
| M2 | 中 | 主动 `stopServer()` 必须清除持久化配置（防 START_STICKY 停了又起） | §5.2 |
| M3 | 中 | wakelock 改为**传输级持有**（传输开始获取 / 结束释放，上限 10 分钟兜底），替代 30s 自动释放 | §5.2 |
| M4 | 中 | 运行期存储故障错误码通道统一：不走 startServer reject，用 error 事件（1005）异步上报 | §3.3、§5.3 |
| M5 | 中 | 命令表补佳能目录类命令兼容：CWD→250、MKD→257、PWD→257、NOOP→200（真机记录真实报文后按需调整） | §4.6 |
| M6 | 中 | 验收手段修正：Android 无"缩短 timeout"开发者选项；`onTimeout(startId, fgsType)`（API 35 双参签名）；dataSync 6h 按 **24h 累计**、targetSdk 35；加 debug-only 测试钩子提前触发 onTimeout | §5.2、§8 |
| M7 | 中 | 就绪信号改用 UTS 常规回调模式（FtpEvents 桥 + Promise），不使用 UTSPlugin.onAppForeground | §5.5 |
| M8 | 中 | 包名连字符归一：`ftp-receiver` → `ftp_receiver`（DCloud 规则：插件 id 与目录连字符统一转下划线）；manifest service android:name 同步使用归一后包名 | §2.1、§5.1 |
| M9 | 中 | 错误事件统一由状态机 effect 产出：`FtpEffect` 增加 `emitError { code, message }`；原生层不再自行发 error | §3.3、§4.2 |
| M10 | 中 | stopServer / QUIT / peerClosed 传输中 `.part` 清理与 error(1008) 口径统一（补测试用例） | §4.6、§7 |
| L1 | 低 | transferring.size 恒 0 时 dataComplete 的 size 校验跳过（expected=0 视为未知，不判错） | §4.4 |
| L2 | 低 | POST_NOTIFICATIONS 需运行时申请（Android 13+），manifest 声明 + 业务层/示例页首次启动申请 | §5.1 |
| L3 | 低 | PORT/PASV 覆盖旧数据通道前先 closeData | §4.6 |
| L4 | 低 | `connected`/`disconnected` 的 client 格式建议 `ip:port`；iOS 占位错误码 9001（原文已有） | §3.1、§9 |
| L5 | 低 | LIST 一律返回 502（最小命令集，防范围蔓延；佳能目录兼容已由 CWD/MKD/PWD/NOOP 覆盖） | §4.6、§7 |
| L6 | 低 | 无热点 IP 时启动仍成功，但发 error(1006) 警告事件（不误导用户） | §5.4 |
| L7 | 低 | CR3 为佳能 RAW 格式，需独立解析器（H5 原型 JPEG 解析不适用），阶段②b/③ 处理 | §5.3、readme |

### 1.2 设计约束（本阶段硬性事实）

- 插件名 `uni_modules/ftp-receiver/`，结构 `utssdk/interface`（API 契约，纯 TS）+ `utssdk/app-android`（Kotlin 实现）。
- JS 层统一 API：`startServer({port, dir, user, pass})` / `stopServer()` / `onEvent(...)`。
- 事件：`connected / transferring / fileReceived(meta) / disconnected / error`。
- FTP 最小命令集：USER/PASS、PASV、PORT、STOR、TYPE I、QUIT，可选 SYST/LIST。
- **PASV 与 PORT 双模式必须实现**（佳能多数教程要求关闭被动模式 → 即使用 PORT 主动模式）。
- Android 侧：`FtpForegroundService`（dataSync 类型 FGS + 常驻通知 + START_STICKY + `onTimeout` 处理 Android 15 的 6h 上限）、`ServerSocket` 监听端口 21、流式 STOR 写盘、应用私有目录（filesDir，**无需存储权限**）、`NetworkInterface` 枚举热点 IP。
- 文件命名冲突处理；`fileReceived` 事件携带 `{path, size, name}`。
- 协议状态机写成平台无关纯函数（②b iOS 低成本移植的前提，虽延期但设计保留）。
- JS 层封装 `useFtpServer()` 与 H5 原型事件结构对齐（照片到达 → 读 GPS → 500m 归类 → 本地库）。

---

## 2. 插件目录结构

```
uni_modules/ftp-receiver/
├── package.json                      # 插件清单（uni_modules 规范：id/name/version）
├── manifest.json                     # 插件声明（Android 权限、前台服务注入，见 2.1）
├── readme.md                         # 插件使用说明（API 速查 + 示例接入）
│
├── utssdk/
│   ├── interface/                    # ★ 平台无关层（纯 TS，无任何 IO）
│   │   ├── index.uts                 #   API 契约：类型 + startServer/stopServer/onEvent 声明
│   │   └── ftp-protocol.uts          #   FTP 协议状态机纯函数（step/notify + 副作用列表）
│   │
│   ├── app-android/                  # ★ Android 实现（Kotlin，编译目标包名
│   │   │                             #   uni_modules.ftp-receiver.utssdk.app-android）
│   │   ├── index.uts                 #   UTS 出口：startServer/stopServer/onEvent 实现
│   │   ├── FtpForegroundService.kt   #   前台服务：dataSync FGS + 常驻通知 + START_STICKY
│   │   │                             #   + onTimeout(Android 15, 6h 上限)
│   │   ├── FtpServer.kt              #   控制连接 ServerSocket 监听 + 单会话管理
│   │   ├── FtpDataChannel.kt         #   PASV/PORT 数据连接 + STOR 流式写盘（64KB 缓冲）
│   │   ├── FtpStore.kt               #   文件命名规约（冲突改名）、临时文件与原子 rename
│   │   ├── HotspotIp.kt              #   NetworkInterface 热点 IP 枚举
│   │   └── FtpEvents.kt              #   原生事件 → UTS 回调桥接（connected/error 等）
│   │
│   └── app-ios/
│       └── index.uts                 # ★ iOS 占位（D3 延期）：保留相同签名，
│                                     #   实现体抛 notImplemented（见第 9 章）
│
└── example/
    ├── pages/ftp-server-demo.vue     # 示例页：启动/停止/事件日志/连接信息展示
    └── README.md                     # 示例页接入说明（复制到 pages.json 后运行）

# —— 业务工程侧（JS 层封装，不属于插件）——
src/composables/useFtpServer.uts      # 组合式封装：idle/starting/running/stopping/error
```

### 2.1 manifest.json（插件声明，示例）

```json
{
  "id": "ftp-receiver",
  "name": "FTP接收插件",
  "version": { "name": "1.0.0", "code": "100" },
  "description": "相机FTP直传手机热点接收服务（Android，dataSync前台服务）",
  "uni_modules": {
    "dcloudAppType": ["app"],
    "app": {
      "android": {
        "permissions": [
          "INTERNET",
          "ACCESS_NETWORK_STATE",
          "ACCESS_WIFI_STATE",
          "FOREGROUND_SERVICE",
          "FOREGROUND_SERVICE_DATA_SYNC",
          "WAKE_LOCK",
          "POST_NOTIFICATIONS"
        ],
        "services": [
          {
            "name": "uni_modules.ftp_receiver.utssdk.app_android.FtpForegroundService",
            "exported": false,
            "foregroundServiceType": "dataSync"
          }
        ]
      }
    }
  }
}
```

- **包名归一（M8）**：`services[].name` 与 `.kt` 文件 package 声明、`index.uts` import 三统一，统一为连字符转下划线后的 `uni_modules.ftp_receiver.utssdk.app_android`（含目录名 `app-android` → `app_android`）。
- **在线打包（主路径）**：权限与 Service 声明随插件合并进 App 工程。
- **离线打包（D1 兜底）**：在离线打包工程的 `AndroidManifest.xml` 中手动补同样的 permissions 与 service 节点（`android:foregroundServiceType="dataSync"` 必须显式声明，否则 Android 14+ 启动前台服务报 `ForegroundServiceStartNotAllowedException` 类错误）。
- 编码前按 DCloud 最新 UTS 插件文档核对一次 manifest 字段名（以官方 schema 为准）。

### 2.2 使用方式（JS 层引入）

```ts
import { startServer, stopServer, onEvent } from '@/uni_modules/ftp-receiver/utssdk/interface/index.uts'
```

平台实现（`app-android/index.uts`）由 UTS 编译器按运行平台自动匹配，业务代码不感知。

---

## 3. API 契约（核心）

### 3.1 类型定义（utssdk/interface/index.uts）

```typescript
/**
 * 启动参数
 */
export type FtpServerOptions = {
  /** 监听端口。默认 21（相机 FTP 默认端口）。范围 1–65535（H3 修订）；
   *  个别 ROM 对 <1024 端口可能返回 EACCES，走错误码 1000（端口占用/绑定失败），换端口重试 */
  port: number
  /** 存储目录：
   *  - 相对路径：基于应用私有目录 filesDir（如 "ftp/photos" → filesDir/ftp/photos）
   *  - 绝对路径：必须落在应用私有目录内，否则校验失败（错误码 1003）
   *  目录不存在会自动创建；本方案全程使用应用私有目录，无需存储权限 */
  dir: string
  /** FTP 用户名。非空，长度 ≤ 32 */
  user: string
  /** FTP 密码。非空，长度 ≤ 32 */
  pass: string
}

/**
 * 文件接收完成元数据（fileReceived 事件携带）
 */
export type FtpFileMeta = {
  /** 文件绝对路径（filesDir 下的实际落盘位置） */
  path: string
  /** 最终文件名（含扩展名；若发生命名冲突，为冲突处理后的实际文件名） */
  name: string
  /** 文件字节数（与相机原文件一致） */
  size: number
}

/**
 * 事件联合类型（与 H5 原型事件结构对齐）
 */
export type FtpServerEvent =
  | { type: 'connected';      client: string }             // 客户端已建立控制连接
  | { type: 'transferring';   name: string; size: number } // STOR 开始接收（size 为相机声明的预期大小，0 表示未知）
  | { type: 'fileReceived';   meta: FtpFileMeta }          // 文件完整接收并落盘（此时才可安全读取）
  | { type: 'disconnected';   client: string }             // 客户端断开（含超时/异常断开）
  | { type: 'error';          code: number; message: string } // 服务级错误（错误码表见 3.3）

/** 事件回调签名 */
export type FtpEventCallback = (event: FtpServerEvent) => void

/** startServer 成功结果 */
export type FtpStartResult = {
  /** 本机 IP（热点 AP 网卡枚举结果，供界面展示连接信息） */
  ip: string
  /** 实际监听端口 */
  port: number
}
```

### 3.2 函数签名与语义

```typescript
/**
 * 启动 FTP 接收服务（前台服务）。
 *
 * 语义：
 * - 同步检查参数合法性（非法立即 reject，错误码 1003）；异步执行启动。
 * - resolve 时保证：端口已绑定、监听已开始、前台服务通知已挂起 —— 之后即可接收连接。
 * - 重复调用返回 reject（错误码 1004），需先 stopServer()。
 *
 * 失败错误码：1000（端口占用）/ 1001（前台服务权限缺失或被系统拒绝）/
 *             1003（参数非法）/ 1005（目录不可写）/ 1006（其他启动失败）
 *
 * @param options 启动参数（见 FtpServerOptions）
 * @returns Promise<FtpStartResult> 成功返回本机 IP 与端口
 */
export function startServer(options: FtpServerOptions): Promise<FtpStartResult>

/**
 * 停止 FTP 接收服务。
 *
 * 语义：
 * - 关闭监听与所有活跃连接、移除前台服务通知、释放 WAKE_LOCK。
 * - resolve 时保证服务已完全停止。
 * - 服务未运行时调用返回 reject（错误码 1002）。
 */
export function stopServer(): Promise<void>

/**
 * 订阅服务事件。可多次调用，多个回调并存。
 * @param handler 事件回调（见 FtpServerEvent）
 * @returns 退订函数；调用后不再收到事件。页面 onUnmounted 时必须退订。
 */
export function onEvent(handler: FtpEventCallback): () => void
```

### 3.3 错误码表

| 错误码 | 常量名 | 触发场景 | 可恢复性 |
|---|---|---|---|
| 1000 | `ERR_PORT_IN_USE` | 端口被占用（`ServerSocket` 绑定失败，含 <1024 个别 ROM 的 EACCES） | 换端口重试 |
| 1001 | `ERR_PERMISSION_DENIED` | 前台服务权限缺失（未声明 FGS / DATA_SYNC 类型）或系统拒绝 | 修复清单后重启 |
| 1002 | `ERR_NOT_RUNNING` | `stopServer()` 时服务未运行 | — |
| 1003 | `ERR_INVALID_OPTIONS` | 参数非法：端口越界（非 1–65535 整数）/ 账号密码为空或超长 / dir 越界（含 `../` 穿越） | 修正参数重试 |
| 1004 | `ERR_ALREADY_RUNNING` | 服务运行中重复 `startServer()` | 先 stop 再 start |
| 1005 | `ERR_DIR_UNAVAILABLE` | 存储目录创建失败（启动期，reject）/ 运行期写盘失败（磁盘满、只读等，**error 事件**异步上报，不终止服务，M4） | 清空间后重试 |
| 1006 | `ERR_START_FAILED` | 其他启动失败（如平台不支持 dataSync FGS）；**无热点 IP 时的警告事件**（L6，服务继续运行） | 视机型 |
| 1007 | `ERR_FGS_TIMEOUT` | Android 15 dataSync 前台服务超时上限触发（`onTimeout`，24h 累计，M6） | 用户重新开启 |
| 1008 | `ERR_DATA_CHANNEL` | 数据连接建立 / 传输失败（**不终止服务**，仅发 error 事件） | 相机重试 |

> 1000–1006 通过 `startServer()` 的 reject 抛出（附带 `{code, message}`）；1007/1008 及运行期 1005/1006 通过 `error` 事件异步上报。
> **M9 修订**：运行期的 1005/1006(警告)/1008 错误事件统一由**状态机 effect（`emitError`）产出**，原生层只执行 effect、不再自行发 error（1007 由 FGS `onTimeout` 流程直接产出，不经状态机）。

---

## 4. FTP 协议状态机设计（平台无关纯函数）

### 4.1 设计原则

> **状态机不接触任何网络 IO。** 全部逻辑位于 `utssdk/interface/ftp-protocol.uts`，输入为「当前状态 + 指令/内部事件」，输出为「新状态 + 响应列表 + IO 副作用列表」。IO 副作用由 Android 层执行，执行结果以内部事件形式回注状态机。
>
> 收益：① 单测零依赖、零网络即可覆盖全部分支；② ②b 阶段 iOS 移植时协议层原样复用，仅重写副作用执行器；③ 状态与行为可序列化，便于排障日志。

**执行器协议（H2 修订，两阶段）**：命令步与最终响应解耦，全部经"内部事件回注"闭环——

```
控制行 ─► step ──► { effects, ...（无最终响应或占位响应）}
              │ 执行器（Android 层）执行 effect
              ▼
        dataListening(port)/dataConnected/dataConnectFailed/dataTimeout/...
              │ 回注 notify
              ▼
        ──► { responses（最终响应，如 227/200/425）, effects, fatal }
```

- PASV：命令步只产 `openDataListen` effect、**无响应**；执行器绑定随机端口成功后回注 `dataListening(port)`，状态机此刻才生成 227。
- PORT：命令步只产 `connectData` effect、**无响应**；执行器连接成功回注 `dataConnected` → 状态机生成 200；失败回注 `dataConnectFailed` → 425 + LOGGED_IN。
- 其余命令（USER/PASS/TYPE/STOR/QUIT 等）响应仍由命令步直接生成（无 IO 依赖）。
- 执行器协议约定：**每个 effect 都对应一个确定的回注事件**；执行器必须保证回注且只回注一次（重复回注被状态机忽略，见 4.7 幂等说明）。

### 4.2 类型定义

```typescript
// —— 会话状态 ——
export type FtpState =
  | { kind: 'WAIT_USER' }                                        // 等待 USER（连接建立后初始态）
  | { kind: 'WAIT_PASS' }                                        // 等待 PASS（记录 user）
  | { kind: 'LOGGED_IN'; user: string }                          // 已登录，空闲
  | { kind: 'TRANSFER';  user: string
      dataChannel: 'LISTENING' | 'CONNECTING' | 'CONNECTED'      // PASV 监听中 / PORT 连接中 / 已就绪
      target?: { host: string; port: number }                    // PORT 目标（相机地址）
      file?: { raw: string; resolved: string; size: number } }   // STOR 进行中的文件
  | { kind: 'CLOSED'; reason?: string }                          // 终态（QUIT/异常），会话即销毁

// —— 输入 ——
export type FtpCommand = { verb: string; args: string }          // 控制连接收到的指令（已按 RFC 959 解析）

// 内部事件（由 Android 层执行副作用后回注；H2/M1 修订补齐成员）
export type FtpInternalEvent =
  | { kind: 'dataListening'; port: number }     // PASV：openDataListen 执行成功，实际随机端口（生成 227 用）
  | { kind: 'dataAccepted' }                    // PASV：数据连接已建立
  | { kind: 'dataConnected' }                   // PORT：主动连接成功（生成 200）
  | { kind: 'dataConnectFailed' }               // PORT：主动连接失败（→ 425 + LOGGED_IN，M9 产出 emitError(1008)）
  | { kind: 'dataTimeout' }                     // PASV 监听 30s 超时 / 数据连接就绪后 30s 无 STOR（M1）
  | { kind: 'dataComplete'; size: number }      // 数据接收完成，实际字节数
  | { kind: 'transferStalled' }                 // 传输无进展 60s
  | { kind: 'transferFailed' }                  // 写盘失败（IOException，磁盘满等）
  | { kind: 'ctrlIdleTimeout' }                 // 控制连接空闲超时（TRANSFER 期间挂起，M1）
  | { kind: 'peerClosed' }                      // 对端关闭控制连接

// —— 输出 ——
export type FtpEffect =                                    // IO 副作用（Android 层逐条执行）
  | { kind: 'openDataListen' }                             // PASV：监听随机端口，回注 dataListening(port)/dataAccepted/dataTimeout
  | { kind: 'connectData'; host: string; port: number }    // PORT：主动连相机（host=控制连接对端 IP，H1），回注 dataConnected/dataConnectFailed；执行器有界重试
  | { kind: 'receiveFile'; temp: string; target: string; expected: number }  // STOR：流式写盘，完成后回注 dataComplete/transferFailed
  | { kind: 'discardTemp'; temp: string }                  // 失败时删除半成品 .part
  | { kind: 'closeData' }                                  // 关闭数据连接
  | { kind: 'closeControl' }                               // 关闭控制连接（QUIT/超时/失败）
  | { kind: 'emitFileReceived'; meta: FtpFileMeta }        // 触发业务事件（改名后的真实文件信息）
  | { kind: 'emitTransferring'; name: string; size: number } // 触发业务事件
  | { kind: 'emitError'; code: number; message: string }   // 触发 error 事件（M9：1005/1006警告/1008 统一由状态机产出）

export type FtpStepResult = {
  state: FtpState
  responses: string[]      // 需写给客户端的响应行（如 "331 ..."）
  effects: FtpEffect[]     // 待执行副作用（有序）
  fatal: boolean           // true → 会话终结（Android 层随后 closeControl 并清理）
}

// —— 两个纯函数入口 ——
export function step(state: FtpState, cmd: FtpCommand): FtpStepResult     // 客户端指令
export function notify(state: FtpState, ev: FtpInternalEvent): FtpStepResult // 内部事件
```

### 4.3 状态流转图

```
(连接建立, 发送 220)
      │
      ▼
  WAIT_USER ──USER(记录)──► WAIT_PASS ──PASS(校验通过)──► LOGGED_IN
      ▲                          │ 校验失败×3 → 421+CLOSED      │
      └────────── 断开/超时 ◄─────┘                             │
                                             ┌──────────────────┤
                                             ▼                  ▼
                                     ┌──── PASV ────► TRANSFER(dataChannel=LISTENING) ◄── dataListening(port)（产 227）
                                     │                            │ dataAccepted              │
                                     │                            ▼                           │
                                     │                   TRANSFER(CONNECTED)                 │
                                     │                 30s 无 STOR → dataTimeout（425）      │
                                     │                            │ STOR                     │
                                     │                            ▼                          │
                                     │             TRANSFER(file=...) ── dataComplete ──► LOGGED_IN
                                     │                                                            │
                                     └──── PORT ────► TRANSFER(dataChannel=CONNECTING) ──┐        │
                                                                        dataConnected  │        │
                                                                       （产 200）       ▼        │
                                                             TRANSFER(CONNECTED) ◄─────┘        │
                                                             dataConnectFailed ──► 425 ──► LOGGED_IN
                                                                      STOR                     │
                                                                      ▼                        │
                                                             TRANSFER(file=...) ── dataComplete
                                                                                            │
  LOGGED_IN ──QUIT──► CLOSED  ◄── 超时/异常/失败×N（421）◄──────────────────────────────────┘
```

> H2 修订：PASV/PORT 的命令步不再直接产响应，最终响应（227/200/425）由内部事件回注后生成（见 4.1 执行器协议）。

### 4.4 PASV 模式完整流程（伪代码，含内部事件回注）

```
[连接建立]  → 状态 WAIT_USER → 响应: "220 FTP receiver ready"   （effects: 无）

[客户端] USER ftpuser
  → 记录 user，状态 WAIT_PASS → 响应: "331 User name okay, need password"

[客户端] PASS ****
  → 校验 user+pass（错误 → "530 Not logged in"，保持 WAIT_PASS；连续 3 次失败 → "421 Too many attempts" + fatal）
  → 通过 → 状态 LOGGED_IN → 响应: "230 User logged in, proceed"

[客户端] PASV
  → effects: [closeData(幂等), openDataListen]        // Android: 绑定热点 IP:0（系统分配随机端口 p）
  → 状态 TRANSFER(LISTENING) → 响应: 无（H2：命令步不产最终响应）

[内部事件 dataListening(p)]   // 执行器绑定成功，回注实际端口
  → 状态 TRANSFER(LISTENING) → 响应: "227 Entering Passive Mode (192,168,43,1,{p>>8},{p&255})"
  → 注：227 中的 IP 为热点枚举 IP（第 5.4 节），端口为执行器回注的随机端口

[内部事件 dataAccepted]
  → 状态 TRANSFER(CONNECTED) → 响应: 无

[内部事件 dataTimeout]（PASV 监听 30s 无连接 / 连接建立后 30s 无 STOR，M1）
  → 状态 LOGGED_IN → 响应: "425 Can't open data connection"（监听超时无响应，见 4.7 矩阵）→ effects: [closeData]

[客户端] STOR IMG_0001.CR3
  → 数据通道非 CONNECTED → "425 Can't open data connection"（不会发生：Canon 流程在 227 后即连接数据端口）
  → 数据通道已就绪 → 文件名合法 → 冲突规约（第 5.3 节）→ effects: [emitTransferring, receiveFile(临时名→目标名)]
  → 响应: "150 File status okay; about to open data connection"
  → 状态 TRANSFER(file=IMG_0001.CR3)

[客户端] 开始向数据连接写文件（收到 150 后）→ 相机推送数据，Android 流式写盘

[内部事件 dataComplete(size)]
  → expected 为 0（相机未声明大小，L1）或 size 与声明一致 → effects: [emitFileReceived({path,name,size}), closeData]
  → 响应: "226 Closing data connection" → 状态 LOGGED_IN
  → size 与声明不符（expected>0）→ effects: [discardTemp, closeData, emitError(1008)]（M9）
  → 响应: "426 Connection closed; transfer aborted" → 状态 LOGGED_IN

[客户端] QUIT → 响应: "221 Service closing control connection" → 状态 CLOSED（fatal，Android 关闭控制连接）
```

### 4.5 PORT 模式完整流程（佳能"关闭被动模式"场景）

> 背景：佳能官方教程多数要求**关闭被动模式**（相机设置 → FTP → 被动模式 = 关）。此时相机不主动连接手机的数据端口，而是发 `PORT` 命令，由**手机主动连接相机**的数据端口 —— 即 FTP 主动模式（PORT 模式）。
> 手机热点拓扑：手机热点 AP 网关地址（典型 192.168.43.1）监听控制端口 21；相机连上热点后取得局域网地址（典型 192.168.43.2）。
>
> **H1 拓扑修正（重要）**：相机 `PORT` 命令中携带的是**手机自身 AP 地址**（它把手机当作服务器地址填写，典型 192.168.43.1），手机若按该地址主动连接**会连到自己而必然失败**。正确做法：`connectData` 的 **host 一律取控制连接的对端 IP**（即相机实际 LAN 地址，服务端 socket 对端可精确获得），**仅采用 PORT 参数中的端口**。原生层同时把相机 PORT 原始报文完整记入日志（tag `FtpServer`，供真机验证相机行为）。

```
[客户端] PORT 192,168,43,1,200,1
  → 解析：port=200*256+1=51201（IP 段仅作日志记录，不用于连接）
  → 语法错误（段数/数值非法）→ "501 Syntax error in parameters"
  → 合法 → effects: [closeData(幂等), connectData(<控制连接对端IP>, 51201)]   // 立即发起
  → 状态 TRANSFER(CONNECTING, target={peerIp, 51201}) → 响应: 无（H2：等执行器回注）

[内部事件 dataConnected]
  → 响应: "200 Command okay" → 状态 TRANSFER(CONNECTED)

[内部事件 dataConnectFailed]   // 执行器有界重试后仍失败
  → 状态 LOGGED_IN → 响应: "425 Can't open data connection" + effects: [closeData, emitError(1008)]
  → 提示检查相机 FTP 地址设置

[客户端] STOR IMG_0001.CR3
  → 数据通道已就绪 → 同 PASV 流程（150 → 相机推送 → dataComplete → 226 → LOGGED_IN）
  → 数据通道未就绪 → "425 Can't open data connection"

[客户端] QUIT → "221" → CLOSED（传输中 QUIT 额外清理 .part，M10）
```

- **connectData 执行器有界重试（H1）**：相机可能在发送 PORT 后延迟几十毫秒才绑定数据端口，执行器按 3 次 × 间隔 500ms 重试（单次连接超时 5s），重试间不打断状态机（每次失败不立即回注，最终结果一次性回注 `dataConnected` 或 `dataConnectFailed`）。
- **双模式要点**：状态机对两种模式完全对称 —— 差异仅在 `dataChannel` 的就绪路径（`LISTENING→dataAccepted` vs `CONNECTING→dataConnected`），`STOR` 之后的文件接收、事件、清理逻辑完全共用。

### 4.6 命令处理表

| 命令 | 参数 | 状态前置 | 成功响应 | 失败响应 | 说明 |
|---|---|---|---|---|---|
| USER | 用户名 | 任意 | 331 User name okay, need password | — | 仅记录用户名，不校验（防账号枚举） |
| PASS | 密码 | WAIT_PASS | 230 User logged in, proceed | 530 Not logged in；连续 3 次错 → 421 | 此处才统一校验 user+pass |
| PASV | 无 | LOGGED_IN | 227（H2：由 `dataListening(port)` 回注后生成，命令步无响应） | — | 副作用 `[closeData(幂等), openDataListen]`（L3）；随机端口 |
| PORT | h1,h2,h3,h4,p1,p2 | LOGGED_IN | 200（H2：由 `dataConnected` 回注后生成，命令步无响应） | 501 Syntax error in parameters / 425（`dataConnectFailed` 回注） | 副作用 `[closeData(幂等), connectData]`（L3）；host 取控制连接对端 IP（H1），与 PASV 互斥（新的 PORT/PASV 覆盖旧的） |
| TYPE | I / A | LOGGED_IN | 200 Command okay | 504 Command not implemented for that parameter | 仅接受 `TYPE I`（二进制，佳能传图必需）；A 返回 504 |
| STOR | 文件名 | TRANSFER(CONNECTED) | 150 → … → 226 | 425（数据通道未就绪）/ 450（写入失败）/ 553（文件名非法，含 `../` 穿越与空名） | 副作用 `receiveFile`；完成后 226 |
| SYST | 无 | LOGGED_IN | 215 UNIX Type: L8 | — | 可选实现（部分相机握手会询问） |
| CWD | 路径 | LOGGED_IN | 250 Directory changed | — | M5：佳能目录类命令兼容（不实际切换，仅应答） |
| PWD | 无 | LOGGED_IN | 257 "/" is current directory | — | M5 |
| MKD | 目录名 | LOGGED_IN | 257 Directory created | — | M5 |
| NOOP | 无 | LOGGED_IN | 200 Command okay | — | M5 |
| LIST | 可选路径 | LOGGED_IN | — | 502 Command not implemented | L5：一律 502（最小命令集，不做浏览；真机记录相机真实报文后按需调整） |
| QUIT | 无 | 任意 | 221 Service closing control connection | — | 会话终结；**传输中（TRANSFER/file）QUIT 额外 `discardTemp` 清理 .part（M10）** |
| 其他 | — | — | — | 500 Syntax error, command unrecognized / 530 Not logged in（未登录时） | 未登录阶段非 USER/PASS 一律 530 |

### 4.7 超时与异常处理

| 场景 | 超时值 | 动作 |
|---|---|---|
| 控制连接空闲（WAIT_USER / WAIT_PASS / LOGGED_IN 无任何指令） | 60s | 响应 `421 Timeout` → 关闭控制连接 → `disconnected` 事件 |
| 控制连接空闲（TRANSFER 期间） | — | **挂起（M1）**：TRANSFER 期间不触发控制空闲超时，由传输定时器接管（见下） |
| PASV 监听等待数据连接（LISTENING） | 30s | 回注 `dataTimeout` → 关闭数据监听，回 LOGGED_IN（**不发 421**，相机可重发 PASV） |
| 数据连接就绪后等待 STOR（CONNECTED 且无 file，M1） | 30s | 回注 `dataTimeout` → 响应 `425 Can't open data connection` → `closeData` → 回 LOGGED_IN |
| 数据传输无进展（stall，file 接收中） | 60s | 回注 `transferStalled` → 响应 `426 Connection closed; transfer aborted` → `discardTemp` 删除半成品 → `closeData` → 回 LOGGED_IN；M9 同时产出 emitError(1008) |
| 对端异常关闭（控制或数据连接） | — | 回注 `peerClosed` → 立即清理：关闭全部相关 socket、删除 `.part` 临时文件（传输中，M10）、发 `disconnected`；传输中同时产出 emitError(1008) |
| Android 15 dataSync FGS 上限 | 系统强制（24h 累计，M6） | `onTimeout(startId, fgsType)` → error(1007) → 停服务（见 5.2） |

**状态 × 定时器矩阵（M1）**：

| 状态 | 控制空闲 60s | PASV 监听 30s | 待 STOR 30s | 传输 stall 60s |
|---|---|---|---|---|
| WAIT_USER / WAIT_PASS | ✅ 触发 → 421 关闭 | — | — | — |
| LOGGED_IN | ✅ 触发 → 421 关闭 | — | — | — |
| TRANSFER(LISTENING) | ⏸ 挂起 | ✅ 触发 → dataTimeout（无响应回 LOGGED_IN） | — | — |
| TRANSFER(CONNECTING) | ⏸ 挂起 | — | — | —（连接失败由 dataConnectFailed 处理） |
| TRANSFER(CONNECTED, 无 file) | ⏸ 挂起 | — | ✅ 触发 → dataTimeout（425 回 LOGGED_IN） | — |
| TRANSFER(file) | ⏸ 挂起 | — | — | ✅ 触发 → transferStalled（426 回 LOGGED_IN） |

> 幂等约定：重复/错位的回注事件（如 LOGGED_IN 收到 dataTimeout）被状态机忽略（no-op），保证执行器时序异常不破坏状态机。

**会话并发策略**：单会话串行 —— 控制连接监听循环每次只受理一个客户端；新连接到来时若已有活跃会话，直接响应 `421 Too many users` 并关闭。佳能单相机场景够用，且大幅简化状态管理。

---

## 5. Android 原生实现设计（utssdk/app-android）

### 5.1 AndroidManifest 权限清单

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<service
    android:name="uni_modules.ftp_receiver.utssdk.app_android.FtpForegroundService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
```

- **包名归一（M8）**：插件 id `ftp-receiver` 与目录名 `app-android` 中的连字符，按 DCloud UTS 编译规则统一转下划线 —— 最终包名 `uni_modules.ftp_receiver.utssdk.app_android`。`.kt` 文件的 `package` 声明、manifest 的 `android:name`、`index.uts` 的 import 三者必须一致（"包名三统一"）。此归一规则需 HBuilderX 编译验证（待真机验证项 T-1）。
- **通知权限（L2）**：`POST_NOTIFICATIONS` 需声明且 Android 13+ 运行时申请（业务层/示例页首次启动时申请）；FGS 通知属系统强制通知，未授权时服务仍可运行但通知栏不可见/受限。
- 不需要存储权限（全程 filesDir）。
- 在线打包由插件 manifest.json 注入；离线打包兜底在离线工程 AndroidManifest.xml 同文声明（D1 双路径）。

### 5.2 FtpForegroundService 生命周期

| 阶段 | 行为 |
|---|---|
| 启动 | `startServer()` → `Context.startForegroundService(intent ACTION_START)` → `onStartCommand` 中 `createNotificationChannel("ftp_server", 高/中重要性)` → `startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)` → 绑定 `ServerSocket:port` 并开始 accept 循环 → 通过 **FtpEvents 回调桥**（M7，见 5.5）回注 `__ready{ip, port}` → UTS 层 resolve `FtpStartResult` |
| 常驻 | 通知常驻（D8 文案「📷 相机连接中 · 照片实时接收中」）；`START_STICKY` —— 被系统杀死后重建，重建时若配置已持久化（SharedPreferences 存最近一次 options），自动恢复监听；**恢复时不再发 ready 事件**（JS 层可能已不在） |
| 传输保护 | **传输级持有 PartialWakeLock（M3）**：传输开始获取、结束释放，`acquire(10min)` 兜底防泄漏；空闲时不持有（省电） |
| Android 15 dataSync 上限 | `onTimeout(startId, fgsType)`（API 35 双参签名，M6）：停止监听 → 释放资源 → `stopForeground(STOP_FOREGROUND_REMOVE)` + `stopSelf()` → 异步发 `error(1007)` → JS 层提示用户重新开启。上限为 **24h 累计**（dataSync 计时累计运行时长），应用需 targetSdk 35。**Debug 测试钩子**：`ACTION_SIMULATE_TIMEOUT`（仅可调试构建处理）提前触发同一 onTimeout 流程 |
| 停止 | `stopServer()` → `ACTION_STOP` → 关闭监听与全部活跃连接（传输中先终止数据通道，`.part` 由状态机 peerClosed 路径清理，M10）→ 释放 WAKE_LOCK → **清除持久化配置（M2，防 START_STICKY 停了又起）** → `stopForeground(STOP_FOREGROUND_REMOVE)` → `stopSelf()` → 通过回调桥回注 `__stopped` → Promise resolve |
| 崩溃兜底 | 服务进程内异常捕获，保证通知不残留；onDestroy 时若持有锁全部释放 |

### 5.3 STOR 流式写盘设计

```
数据连接 InputStream ──► 64KB 环形缓冲 ──► FileOutputStream(filesDir/dir/.<name>.<ts>.part)
                                                    │ 流关闭后
                                                    ▼
                                    rename → filesDir/dir/<最终名>
```

| 项 | 设计 |
|---|---|
| 缓冲区 | 64KB（CR3 单文件可达 30MB+，64KB 缓冲在吞吐与内存间平衡） |
| 写盘时机 | 边收边写，不落内存缓存；`dataComplete`（流关闭 + rename 完成后）才发 `fileReceived` —— **事件携带的一定是完整可读文件** |
| 原子性 | 先写 `.part` 临时文件，完成后再 rename；任何失败路径 `discardTemp` 删除半成品，目录里绝不残留不完整文件 |
| 命名冲突 | 目标名已存在 → 追加时间戳后缀 `<stem>_yyyyMMdd_HHmmss.<ext>`（纯函数 `resolveTargetName`，可单测）。冲突改名后的最终名随 `fileReceived.meta.name` 下发，业务层按事件用名即可 |
| 路径安全 | STOR 文件名白名单校验：拒绝 `/`、`\`、`..`、空名、控制字符 → 553 |
| 空间保护 | 写入抛 `IOException`（磁盘满）→ 回注 `transferFailed` → 响应 450 + `discardTemp` + `closeData`，并产出 `emitError(1005)`（**error 事件，不终止服务**，M4/M9） |
| 格式说明（L7） | 接收文件为相机原始格式（含 CR3 佳能 RAW），**需独立解析器**（H5 原型 JPEG EXIF 解析不适用），解析/归类属业务层后续阶段，本插件只保证字节完整落盘 |

> `transferring.size`：FTP 最小命令集不含 SIZE 命令，相机不声明文件大小，恒为 0（未知）——此时 `dataComplete` 的 size 校验**跳过**（expected=0 视为未知，不判错，L1）。

### 5.4 热点 IP 枚举（HotspotIp.kt）

```
fun findHotspotIp(): String? {
  for (iface in NetworkInterface.getNetworkInterfaces()) {
    if (!iface.isUp || iface.isLoopback) continue
    // 优先：热点 AP 网卡（Android 常见 wlan0/ap0 上的 192.168.43.1）
    val addrs = iface.inetAddresses.filterIsInstance<Inet4Address>()
    // 命中已知热点网段即返回：
    //   192.168.43.0/24（Android 默认热点）192.168.232.0/24（部分厂商）
    //   172.20.10.0/24（iPhone 热点——开发期用 iPhone 开热点时的场景）
    // 兜底：返回第一个非回环 IPv4
  }
}
```

- 返回值用于：`227 Entering Passive Mode` 中的 IP 四段 + `startServer()` 返回的 `FtpStartResult.ip`（界面展示"请相机连接 192.168.43.1"）。
- 注意：必须返回**热点网卡地址**而非蜂窝数据地址，否则相机 `PASV` 数据连接会连到错误网段。
- **无热点 IP（L6）**：枚举失败（未开热点）时服务仍启动成功（绑定 0.0.0.0），但 `FtpStartResult.ip` 为空串，并异步产出 `emitError(1006, "未检测到热点网段 IP，请确认已开启手机热点")` 警告事件 —— 不误导用户以为可以直连。

### 5.5 UTS 调用 java.net.ServerSocket 的映射方式

UTS（app-android）编译为 Kotlin，`java.*` 与 `android.*` 可直接 import 使用；同目录 `.kt` 原生类同样直接 import（**包名三统一**：`.kt` package 声明 = manifest `android:name` = `index.uts` import，统一为连字符归一后的 `uni_modules.ftp_receiver.utssdk.app_android`，M8）：

```typescript
// utssdk/app-android/index.uts —— 示例节选
import java.net.ServerSocket
import java.net.InetSocketAddress
import java.net.InetAddress
import uni_modules.ftp_receiver.utssdk.app_android.FtpForegroundService
import uni_modules.ftp_receiver.utssdk.app_android.FtpEvents
import uni_modules.ftp_receiver.utssdk.app_android.FtpProtocolBridge

export function startServer(options: FtpServerOptions): Promise<FtpStartResult> {
  // 1) 参数校验（错误码 1003，端口 1–65535）
  // 2) 校验通过 → 写入持久化配置 → startForegroundService(FtpForegroundService, ACTION_START)
  // 3) 服务内 FtpServer.kt：ServerSocket 绑定 + accept 循环
  // 4) 等待服务就绪信号：FtpEvents 回调桥（UTS 常规回调模式，M7）回注 "__ready" → resolve
}
```

要点：
- `ServerSocket` 绑定与 accept 循环放 `.kt`（`FtpServer.kt`），用独立线程（Thread/协程），避免阻塞 UI 线程；UTS 层只做参数校验、服务编排与事件桥接。
- 控制连接与数据连接的读写全部在服务内线程完成，UTS 回调桥（`FtpEvents.kt`，原生 → UTS 的**静态 Lambda 槽** + 主线程 Handler）把事件派发到 JS 层（M7）。
- 状态机纯函数（`ftp-protocol.uts`）由 `FtpServer.kt` 经 **`FtpProtocolBridge.kt`** 调用：`.kt` 持有 `resetImpl/commandImpl/eventImpl` 三个 Lambda 槽，UTS 层在 `startServer` 时注入实现（内部持有 `FtpMachine` 实例）；结果以 JSON（responses/effects/fatal）回传执行。该桥避免了原生层直接引用 UTS 编译产物类名（类名由编译器生成、不可控）。
- 事件桥：`connected / disconnected` 由原生层发出；`transferring / fileReceived / error`（1005/1006 警告/1008）全部由状态机 effects 触发（M9，保证改名后的文件名与事件一致、错误口径统一）。

---

## 6. JS 层封装设计（src/composables/useFtpServer.uts）

### 6.1 组合式函数接口

```typescript
export function useFtpServer() {
  // 状态机：idle → starting → running → stopping → idle；任何失败 → error →（重试时）starting
  const phase = ref<'idle' | 'starting' | 'running' | 'stopping' | 'error'>('idle')
  const error = ref<{ code: number; message: string } | null>(null)
  const serverInfo = ref<FtpStartResult | null>(null)   // {ip, port}，供界面展示连接信息
  const lastEvent = ref<FtpServerEvent | null>(null)    // 最近事件，供调试面板

  async function start(options: FtpServerOptions): Promise<boolean>
  async function stop(): Promise<void>

  // 事件订阅（内部用 onEvent 注册，返回的句柄记录，页面卸载时自动退订）
  function onFileReceived(cb: (meta: FtpFileMeta) => void): void   // fileReceived 便捷订阅
  // 返回 { phase, error, serverInfo, lastEvent, start, stop, onFileReceived }
}
```

### 6.2 与 H5 原型的对接点（照片到达 → 读 GPS → 500m 归类 → 本地库）

- **插件边界**：`useFtpServer` 只负责服务生命周期与文件到达通知（`fileReceived` 给出 `{path, size, name}`）。文件是否为新照片、GPS 提取、归类、入库全部由业务层处理。
- **对接点**（文件到达后业务管线，本设计只约定接口，实现归业务层后续阶段）：
  1. `fileReceived.meta.path` → 调用 EXIF 解析模块读取拍摄时间 `DateTimeOriginal` 与 GPS（复用 H5 原型逻辑：GPS 解析超时 8s 则用地图中心 ±0.0015 随机偏移兜底）；
  2. GPS 坐标 → 500m 距离归类（复用原型 pendingPhotos 归类算法）；
  3. 归类结果 → 写入本地库（照片表）。
- **对齐保证**：`fileReceived` 的事件结构（`{path, size, name}`）与 H5 原型 `wsWritePending(thumb, exifDate, lng, lat, gpsSource)` 的调用点一一对应，编码阶段替换 `wsWritePending` 的"文件来源"一端即可，归类管线不改动。
- **页面生命周期**：`onMounted` 时 `onFileReceived` 注册管线；`onUnmounted` 时自动退订（`onEvent` 返回的退订函数持有）。

---

## 7. 单元测试计划（状态机纯函数）

测试对象：`ftp-protocol.uts` 的 `handleCommand` / `handleEvent` / 文件名规约函数（零 IO，Vitest / uni 测试 / Node strip-types 均可直接跑）。

> 修订说明（v1.0）：#7/#9 因 H2 两阶段协议改为"两步"用例；#17/#18/#28 按 M9 增补 emitError；#19 补 M1 待 STOR 超时分支；#23 按 L5 改 502；新增 #29–#33（M5 佳能目录兼容、H2 dataConnectFailed、M10 QUIT 传输中清理）。

| # | 用例 | 初始状态 | 输入 | 期望输出（状态 / 响应 / 效果） |
|---|---|---|---|---|
| 1 | 新连接首包 | （初始） | USER ftpuser | WAIT_PASS / 331 / — |
| 2 | 未登录先 STOR | （初始） | STOR x.CR3 | WAIT_USER / 530 / — |
| 3 | 未登录先 PASV | WAIT_PASS | PASV | WAIT_PASS / 530 / — |
| 4 | PASS 正确 | WAIT_PASS | PASS ok123 | LOGGED_IN / 230 / — |
| 5 | PASS 错误 | WAIT_PASS | PASS wrong | WAIT_PASS / 530 / — |
| 6 | 密码连续错 3 次 | WAIT_PASS | PASS wrong ×3 | CLOSED / 421 / fatal |
| 7 | PASV 正常（两阶段，H2） | LOGGED_IN | ① PASV ② notify dataListening(51201) | ① TRANSFER(LISTENING) / 无响应 / openDataListen ② LISTENING / 227 (192,168,43,1,200,1) / — |
| 8 | PASV 后 dataAccepted | TRANSFER(LISTENING) | notify dataAccepted | TRANSFER(CONNECTED) / — / — |
| 9 | PORT 正常（两阶段，H2/H1） | LOGGED_IN | ① PORT 192,168,43,1,200,1 ② notify dataConnected | ① TRANSFER(CONNECTING, target={peerIp,51201}) / 无响应 / connectData(host=peerIp) ② CONNECTED / 200 / — |
| 10 | PORT 语法错误 | LOGGED_IN | PORT 192,168,43,1,999 | LOGGED_IN / 501 / — |
| 11 | PORT 后 dataConnected | TRANSFER(CONNECTING) | notify dataConnected | TRANSFER(CONNECTED) / 200 / — |
| 12 | 数据通道未就绪 STOR | LOGGED_IN | STOR a.CR3 | LOGGED_IN / 425 / — |
| 13 | STOR 正常 | TRANSFER(CONNECTED) | STOR IMG_0001.CR3 | TRANSFER(file) / 150 / emitTransferring + receiveFile |
| 14 | STOR 文件名非法 | TRANSFER(CONNECTED) | STOR ../evil | TRANSFER(CONNECTED) / 553 / — |
| 15 | 文件名冲突 | TRANSFER(CONNECTED) | STOR IMG_0001.CR3（已存在） | target 改为 IMG_0001_20260809_153012.CR3（规约函数测试） |
| 16 | 传输完成（大小一致） | TRANSFER(file) | notify dataComplete(正确 size) | LOGGED_IN / 226 / emitFileReceived(真实名) + closeData |
| 17 | 传输完成（大小不符） | TRANSFER(file) | notify dataComplete(错误 size) | LOGGED_IN / 426 / discardTemp + closeData + emitError(1008)（M9） |
| 18 | 传输 stall 超时 | TRANSFER(file) | notify transferStalled | LOGGED_IN / 426 / discardTemp + closeData + emitError(1008)（M9） |
| 19 | PASV 监听超时 | TRANSFER(LISTENING) | notify dataTimeout | LOGGED_IN / — / closeData |
| 19b | 数据就绪后 30s 无 STOR（M1） | TRANSFER(CONNECTED, 无 file) | notify dataTimeout | LOGGED_IN / 425 / closeData |
| 20 | TYPE I | LOGGED_IN | TYPE I | LOGGED_IN / 200 / — |
| 21 | TYPE A | LOGGED_IN | TYPE A | LOGGED_IN / 504 / — |
| 22 | SYST | LOGGED_IN | SYST | LOGGED_IN / 215 UNIX Type: L8 / — |
| 23 | LIST（L5） | LOGGED_IN | LIST | LOGGED_IN / 502 / — |
| 24 | 未知命令 | LOGGED_IN | XXXX | LOGGED_IN / 500 / — |
| 25 | QUIT | LOGGED_IN | QUIT | CLOSED / 221 / fatal |
| 25b | 传输中 QUIT 清理（M10） | TRANSFER(file) | QUIT | CLOSED / 221 / discardTemp + closeControl, fatal |
| 26 | 控制空闲超时 | LOGGED_IN | notify ctrlIdleTimeout | CLOSED / 421 Timeout / closeControl, fatal |
| 27 | 会话互斥（第二连接） | 会话活跃中 | （连接层策略，非状态机） | FtpServer 响应 421 Too many users（代码审查 + 真机验证） |
| 28 | 传输中 peerClosed | TRANSFER(file) | notify peerClosed | CLOSED / — / discardTemp + closeControl + emitError(1008)（M9）, fatal |
| 29 | CWD 兼容（M5） | LOGGED_IN | CWD /DCIM | LOGGED_IN / 250 / — |
| 30 | MKD 兼容（M5） | LOGGED_IN | MKD newdir | LOGGED_IN / 257 / — |
| 31 | PWD 兼容（M5） | LOGGED_IN | PWD | LOGGED_IN / 257 / — |
| 32 | NOOP 兼容（M5） | LOGGED_IN | NOOP | LOGGED_IN / 200 / — |
| 33 | PORT 连接失败（H2） | TRANSFER(CONNECTING) | notify dataConnectFailed | LOGGED_IN / 425 / closeData + emitError(1008) |

覆盖率要求：上述用例全绿 + 状态转移不变量（任一指令/事件输入不会导致未定义状态，用穷举小矩阵辅助）。

---

## 8. 验收标准（对齐阶段②a）

| # | 验收项 | 标准 |
|---|---|---|
| A1 | 佳能相机连接手机热点 | 相机 FTP 客户端可连入，登录成功，`connected` 事件触发 |
| A2 | PASV 模式传输 | 佳能设置被动模式=开，连传 **10 张**（含 CR3 原图 + JPEG），成功 **100%** |
| A3 | PORT 模式传输（佳能被动模式关闭） | 设置被动模式=关，连传 **10 张**，成功 **100%**（佳能多数教程场景） |
| A4 | 锁屏稳定性 | 锁屏 **30 分钟**：服务存活、期间可继续接收、事件日志连续无中断 |
| A5 | 真机矩阵 | **Android 13 / 14 / 15** 各至少 1 台真机（含 1 款国产 ROM）通过 A2–A4 |
| A6 | 文件完整性 | 接收文件字节数与相机原文件一致；CR3 可被本地解析器打开 |
| A7 | 命名冲突 | 同名第二张自动改名落盘，`fileReceived.meta.name` 与磁盘实际文件名一致 |
| A8 | 异常路径 | 端口占用 / 密码错误 / 传输中断 / 断线重连：无崩溃、错误码与事件正确、可重试 |
| A9 | Android 15 dataSync 上限（M6 修订） | 达到上限（24h 累计运行）后 error(1007) 事件正确上报、服务停止、无残留通知。**验证手段**：Android 无"缩短 timeout"开发者选项，改为使用 debug-only 测试钩子 `ACTION_SIMULATE_TIMEOUT` 提前触发同一 `onTimeout(startId, fgsType)` 流程验证行为；真实 24h 上限在测试机（targetSdk 35、Android 15）上累计运行时验证 |

---

## 9. iOS 占位章节（D3 延期）

### 9.1 接口签名保留

`utssdk/app-ios/index.uts` 保留与 interface 完全一致的签名（类型定义不重复，仅导出同名函数），实现体统一抛错：

```typescript
// utssdk/app-ios/index.uts —— 占位实现
export function startServer(options: FtpServerOptions): Promise<FtpStartResult> {
  return Promise.reject({ code: 9001, message: 'iOS 未实现（D3 延期，待王总确认后激活）' })
}
export function stopServer(): Promise<void> {
  return Promise.reject({ code: 9001, message: 'iOS 未实现（D3 延期）' })
}
export function onEvent(handler: FtpEventCallback): () => void {
  return () => {}
}
```

### 9.2 延期原因与激活条件

- **延期原因**（王总 D3 决策）：iOS 侧（SwiftNIO 或 BSD socket + Bonjour 地址发现）排期靠后；先以 Android 验证"相机 FTP 直传"产品路径与体验，避免双端并行投入。
- **激活条件**：王总确认启动 iOS（D3 状态变更）。激活时：① 状态机纯函数已在 `interface` 层就绪，**原样复用**；② 仅需编写 iOS 副作用执行器（socket 层 + 前台服务等价物：iOS 用 Background Task / 长时间运行声明，注意 App Store 对"远程 FTP 服务器"类后台传输的审核风险，需按上传类 App 用途声明）；③ `app-ios/index.uts` 从占位改为真实实现，API 签名零改动，业务层无感知。
- **H5 端**：不提供原生能力；原型页保留模拟实现（现有 `connect-prototype.html` 行为），不做降级实现，仅用于 UI/流程走查。

---

## 10. 待办决策清单（标"待王总确认"）

| 决策 | 议题 | 选项 | 建议 | 影响 |
|---|---|---|---|---|
| D5 | 存储策略：JPEG 镜像到 DCIM | ① 只落应用私有目录（最简单，无需存储权限）② 原图落私有目录 + JPEG 镜像 DCIM（用户在系统相册可见，需 SAF/媒体库权限与双写） | ✅ 已确认：阶段②a 做 ①（本设计按 ① 展开，不含 DCIM 双写）；② 作为后续可选能力，`FtpStore` 预留镜像扩展点 | 插件存储层接口是否预留镜像回调 |
| D6 | FTP 账号策略 | ① 固定内置账号 ② 每次启动随机生成并在 UI 展示 ③ 用户自定义 | ✅ 已确认：② 随机账号每次启动生成展示在连接引导页（安全 + 免配置） | 仅影响 JS 层参数来源，插件 API 不变 |
| D8 | FGS 常驻通知文案 | 占位："FTP 服务运行中 · 点按查看" + 是否显示当前连接相机数量 | ✅ 已确认：「📷 相机连接中 · 照片实时接收中」（标题「📷 相机连接中」+ 内容「照片实时接收中」） | 仅文案，不改架构 |

> 三项均已在 v1.0 确认并冻结（API 签名不变）。任何决策变更需回到本文档同步修订。

---

## 附录：本阶段明确不做（防范围蔓延）

- 不做 FTP 下载/浏览/删除等扩展命令（仅上传最小集）。
- 不做多相机并发会话（单会话串行，佳能单相机场景）。
- 不做断点续传（相机重传整文件；本方案落盘原子性保证无残留半成品）。
- 不做 TLS/FTPS、不做匿名登录。
- 不做 DCIM 镜像（D5 待定，见第 10 章）。
