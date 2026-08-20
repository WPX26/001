# AI 接手交接文档 —— Memomap 地图相册平台

> 生成日期：2026-08-17（本文件由前 AI 秘书整理全部项目记忆而成，接手 AI 读完本文件 + 项目代码即可开工）
>
> ⚠️ 本文件为**工作交接**，不含任何密码/密钥值——所有凭据只写"存放位置指针"（见 §10）。

---

## 0. 开工前必读（30 秒版）

1. **用户是"王总"**（非技术背景），称呼"王总"；你是他的秘书兼员工，不是代码机器人。
2. **项目铁律**：不改 UI、不减功能；质量优先、不许降级方案；改一个界面必须同步所有含同类组件的界面。
3. **当前主线**：相机互联 USB 最后一层根因（页面 openSession 超时 vs 裸实验成功——会话残留假设），详见 §6.2。
4. **部署纪律**：改完只推 `git push github master`（推 origin=Gitee 不会触发构建）；线上验证通过**后**才能喊王总测试；每次改页面代码同步 bump `usbVer` 指纹。
5. **汇报纪律**：每次开工先报大纲+耗时；回答格式"先一句话结论 → 分条展开"；涉及决策先给方案+原因+难度。

---

## 1. 项目概述

**一句话**：个人摄影地图相册平台（App = uni-app 壳 + H5 网页业务层）——拍照/坐标点/作品分享/关注粉丝/私信/会员摄影师认证，附带「相机互联」（USB 直连单反拍照）与「手机互联」（远程控制）两大扩展功能。

**技术栈与架构**：
| 层 | 技术 | 位置 |
|---|---|---|
| 前端业务层 | 9 个 HTML 交互原型（真业务逻辑，非死页面），本地化 Leaflet 1.9.4 + Dexie | 项目根目录 9 个 `.html` |
| 本地静态服务器 | Python `server.py`（HTTP 8080 + HTTPS 8081 自签，no-store 头，双端口） | `server.py` |
| 后端 API | Node.js Express + MongoDB（真实业务后端，api.md 14 大模块蓝图） | `server/src/`（app.js/controllers/models/routes/services） |
| App 壳 | uni-app Vue3 Vite（4 tab 页 = web-view 全屏加载 H5；双导航已根治） | `uni-preset-vue-vite/` |
| 部署 | GitHub → 阿里云 ACR 自动构建 → Sealos 云（前端/后端两应用） | 见 §7 |

**根目录主要文件**：
- 9 原型页：`memo-home.html`（地图首页，核心）、`login-prototype.html`、`camera-prototype.html`、`connect-prototype.html`（联机页：相机互联+手机互联）、`message-prototype.html`、`profile-prototype.html`、`album-prototype.html`、`admin.html`（管理页）、`photographer-payment.html`；另有 `phone-link-prototype.html`（手机互联原型）
- 相机互联核心：`camera-ptp.js`（PTP 协议栈）、`usb-transport.js`（Native.js 传输层，已判死留档）、`browser-usb-transport.js`（WebUSB 传输层 r24，**当前有效**）
- `api.md`（接口蓝图）、`development-doc.md`、`Dockerfile.static`（ACR 构建）、`nginx.conf`、`card-bg.jpg`（他人主页卡片底图）、`fonts/`（玄宗体）
- `script/`：单测（test-ptp.js / test-transport-mock.js / test-webusb-mock.js）、`diag-usb-5d2.py` / `diag-shoot-5d2.py`（libusb 真机诊断，可复用）、`cdp/`
- `docs/`：设计文档 + `相机互联-USB真机联调指南.md`（最新 9c7e2f1 版）+ `相机互联-UTS插件方案.md`（二期蓝图）+ Sealos部署指南.md
- 参考图 `docs/` 多张（王总截图，含账号信息谨慎处理）
- 未入库目录：`_backup_*`、`_review_diff`、`_*.png`（截图产物）

**本地运行**：
- 静态：`PYTHONIOENCODING=utf-8 python server.py`（8080 HTTP + 8081 HTTPS；重启前 `taskkill //F //IM python.exe`）
- 后端：`server/` 内起 Node（⚠️ **本地 .env 指向线上 MongoDB**——`mongodb://root:***@dbconn.sealoshzh.site:42605`，起服务会连生产库！smoke/e2e 用内存 Mongo 无风险，其他调试谨慎）

---

## 2. 用户与工作方式

### 2.1 角色
- 王总自 2026-08 起要求：**我 = 秘书兼员工**，协调 `.github/agents/` 下六个专家代理（graphql-architect 构架师 / backend-architect 后端 / architect-reviewer 架构评审(Opus) / frontend-developer 前端 / mobile-developer 移动 / ui-ux-designer UI）。
- **员工全程参与机制**：所有工作任务（开发/部署/评审/决策/排期/UI 调整）凡适合专家的一律派专家因地制宜执行，不允许独自完成适合专家的专业工作；但六专家定义是 React/RN/GraphQL 通用模板，**实际是 uni-app 项目，需结合项目实际调整分工**。
- **秘书兜底**：专家产出由我逐一审查质量，差的直接改；**每次改了专家产出必须向王总汇报改了啥、提升在哪**。

### 2.2 汇报规则（回答格式硬要求）
1. **开工前先报大纲**：任务清单 + 每项预估耗时 + 总耗时；每完成一项打勾 ✅。
2. **固定三要素格式**：`方案：… 原因：…（利弊） 难度：…（难度在哪）`。
3. **先简后详**：先一句话直接结论，再分条展开（2026-08-13 起硬要求）。
4. **分条**：①②③ 或表格，一条一个意思，禁止大段堆砌。
5. **网址单独一行**（前后空行），方便王总整行复制。
6. 时间估算参考：后端接口 ~1h、前端页面对接 1-2h、小修复 10-30min。

### 2.3 授权边界（绿灯模式）
日常操作（改代码/配置/部署/测试/专家调度/常规修复）**自行决定执行，无需逐项确认**。**必须请王总拍板的重要决策**：
① 产生费用的操作（购买服务/升级套餐/付费开通）② 不可逆/破坏性操作（删数据/清库/删应用/关服务）③ 产品方向决策（功能取舍/认证模式/支付渠道/UI 调整方向）④ 对外发布（正式上线/公开发布）⑤ 生产密钥/敏感配置启用（真支付密钥/真短信/OSS 正式接入）⑥ 涉及资金行为（定价/打赏/退款）。

### 2.4 独立判断约束（2026-08-11 王总定，因"小微商户事件"教训）
① 动手前先查问题本身有无错误前提/逻辑跳跃/信息缺失 ② 不迎合，不同意直说 ③ 区分事实/推测/观点 ④ 数字结论核实来源 ⑤ 分歧给出依据+风险+替代解释 ⑥ 主动提醒王总忽略的变量（成本/风险/隐藏依赖）。

---

## 3. 铁律清单（违反即返工）

| # | 铁律 | 来源 |
|---|---|---|
| 1 | **不改 UI、不减功能**：产品化开发（接真实后端/修 bug）不得改动视觉样式、页面结构、交互流程；新功能只追加；模拟→真实的切换必须保持前端行为不变 | 王总 08-09 定 |
| 2 | **质量优先不降级**：遇阻碍不许降级为更简单方案绕过（例：ACR 私有镜像拉取失败 → 不许公开仓库，要配 imagePullSecret）；正规方案不可行才说明后由王总决策 | 王总 08-10 定 |
| 3 | **界面一致性**：改一个界面必须 grep 全项目同步所有含同类组件的界面（bottom-nav/nav-item/top-actions 等）；组件尺寸/间距/字号全局统一，配色风格保持各页原设计 | 王总 08-12 定 |
| 4 | **交互铁律**：全屏浮层必须无圆角（border-radius:0）；卡片点击 = 放大查看器 + 下拉 60px 关闭（全屏暗底大图 + ✕/背景点击关闭） | 王总 08-14 定 |
| 5 | **屏宽等比**：所有 UI 元素长宽 = 屏宽固定百分比（vw），与屏高无关；实现用纯 vw 乘法（`html{font-size:0.2667vw}` + rem，**禁止 calc(100vw/375)** 旧浏览器不支持）；底部导航 Tab 各 20% 屏宽高 7-8%、中央相机按钮直径 18%、悬浮工具栏按钮 6.9%、消息行卡片 95%×13%、头像 10-13% 等（详见 ui-screen-ratio 记忆） | 王总 08-13 定稿 |
| 6 | **记忆纪律**：索引与正文分离、单主题单文件、先检索再写、新结论覆盖旧结论、秘密永不入记忆（只存位置指针） | 王总 08-13 定 |
| 7 | **禁止主动截屏王总屏幕**，只能看他发的截图（除非王总允许） | 王总 08-13 定 |
| 8 | **部署验证纪律**：推送后**先 curl 线上 grep 特征确认更新，再喊王总测**；JS 迭代页面留 `usbVer` 指纹每次 bump | 08-16 USB 血泪教训 |

---

## 4. 产品规则（王总拍板定稿，不可更改）

**会员/摄影师**（2026-08-11 定稿）：
1. 高级会员 **¥6/月仅月卡**（暂无年卡）
2. **订阅 = 认证**：订阅成功自动 isPhotographer=true，无单独审核流程
3. 到期/取消 → 认证收回 + **探索池作品隐藏**（不展示，数据不删）
4. 重新订阅 → 恢复展示（数据保留）
5. **自动续费关闭**（方案B：到期不自动续，想继续就重新订阅付款）
6. **支付 = 半自动确认（方案A）**：用户下单 → 显示王总个人微信收款码 + 订单号（要求备注订单号）→ 待确认订单列管理页 → 王总手动点"确认开通"生效；代码按将来可切换官方商户号设计
7. 探索池过滤条件 = isPhotographer 派生值

**其他决策**：主攻 Web 补全（uni-app 是 web-view 壳，H5 是共用业务层）；跳过行政事项（短信资质卡企业主体，SMS_DEV_MODE=true 顶着）。

---

## 5. 当前进度总览（2026-08-17 快照）

| 模块 | 状态 |
|---|---|
| ① 密码登录/token 刷新/logout | ✅ 上线验证过 |
| ② 模式切换/邀请码双轨 | ✅ 上线 |
| ② 关注粉丝列表/他人主页/资料编辑 | ✅ 上线（7+ 轮定稿，见 §6.1） |
| ② 他人主页卡片染色/作品点开动画 | ✅ 上线验证过 |
| 品牌字玄宗体 | ✅ 上线验证过 |
| App 双导航根治（架构翻转） | ✅ 王总真机验证（只剩一行深色导航） |
| ⑥ 手机互联 | ✅ 三段上线待**两机真机实测**（§6.3） |
| ⑥ 相机互联 USB 阶段1（WebUSB r24） | 🚧 **当前主线**：最后一层根因待验（§6.2） |
| ③ 灵感/探索适配 | ⏳ 未开始（1-1.5 天，建议独立会话） |
| ④ 摄影师认证申请接口 | ⏳ 模型有接口无 |
| ⑤ 私信 WS 实时推送 + OSS 直传 | ⏳ 后端就绪前端未连 |
| ② 头像上传 | ⏳ 仅支持粘贴 URL |
| 相机 USB 二期（EVF）/ 手机互联原生二期 | ⏳ 未排期 |

---

## 6. 各模块详细状态

### 6.1 ② 个人主页系（改版前必读，王总 7+ 轮定稿）

**我的主页**（profile 菜单唯一入口 viewMyHome）：顶部卡片 = 与"我的界面"完全同款 profile-header（card-bg 暖橙风景图、56rem 头像左+名称/简介/徽章右、磨砂 edge-blur、点击折叠 240↔180、右上换卡按钮）→ 统计上层（获赞/互关/关注/粉丝 4 项 + 编辑主页描边按钮）→ 统计下层（坐标点/作品 tab，**获赞已去掉**，"照片"字样全改"作品"）→ 内容区。

**他人主页**（memo-home user-profile + profile peer-profile 两处同步）：顶部卡片 = 插画底图 card-bg.jpg + **按头像颜色染色**（`mix-blend-mode:color` + CSS 变量 --tint-light/dark，JS applyHeroTint/cardTintColors；头像为图片 URL 时取不了色 → 回退默认橙）→ 统计栏（获赞/关注/粉丝）→ [关注]橙渐变+[私信]描边 → 作品三列网格（up-card/pp-card），**所有作品卡片必须可点开**（含色块卡），点开 = openPhotoPreview 放大查看器（viewerIn 动画 opacity 0→1 + scale 0.92→1, 0.25s ease；色块分支显示渐变色+标题）。

**关注/粉丝列表**：无 tab 切换（点开是关注就是关注）；列表项头像+昵称+简介+关注按钮（乐观更新）；点击项进他人主页；followlist 标题动态"我的关注/我的粉丝"。

**资料编辑**：昵称≤20/简介≤200/头像 URL 粘贴（无上传控件）；保存 PUT /users/me → loadUserProfile() 全量刷新。

**防复活清单（已删除）**：抖音式 myprofile 入口（视图死代码不可达）、菜单"我的关注/我的粉丝"入口、统计栏"获赞"、"照片"字样、hero 曾两次引入又删除——最终 myhome 用内联 base64、他人主页用 `url('card-bg.jpg')`（文件在仓库根，Dockerfile 已 COPY）。

### 6.2 相机互联 USB（🚧 当前主线，信息量最大）

**目标**：王总手机 USB OTG 有线直连佳能 5D2（VID 0x04A9 : PID 0x3199，PTP 模式），在 App 里联机拍照，照片落 pendingPhotos 管线成坐标点。

**当前进度（2026-08-17 凌晨 r24 收官）**：
- 路线：Native.js 已判死（r17 probeByteArray 双变体全 throw——桥无数组创建能力，读方向架构性无解）→ **王总拍板"两段走"：先 WebUSB 验证 + UTS 落地** → WebUSB 传输层 r18 实现 → r24 精简版（295 行）已上线。
- **已实锤结论**：
  - Chrome 放行 PTP 0x06（受保护类仅 7 个：0x01 音频/0x03 HID/0x08 存储/0x0B 智能卡/0x0E 视频/0x10 影音/0xE0 无线，WICG PR #206）；**web-gphoto2 官方 demo 王总实测连接 5D2 成功**（型号/序列号/电池/EVF 全出）→ 网页直连可行
  - **裸传输序列成功 1ms**（open→selectConfiguration→releaseInterface 容错→claim→transferOut/In；CDP 复现多次）；**同一时刻页面 r24 openSession 超时**——差异未定位
  - **Windows camsvc（相机会话）+ StiSvc（WIA）服务抢占 PTP 接口** → Chrome claim 报「Unable to claim interface」→ **已管理员提权停止并禁用**；停用后 CDP 复现 claim: ok
  - **Chrome WebUSB 授权随相机拔插丢失**（授权绑定端口）→ 每次拔插需重新授权
  - serial 匹配 bug（5D2 空序列号致 getDevices 匹配失败误弹授权框）r23 已修
- **未决（最后一层根因）**：页面 openSession 超时 vs 裸实验同时刻成功 → **相机会话残留假设**（裸实验 close 未发 CloseSession，相机端会话残留阻塞后续 openSession；拔插清会话后对照实验被打断在"授权随拔插丢失"）。
- **测试**：单测 37/37（test-webusb-mock）+ 34/34（test-ptp）+ 8/8（test-transport-mock）。
- **关键文件**：`browser-usb-transport.js`（r24：isSupported/scan/requestConnect/_open/WebUsbTransport + diagInfo/lastError）、`connect-prototype.html`（usbVer=r24 / webusbMode 分支 / 非相机设备标记拒绝）、`camera-ptp.js`（协议栈，勿再动常量表）、docs/相机互联-USB真机联调指南.md（最新版 9c7e2f1，旧→新行为对照表）。

**失败方案（勿重走）**：Native.js 读方向（架构性无解）；CDP `Browser.grantPermissions('usb')`（Unknown permission type）；CDP userGesture 无法弹 WebUSB 系统授权框（只能人工点）；base64 传参（4KB-100KB 长度限制）。

**协议层关键事实（真机实锤）**：
- 5D2 描述符：iface0 class=6(PTP)、0x81 bulk IN、0x02 bulk OUT、0x83 interrupt IN（事件）；接口/端点选择正确
- 标准 opcode 修正过 +1 错位：0x1002 OpenSession / 0x1003 CloseSession / 0x1001 GetDeviceInfo / 0x1009；OpenSession：transid=0、sessionId 从 1、0x201E 已打开放行、0x2004 递增重试≤10；DEVICE_BUSY(0x2019) 200ms 重试≤5
- **快门正解 = 0x9128/0x9129**（0x910F 无参在 5D2 返回码 3 无法出片）：半按(1,0)→1.5s→全按(2,0)→0x9129(3) 释放 → 真实出片 6.1MB JPEG
- GetEvent(0x9116) 事件 = [size][code][变长负载] 链（**无 count**；0xC181 Handle@0x08=objectId、StorageID@0x0C=0 表示 SDRAM、size==8&&code==0 结束）
- 取图双路径：StorageID≠0 卡上=0x9104；==0 SDRAM=0x9107 分块 1MB + 0x9117 TransferComplete
- **PTP 字符串是 UTF-16LE**（"Canon"=43 00 61 00…）
- SetCaptureDest 真机返回 0x200A DevicePropNotSupported（5D2 不支持，失败忽略设计正确）
- 流式粘包 PacketStream（一次 bulk 读可能含半包/多包，盈余缓存）；超时：常规 20s/取图 100s/等照片 90s；保活 0x911D 每 10s
- **5D2 buSy 锁机 = 固件行为无软件解**（gphoto2 社区多年实证）；远程模式后保持 P/Av/Tv/M 档位；退出时 SetRemoteMode(0/1)+SetEventMode(0)+CloseSession
- 0x66 Device Reset：r19 因"超时元凶"移除，但**当时超时实为 Windows 服务抢占，移除依据失效 → 0x66 值得重新试验**（会话清理候选）

**Native.js 铁律（已六连实锤）**：web-view 里运行时 Java 对象的方法一律 `plus.android.invoke(obj,'method',...)` 显式调用；importClass/字符串类名 invoke/Class 对象 invoke 静态方法**全部不可用**（桥把类名 eval 成 JS → Unexpected identifier）；newObject(类名字符串,参数) 安全可用；静态常量硬编码；PendingIntent 用 `Activity.createPendingResult` 实例方法创建；授权结果轮询 hasPermission；web-view 里 **plus 存在**（异步注入，页面 loaded 后再查 typeof plus）。

**USB 排查方法论**：页面留 USB诊断按钮 + clickLog + bindWired 标记 + 闭环反馈（300ms 检查未达预期自动弹诊断）；**对照实验法**（页面失败 → CDP 裸脚本直接调底层 transferOut/In → 同页面对照：裸成功+页面失败=页面代码 bug；裸也失败=环境问题）；diag 脚本 `diag-usb-5d2.py`/`diag-shoot-5d2.py`（pyusb 需显式 DLL 路径，Python 3.14 find_library 失效）。

**下一步（最具体）**：
① Edge CDP 调试实例重新授权（**相机别拔插**）→ 跑协议栈对照实验 `/tmp/cdp-proto.js`（裸传输 + PtpCamera 全链路）
② 若成功 → **页面加会话清理**：连接前 try CloseSession(0x1003) + 首次 openSession 失败后重试验 0x66 Device Reset → 完整连接验证（工作台 buSy toast）
③ 王总手机 Chrome OTG 实测（claim busy 风险；Android Chrome 61+ 默认支持 WebUSB）
④ UTS 插件二期（docs/相机互联-UTS插件方案.md 蓝图：postMessage 桥 + remoteyourcam 模式 + EVF 合并；参考 estplugin-usbserial id=28207；需王总 HBuilderX 云打包）

### 6.3 手机互联（⑥，已上线待两机实测）

**定稿**（王总 08-15）：**手机控制手机**（scrcpy/AirDroid 式）——A 拍照 B 控制 B 看 A 屏幕；**首版只支持 Android 被控**（MediaProjection 录屏 + 无障碍手势注入）；控制端 = B 用网页浏览器；纯自研不接第三方 SDK。拍照瞬间照片自动在 APP 生成坐标点（被控端开我们 APP 相机页 → 现有链路自动落点，零新增）。

**屏控实现（2026-08-20）**：安卓 UTS 插件 `src/uni_modules/uts-screencontrol`（MediaProjection 录屏 ~5fps → JPEG base64 回调 + AccessibilityService dispatchGesture：tap/swipe/longpress/back/home）+ connect.vue evalJS 桥（帧注入）+ connect-prototype.html A 端帧源切换（`__plScreenFrame`/`__plScreenStatus`）与 B 端触摸层（`screen_on/off` 控制显隐，`touch` 消息归一化坐标）。WS 消息 `frame/screen_on/screen_off/touch` 后端原样透传**零改动**。真机验证：A 开 App 联机页 → 屏幕共享（授权+无障碍）→ B 输码 → 看 A 屏并点/滑。

**iOS 定稿修正（2026-08-20）**：Facetime 远程控制权**真实存在**（iOS 18+，A/B 互存联系人，Facetime 通话中可请求/提供控制权）——但为 **Apple 自家 Facetime App 专属**，第三方无公开 API（Splashtop 官方：iOS 只能 view-only）。结论：我们 App 内**无法复刻**控屏，第 2 期做「一键引导」用 Facetime 现成控屏（App 内入口 + 引导页）。

**已上线**：63a2599（后端 phonelink 配对 + WS 通道 + UI 并入）+ f416d56（去模拟化：/tether/detect 真实 SSDP 扫描 239.255.255.250:1900 + A 端 getUserMedia 真实帧推流 320 JPEG ~6fps + B 按快门 → A 真实截帧 + GPS + 缩略图落 pendingPhotos + photo_ready 回传）。
- 后端：phonelink-pair.model.js（6 位码、10min TTL、状态机 pending/joined/closed）+ controller（POST /pairs、/pairs/join 原子抢占、/pairs/:code/close）+ WS（/api/v1/phonelink/ws?code=&role=host|client，30s 心跳）；api.md §8.10
- 测试：smoke-phonelink 22/22 + e2e-phonelink-web 5/5 + smoke-tether 6/6；e2e 6/6
- **诚实边界**：headless 无法驱动真实摄像头（Chromium 虚拟时间不驱动媒体线程，getUserMedia 永远挂起）——媒体截帧链路留真机实测，页面留 `autoTest=1` 钩子（真机地址栏加参数自测，title 上报）
- 前端联调参数：`?mode=phone&autoHost=1&apiBase=http://localhost:PORT/api/v1&token=xxx`

**王总两机真机实测步骤**（待办）：A：联机页→手机互联→开始连接手机→开启相机（授权）→显示码；B：另一台设备输码→看真实画面→按快门→A 照片落待归类管线（回首页归类出坐标点）；相机互联：点检测→真实空态引导。

### 6.4 地图与本地化（已踩坑结论，直接复用）

1. **瓦片错乱根因 = 自定义 Retina 换算**——不要自造 Leaflet 瓦片换算；天地图数据**删除 detectRetina**（官方默认路径直连 z 级瓦片）：detectRetina 在 dpr>1 会 zoomOffset+1、maxZoom 钳到 maxZoom-1、tileSize 减半 → 缩到最大级白屏；叠加天地图 z18 为天花板（z19 返回空白占位 PNG → 灰屏）
2. **server.py 已加 no-store/no-cache/must-revalidate**（防手机启发式缓存旧版）+ HTTPS 8081 自签（GPS 必须 HTTPS 才可用；手机访问需接受自签证书）
3. **全站屏宽等比**：`html { font-size: 0.2667vw }` 纯 vw 乘法 + px→rem；**禁止 calc(100vw/375)**（Chrome<109 不支持 → 全站 16 倍错乱）
4. 外部依赖已本地化：Leaflet 1.9.4 → lib/leaflet/，Dexie → lib/dexie/（不依赖 unpkg CDN）
5. 定位精度：enableHighAccuracy:true + maximumAge:0 + 首轮 accuracy>20m 静默二次确认（误差收敛 10m 内，最多 +5s）
6. 中文字体子集化：pyftsubset `--text=「字」`（4MB → 5KB）；@font-face 子集 src 优先 + 全量 woff2 兜底 + font-weight:400 700 声明 + font-display:swap；fontTools 读 woff2 需 pip install brotli；PIL 无法加载 woff2（用 fontTools TTFont 验证）
7. splash 动画：filter:blur 在手机 WebView 有隐患 → 已移除，改 text-shadow 拖影 + 文字基础 opacity 1（动画失败仍可见）

### 6.5 品牌字体（定稿 fb22888，全可商用）

- **工一堂（splash + 登录页品牌）**：玄宗体 XuanZongTi（SIL OFL 1.1，kaonashi-tyc/Zi-XuanZongTi）——行书辨识度高，子集 5.6KB + 全量 woff2 兜底（fonts/XuanZongTi-*）
- **"欢迎您回来"已移除**（元素/样式/动画/字体全清理，splash 只剩工一堂+太阳）
- 否决记录：志莽行书（堂字草化认不出）、漓雨手书（已删）、华文行楷（授权不明）、演示夏行楷（下载受阻+授权矛盾）
- 对比图留档 docs/font-compare/（v3_*.png）

---

## 7. 部署链路（最关键流程，改代码必看）

**链路**：本地代码 → `git push github master` → 阿里云 ACR 代码源自动构建（1-2 分钟，实际 5-15 分钟）→ 王总在 Sealos 网页「应用管理」点**变更**更新镜像 → 线上生效。

**双 remote 铁律**：
- `github` = `ssh://git@ssh.github.com:443/WPX26/001.git`（**ACR 构建源，必须推这里**）
- `origin` = Gitee（wang-pengxiang051216/memomap，国内备份；**推它不触发构建**）
- 正确命令：`git push github master`（git push 默认推 origin=Gitee！）

**变更时机坑（两次教训）**：推送后立即点变更会拿到旧镜像（ACR 构建未完成）。**正确时序：推送 → 等 ACR 构建成功（构建记录页滚到底）→ 王总点变更 → 验证**。线上验证快捷路径：curl 拉线上页面 grep 新 commit 特征（函数名/类名/usbVer/md5）+ last-modified 时间戳。

**ACR 关键信息**：
- 实例：华北1（青岛）cn-qingdao 个人版；域名 `crpi-02avdj56c5eztlqi.cn-qingdao.personal.cr.aliyuncs.com`（带 `.personal.cr.`！）
- 仓库：wpx001/static（前端，Dockerfile.static）+ wpx001/backend（后端），tag 均 latest；登录用户名 nick4355155471（密码值在 ACR 控制台"访问凭证"页，不入记忆）
- 代码源支持 GitHub/Codeup（不支持 Gitee）
- docker login 403 不一定是密码错——先 curl 拿 token 验证；匿名 ACR token 无 pull 权限（私有仓库）

**Sealos 应用**：
- 前端 memomap-frontend → `https://dsofatjxxjyf.sealoshzh.site`（**memomap 拼写为准**，曾误记 memomart）
- 后端 memomap-backend → `https://jcxmjyxvxmuv.sealoshzh.site`（✅ 有效；**jcxmjyxvmuv 是废弃域名**，曾误记导致排查 503 走错方向）
- 命名空间 ns-hv4kuu0s；内网互访 http://<app>.<ns>.svc:80/3000
- 更新镜像 = **王总手动操作**（本机无 sealos CLI/kubectl/Docker）
- 云站证书 Let's Encrypt 通配符 *.sealoshzh.site 正规有效（2026-09-17 到期）；王总手机弹"证书有问题"= 访问了局域网 IP 自签证书，非云站问题

**Dockerfile.static 三处清单（教训重演两次）**：新增资源必须同步 ① 页面引用目录 ② Dockerfile.static COPY ③ git 跟踪（.gitignore 放行——online_check.html 是故意忽略的旧副本页，误加 COPY 必炸构建 `error: not found`）。**壳层 uni-preset-vue-vite/ 不进 ACR 镜像**：壳层修改推送会触发构建但产物不变无需变更；壳层生效靠王总 HBuilderX 云打包 APK（两条发布通道：网页=ACR 变更，壳层=重新打包）。

**断点怀疑清单（8-14 曾断一次，8-15 起连续 4 次成功，原因未明）**：① GitHub 自动禁用连续失败的 webhook ② ACR 代码源 GitHub OAuth 授权过期 ③ 构建失败。排查需王总切「容器镜像服务控制台」看构建记录+代码源配置。若再断按此查。

---

## 8. 网络环境（本机 Windows，Git Bash）

- **GitHub HTTPS 直连不通**（443 超时/400）；**SSH 推送可直连**（ssh.github.com:443，config 已配）
- 克隆/小文件：`https://gh-proxy.com/https://github.com/<owner>/<repo>.git`；**大文件（>10MB，字体等）用 `ghproxy.net` 前缀**（~212KB/s 首选；gh-proxy.com 限速 ~14KB/s）
- 仓库内文件：`ghproxy.net/https://raw.githubusercontent.com/<user>/<repo>/master/<path>`；release asset：`ghproxy.net/https://github.com/<user>/<repo>/releases/download/<tag>/<file>`（`-C -` 续传可靠；Range 并行分块弃用）
- npm 可用（华为云镜像 mirrors.huaweicloud.com，个别包 404）；`@fontsource/*` 开源字体包可直连（OFL 可靠渠道）
- context7.com 可直连；**WebFetch 被白名单拦截**（github.com/raw.githubusercontent.com/context7.com 都报 unsafe）——需要内容用 git clone/curl，不要 WebFetch
- bash heredoc 中文在 Windows Python 会乱码（终端显示层）；中文注入用文件方式传参或 \u 转义

---

## 9. 技术踩坑教训速查（跨会话复用）

**HTML 开发**：
1. 正则/脚本删 HTML 块后**必须做标签平衡校验**（非贪婪 `.*?</div>` 误吞闭合 → DOM 错位 → 页面全黑，曾排查 2 小时）；用 Edit 精确字符串比 python 正则安全
2. 函数签名传参错误（openPhotoDetail 收 id，调用点传对象 → 点了没反应）；改调用点先看签名，grep 所有调用点
3. 类名改动后 grep 旧类名残留（CSS/JS/HTML 三处）
4. python 批量改文件后 git diff 验证写入（print 在断言前会假成功）
5. vue 文件是 **CRLF**（HTML 是 LF），脚本先 replace(/\r\n/g,'\n')；改 .vue 后用 @vue/compiler-sfc 校验（parse+compileScript，与 HBuilderX 同编译器）
6. 中文注入 python -c 会被编码损坏 → 文件方式/纯 ASCII+\u

**测试环境**：
1. Edge headless 用 file:// 有坑（中文/空格/括号路径渲染怪异）→ 复制到 `C:/test-memomap/`（无空格）测；测试副本 hook 要生效须**在测试目录另起静态服务**（如 python -m http.server 8090）
2. --window-size 对 headless=new 可能无效（实际 800px）；截图用 800px + PIL 裁剪；DOM dump 与截图可能不一致（状态用 dump-dom 的 title，视觉用截图）
3. **headless 无法驱动真实媒体设备**（getUserMedia 虚拟时间永远挂起、fake-device 不产帧）——媒体链路留真机 + autoTest 钩子，e2e 如实标注"真机覆盖"
4. 截图看王总屏幕：禁止主动截屏；看王总发的图走 **JSONL 提取**（`~/.claude/projects/<项目>/*.jsonl` 正则 `"data":"([A-Za-z0-9+\/=]{100,})"` 取最后一个 → 前缀 iVBOR=PNG、/9j/=JPEG → 写 %TEMP% → zhipu-vision analyze-cli.mjs --provider kimi 分析）；%TEMP%/*.tmp 缓存法备用（核对尺寸与消息一致，不一致则裁剪区域分析）；Read 工具读本地图片会乱码
5. **mix-blend-mode:color 染色验证法**：headless dump-dom 读 getComputedStyle 的 ::after + PIL 色相统计；染色层 z-index 须低于内容层、高于 ::before 蒙版

**CDP 自动化（USB 排查主力）**：
- 启动：`msedge.exe --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<独立profile> --no-first-run <url>`（三参数缺一不可；`*` 在 bash 要加引号；独立 profile 不干扰王总日常浏览器）
- 驱动：curl `http://127.0.0.1:9222/json` 拿 webSocketDebuggerUrl → Node v21+ 全局 WebSocket 发 `Runtime.evaluate {expression, awaitPromise:true, returnByValue:true, userGesture:true}`
- 页面导航会断连接 → 分脚本跑；调试实例强杀会丢授权（用正常方式关闭）
- **对照实验法**：页面失败 → 裸脚本直调底层 → 同页面对照（裸成功=页面 bug；裸失败=环境问题）

**web-view 环境**：
1. App 内 web-view 加载的 H5 网页**没有 window.uni**（官方不注入）——判定 App 环境用 `typeof plus !== 'undefined'`（plus 异步注入，loaded 后查）
2. web-view 网页**可以运行 plus API**（官方：App-vue 的 web-view 可以，nvue 不行）；plus.android 的坑见 §6.2 Native.js 铁律
3. "点按钮无反应"排查套路：全局 capture click 日志 + 绑定标记（__boundByMain）+ 独立兜底块 + 300ms 闭环反馈自动弹诊断
4. transform 创建包含块 → 弹层嵌在 translateY(100%) 的容器里会渲染在屏外（63988b9 教训：弹层挂 phone-screen 直属层）

---

## 10. 凭据位置（只存指针，不存值——记忆纪律）

| 凭据 | 位置（值不入记忆） |
|---|---|
| 管理页密码 ADMIN_PASSWORD | Sealos 后端应用**环境变量**（忘记时到那看） |
| ACR 登录密码 | 阿里云 ACR 控制台「访问凭证」页（可设置/重置固定密码） |
| Kimi 视觉 API Key（KIMI_API_KEY） | `C:/Users/lenovo/zhipu-vision-mcp/.env` |
| 王总微信收款码 | `server/uploads/pay-qrcode.png`（部署到后端持久卷 /app/uploads/，nginx /uploads/ 反代） |
| 本地后端 .env | ⚠️ 指向**线上 MongoDB**（dbconn.sealoshzh.site:42605）——本地起 server.js 会连生产库，调试谨慎 |

**视觉"眼睛"调用**：`node --env-file=.env scripts/analyze-cli.mjs --provider kimi <图片> [prompt]`（默认 kimi；GLM-4V 备用 --provider zhipu）；注意 kimi-k2.6 是推理模型，max_tokens 需 ≥8000 否则 content 为空。

---

## 11. 已装技能与工具

**用户级 skills**（~/.claude/skills/）：uniapp-frontend-skills（uni-app Vue3 全指南）、wechat-integration（微信生态 Node 版：小程序登录/订阅消息/小程序码/手机号解密）、frontend-design（视觉设计指南）、zhipu-vision（图片识别/截屏）、backend-development（后端综合 11 references）、databases（MongoDB/PostgreSQL）、devops（Docker/K8s/Cloudflare/CI）、nodejs-backend（Node 架构规范，paths 匹配 server/**、api/**）、database-schema（schema 感知）、html-to-code（9 HTML 原型 → uni-app，内置"不改 UI 不减功能"验收清单；**项目级约束优先于本技能**）。
**命令**：code-review（PR 评审 5 路并行）。**MCP**：context7（实时拉取官方 API 文档）。
**其余工具**：pyftsubset（fontTools）、@vue/compiler-sfc、Edge headless、zhipu-vision-mcp scripts。

---

## 12. 下一步工作清单（按优先级）

1. **（当前主线）USB 最后一层根因**：
   - ① Edge CDP 重新授权（相机别拔插）→ 跑 `/tmp/cdp-proto.js` 协议栈对照实验
   - ② 若成功 → 页面加会话清理（连接前 try CloseSession 0x1003 + 首次失败后 0x66 重试验）→ 完整连接验证（工作台 buSy toast）
   - ③ 王总手机 Chrome OTG 实测
   - ④ UTS 插件二期（与 EVF 合并）
2. **王总两机真机实测 ⑥ 手机互联**（步骤见 §6.3）
3. **② 复验**（作品卡片点开/动画/插画/染色）——同批做
4. 复验通过 → **③ 灵感/探索适配**（memo-home inspireData/exploreData 改接后端 /inspire/*、/explore/*，后端已就绪；1-1.5 天，建议独立会话）
5. 后续：相机 USB 二期（EVF 原生插件）；⑥ 原生插件二期（2-3 周）；④ 摄影师认证申请接口；⑤ 私信 WS + OSS 直传；② 头像上传

---

## 13. 风险与已知限制

1. **ACR 自动构建稳定性**：8-14 曾断一次（原因未明），8-15 起连续 4 次成功；再断按 §7 断点清单排查
2. **本地 .env 连线上 Mongo**：本地起 server.js 会直连生产库
3. **头像取色限制**：图片 URL 头像取不了色 → 染色回退默认橙
4. **相机授权随拔插丢失**：用户流程需重新授权（已知边界，二期可优化）
5. **Android Chrome OTG 未测**：claim busy 风险（新 Chrome 有 detach 缓解）
6. 他人主页作品显示色块卡片 = 该坐标 thumbnails 为空（后端每坐标取前 4 张缩略图）
7. 本机无 HBuilderX/Android Studio/adb——原生插件打包走王总 HBuilderX 云打包；本机无 docker daemon——构建必须走 ACR 云端
8. ② 王总最终验收未做、⑥ 真机实测未做（都是"已上线待王总手机复验"状态）

---

## 14. 相关文档索引

- `docs/相机互联-USB真机联调指南.md`（USB 排查必读，9c7e2f1 全面重写版）
- `docs/相机互联-UTS插件方案.md`（二期蓝图）
- `docs/Sealos部署指南.md`（⚠️ 镜像地址写的是旧版 registry.cn-hangzhou…memomap-frontend:1.0，**以实况 wpx001/static:latest 为准**）
- `api.md`（接口蓝图，手机互联已加 §8.10）
- `development-doc.md`（项目开发文档）
- `docs/阶段②_*.md`（② 页面设计/管线/UTS 设计）、`docs/对话记录_*.md`、`docs/地图功能开发精华存档.md`、`docs/部署进度存档.md`

---

*交接文档完。接手后建议：① 先读 §0 + §7 部署纪律 ② 跑一遍 `script/` 三个单测确认环境 ③ 按 §12 开工。*
