# 相机互联·USB 有线连接真机联调指南（2026-08-17 r24 更新）

> 目标：Android 手机 USB OTG 直连佳能 5D2，实现连接 → 快门 → 照片进待归类管线。
> 技术：自研 PTP 协议栈（camera-ptp.js）+ 双传输层——**App 内 Native.js**（usb-transport.js，r17 判死留档）+ **浏览器 WebUSB**（browser-usb-transport.js，r18 首版 → **r24 精简版当前有效**）。**已上线**。
> 阶段1 不含实时取景（二期原生插件）；拍照为真实链路。

> **当前状态（2026-08-17，r24）**：协议层已由**电脑直连 5D2 真机 100% 验证并真实出片**（快门 0x9128 正解，见「五」）。Native.js 路线 r17 判死（桥无 Java 数组创建能力，读方向无解）→ 主线转 **WebUSB 传输层**（browser-usb-transport.js）：r18 首版 → **r19-r24 六连迭代收官**（详见「七」）。**r24 精简版（295 行）已上线**，保留经真机实证的必要逻辑：r23 空序列号匹配、r22 claim 前 releaseInterface 容错、r19 bytesWritten/stale 校验、r21 非相机设备拒绝。**当前未决**：页面 openSession 超时 vs 裸实验同时刻成功 → **相机会话残留假设**；**0x66 Device Reset 建议重新试验**（会话清理候选，见「七」）。App 壳内后续走 UTS 插件（二期，见「八」）。

## 一、打包 App（HBuilderX 云打包，约 10-20 分钟）

1. 安装 HBuilderX（官网 uniapp.dcloud.net.cn，Windows 版），用 DCloud 账号登录
2. **导入项目**：文件 → 导入 → 从本地目录导入 → 选择 `uni-preset-vue-vite` 文件夹（**不是仓库根目录**）
3. 发行 → **原生App-云打包** → 平台选 **Android(apk)** → 提交打包（首次需登录账号；打包过程可切后台等通知）
4. 打包完成后下载 APK，发送到测试手机安装
   - ⚠️ 测试手机只有一个 micro-USB 口：**装好 APK 后拔掉电脑数据线**，用 OTG 转接头插相机，二者不能同时

## 二、真机测试步骤（约 5 分钟）

**准备**：
- 相机开机，**插入存有照片的 SD 卡**（空卡也能拍，但确认「PC连接」模式：菜单 → 设置（黄扳手）→ 通信设置 → USB连接 → **PC连接**）
- OTG 转接头（micro-USB 公口插手机）+ 相机原装 USB 线（mini-USB 端插相机）

**操作流程**：
1. 手机打开 App → 底部「联机」→ 相机互联（默认页）
2. 点击「**有线连接**」→ 弹出「USB 连接相机」弹层
3. 点击「**检测设备**」→ 列表出现「佳能相机」（识别码 0x04a9:0x3199）
4. 点击该设备 → 系统弹出 **USB 权限授权框** → 点「允许」
5. 连接成功自动进入工作台：标题显示「Canon EOS 5D Mark II」、画面区显示「已连接」等待占位
6. 点击底部**快门** → 相机闪光屏效 + 真拍一张 → 工作台显示刚拍的真实照片、相册角标 +1、toast 显示耗时
7. 回首页 → 应看到**待归类**里有刚拍的照片（缩略图真实）→ 可归类出坐标点

## 三、连接性能测试要点（王总关注的项）

| 关注项 | 怎么测 | 预期 |
|---|---|---|
| 连接建立时长 | 点设备到进工作台的秒数 | < 3s（USB 2.0 本地直连） |
| 快门响应 | 按快门到闪光 + toast 出现 | 1-3s（含拍摄+JPEG 下载） |
| 照片传输 | toast 显示的耗时（含下载+落库） | 单张 15MB 约 1-2s |
| 稳定性 | 连拍 10 张不失败 | 无掉线/无失败 |
| 防休眠 | 不操作 60s 后再拍 | 仍可正常拍（协议栈每 15s 保活） |
| 拔插重连 | 拔线→重新检测→再连 | 正常（拔线后 App 应提示断开） |
| 相机拔线时 | 拔线后按快门 | 提示「拍摄失败」不崩溃 |

## 四、常见问题排查

| 现象 | 原因/处理 |
|---|---|
| 检测不到设备 | ① OTG 线方向反了（公口插手机）② 相机未开机 ③ 手机硬件不支持 OTG（可用 OTG Checker 类 App 验证） |
| 弹层提示「USB 不可用」 | 页面不在 App 内（浏览器打开只支持无线检测） |
| 授权框没出现 | 相机被其他 App（如 qDslrDashboard）占用——先关闭其他应用 |
| 连接时误弹系统授权框 | **（r23 已修复）** 5D2 无序列号曾导致 getDevices 匹配失败误弹授权框——r24 起按 vid:pid + 空 serial('ns') 匹配，直接连接不再误弹 |
| 连接失败：claimInterface 失败 | ① **（r22 已修复）** claim 前已加 releaseInterface 容错，消除上次会话/其他页面占用残留 ② Windows 下 camsvc/StiSvc 服务抢占需管理员停用（HANDOVER §6.2 实锤） ③ Android 端被系统挂驱动时杀占用 App/重启相机 |
| **点设备后长时间停在「连接中」** | **（r19-r24 已六连修复；若仍复现 → 当前主线）** 点「USB诊断」按钮，把弹窗 JSON 截图发给开发者——usbVer 应为 **20260816-r24**，判读见「六/七」；并按「七」对照**相机会话残留假设**（0x66 重新试验） |
| 拍摄失败：等待照片事件超时 | 相机参数/模式问题：避免「镜像锁定」开启；RAW+JPG 双格式会慢（等 30s）；相机休眠后先唤醒 |
| 拍照后取景器还是等待画面 | 照片下载失败（看 toast 提示），重拍一次 |
| App 内页面还是旧版 | App 内 web-view 加载线上页面，确认线上已更新（见部署链路）；必要时杀 App 重进 |

## 五、技术说明（阶段边界）

- **已实现**：连接/授权/设备信息/远程模式/快门/照片下载/EXIF 拍摄时间/GPS/待归类管线/保活
- **二期（原生插件）**：实时取景 EVF（1-2fps）、取景器实况、参数面板（ISO/光圈/快门）
- 代码位置：`camera-ptp.js`（协议栈，可单测）、`usb-transport.js`（Native.js 传输层）、联机页内 usbCam 模块
- 协议栈单测：`node script/test-ptp.js`（mock 相机全链路 **34/34**）+ `node script/test-transport-mock.js`（mock plus 桥 + 5D2 描述符全流程 **8/8**）

### 2026-08-16 协议栈全面重写要点（对照 gphoto2 成功实现）

| 项 | 旧实现（错） | 新实现（gphoto2 权威做法） |
|---|---|---|
| 标准 opcode | OpenSession 0x1001 / GetDeviceInfo 0x1004 / GetObject 0x100A（整体错位+1） | **0x1002 / 0x1001 / 0x1009** |
| 快门 | 旧「0x910F 无参数单发」在 5D2 真机返回结果码 **3（反光板抬起失败）** 无法出片 | **4f02221 实锤正解：0x9128 半按(1,0)→1.5s→全按(2,0)**（响应 params[0]=0 成功）**→ 0x9129(3) 全释放**，电脑真机已真实出片 6.1MB JPEG |
| GetEvent 事件 | count+定长 20 字节解析（错） | **[size][code][变长负载] 链**，0xC181 Handle@0x08=objectId |
| 读包 | 一次读一包，多余字节丢弃（真机必炸） | **流式粘包**（PacketStream 缓存盈余字节，跨多次 bulk 拼包） |
| OpenSession | 固定 sessionId=0x5D20 发一次 | **transid=0、sessionId 从 1**，0x201E 放行、0x2004 递增重试（≤10） |
| 相机忙 | 直接报错 | **DEVICE_BUSY(0x2019) 200ms 自动重试（≤5 次）** |
| 取图 | 只支持卡上 0x9104 | **双路径**：卡=0x9104；SDRAM(StorageID=0)=0x9107 分块 1MB + 0x9117 |
| 超时 | 3s/8s/30s | **20s 常规 / 100s 取图 / 90s 等照片**；保活 0x911D 每 10s |
| 传输层 | 空读即错 | **n=0 重读一次（ZLP 遗留）**；写方向也 clear halt；端点地址取真实值；单次读 ≤16KB（Android 上限） |

### 复验时的预期行为（与旧版差异，可据此判断新代码是否生效）

- 连接流程多两步（无感）：排空初始事件（防 Busy）+ 设置照片落 CF 卡
- 连接成功 toast 会提示「相机按键将锁定 buSy，拔线恢复」——**这是 5D2 固件行为**（gphoto2 社区多年实证，任何软件都解不开），不是故障
- 快门后等照片最长 90s（拍 RAW/写卡慢时别急着认为失败）
- **5D2 电脑真机实锤的协议细节（4f02221）**：PTP 字符串是 **UTF-16LE**（str() 已自动检测）；SetCaptureDest 返回 **0x200A DevicePropNotSupported**（5D2 不支持，失败忽略是设计行为）；storageId=0x00010001（CF 卡）走 0x9104 取图

## 六、USB 诊断 JSON 判读（r17 定分支——Native.js 判死依据；WebUSB 判读见「七」）

连接卡住时点「USB诊断」按钮 → 弹窗 JSON 截图发回。**判定标准**：

| 字段 | 判读 |
|---|---|
| `usbVer` | 应为 **`20260816-r24`**（WebUSB 主线；不是 r24 说明线上旧版，先杀 App 重进/确认部署） |
| `probeByteArray` | **`byte[]=ok` 或 `[B=ok` → 桥能创建 Java 数组 → 读回链路继续调（String 转换/逐字节 get 兜底），可继续迭代**；**`null` 或 `throw:...` → 桥无数组创建能力实锤 → 转 UTS 原生插件**（与 EVF 二期合并，transport 接口已预留，页面/协议零改动，需 HBuilderX 云打包） |
| `lastBufMode` | 上次连接用的数组形态（byte[]/[B/JS 数组）——失败后也能读，用于交叉验证 probeByteArray |
| `ifaceInfo` | class=6 + 0x81 IN / 0x02 OUT / 0x83 中断 IN（5D2 真实描述符） |
| `plusAndroidKeys` | 桥对象可枚举键——有 `java/android/androidx/io` 命名空间即桥可用 |

**历史说明**：r17 前 Native.js 读方向已知问题（JS 数组读回全 0「非法包长 0」）——该判读仅适用 Native.js 时代；WebUSB 时代（r18+）正常应直接走通，卡住按「七」会话残留假设排查。

**预期全通链路**（分支判 ok 后）：OPEN_SESSION → 排空事件 → 工作台（buSy toast）→ 快门（0x9128 半按 1.5s → 全按 → 释放）→ 90s 内 0xC181 → JPEG 落 pendingPhotos（EXIF 时间 + 手机 GPS → 地图坐标点）

## 七、WebUSB 直连测试（r18 首版 → r24 精简版，当前主验证线）

**背景**：r17 实锤 App 内 Native.js 桥无法创建 Java byte[]（读方向无解）；r18 上线 WebUSB 传输层——**浏览器（Chrome/Edge）直接连相机**，官方成熟方案（GoogleChromeLabs/web-gphoto2 在 Android 手机直连佳能实测出图；参考实现 tethr/baku89）。**零打包零部署**，电脑 Chrome 当天可验。

**先电脑 Chrome 验证（5D2 已 Zadig 换 WinUSB 驱动，直接可用）**：
1. 电脑 Chrome/Edge 打开 `https://dsofatjxxjyf.sealoshzh.site/connect-prototype.html`
2. 相机开机 + USB 连电脑 → 有线连接 → 检测设备 → **弹系统授权框** → 选「Canon EOS 5D Mark II」→ 允许
3. 连接 → 工作台（buSy toast）→ 快门 → 照片落待归类管线
4. 电脑端预期：**首次弹框选设备 → 全链路走通**（WebUSB 无桥限制，WebSocket 等网络 API 照常）

**再 Android Chrome OTG 验证（王总手机）**：
1. 手机 Chrome 打开线上 connect 页（**不是 App**，App 内 web-view 无 WebUSB）
2. 拔电脑线、OTG 接 5D2（同 App 测试物理步骤）
3. 有线连接 → 检测设备（弹授权框）→ 允许 → 连接 → 快门
4. **预期风险点（真机见分晓）**：Android 上相机接口若被系统挂驱动，claimInterface 报 busy（Chrome 工程师确认；2025-01 起新 Chrome 支持 detach 缓解）——若遇到报「接口被占用」，先杀占用 App/重启相机再试（r22 已加 claim 前 releaseInterface 容错，Windows 端此类 busy 已消除）

**诊断判读**：USB 诊断按钮 JSON——`usbVer` 应为 **20260816-r24**、`webusbMode:true`、`navigatorUsb:true`、`probeByteArray:"webusb"`（WebUSB 模式无需 Java 数组探测）。

**要点**：WebUSB 需要 https（线上满足）+ 用户手势（点检测按钮）；Windows 上非 Zadig 设备的「well-known」相机被系统驱动独占需先换驱动（macOS/Linux 开箱即用）；浏览器地址栏与 App 授权是独立两套，互不干扰。

### r19 → r24 版本演进（按 git log 还原）

| 版本 | commit | 内容 |
|---|---|---|
| r18 | f6bfb3c | WebUSB 传输层首版（浏览器直连，纯 JS 零打包） |
| r19 | ea97a57 | openSession 超时根因六连修复：bytesWritten 校验（写 0 字节假成功）、超时 stale 管道标记、读缓冲 ≥512、**移除 0x66 Device Reset** |
| r19b | 8e46014 | 失败诊断快照：连接失败后 USB 诊断仍可读传输层上下文（lastErr/lastTransportDiag） |
| r20 | f91131c | 全链路操作日志：命令是否发出/写了几字节/相机有无响应——openSession 超时一锤定音 |
| r21 | 922e77c | catch this 绑定修复 + 非相机设备友好拒绝（避免误授权设备连接报错） |
| r22 | 30057d0 | **claim 前 releaseInterface 容错**（消除 Windows 接口 busy 残留；不做 reset——5D2 老固件复位有风险） |
| r23 | 95a34d8 | **无序列号设备匹配修复**：5D2 空 serial 导致 getDevices 匹配失败误弹授权框 |
| r24 | ce439f0 | **精简重写（295 行）**：六轮补丁去冗余，诊断收敛为 diagInfo/lastError，核心逻辑不变 |

**0x66 Device Reset 重新试验建议**：r19 曾把 0x66 当作「超时元凶」移除，但当时超时实为 Windows camsvc/StiSvc 服务抢占（停用后 CDP 复现 claim: ok）——**移除依据失效**。作为**相机会话残留假设**的清理候选，建议下一步：连接前 try CloseSession(0x1003) + 首次 openSession 失败后重试验 0x66 Device Reset，再做完整连接验证（工作台 buSy toast）（HANDOVER §6.2 下一步 ②）。

## 八、App 壳内路线（UTS 插件，二期）

- App web-view 不支持 WebUSB（MDN 实锤）→ App 壳内 USB 走 **UTS 原生插件**（DCloud 官方主推，2026-08-16 调研定案）
- 插件实现 transport 接口（bulkOut/bulkIn/release），页面/协议栈**零改动**（与 WebUSB 版同构，WebUSB 验证过的传输参数直接照抄）
- 传输层模式参考 remoteyourcam-usb（Apache-2.0）：命令/响应同步 bulkTransfer（200ms×3 重试）+ 大文件 16KB×3 UsbRequest 管道；保留我们的 clear halt（三套开源实现均无此层，是我们的超越点）
- 参考插件：estplugin-usbserial（ext.dcloud id=28207，UTS 源码随插件）；与 EVF 实时取景二期合并开发；需王总 HBuilderX 云打包（每轮 10-20 分钟）
