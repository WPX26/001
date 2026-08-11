# ftp-receiver —— 相机 FTP 直传手机热点接收服务（UTS 插件）

设计文档：《阶段②_UTS插件设计文档.md》v1.0（冻结）。Android 实现，iOS 占位（D3 延期）。

## 功能

- FTP 服务端（最小命令集：USER/PASS、PASV、PORT、STOR、TYPE、SYST、CWD、PWD、MKD、NOOP、QUIT），**PASV + PORT 双模式**；
- dataSync 前台服务（常驻通知「📷 相机连接中 · 照片实时接收中」，START_STICKY 崩溃重建）；
- 文件流式写盘（64KB 缓冲）至**应用私有目录**（D5：不做 DCIM 镜像，无需存储权限）；
- 命名冲突自动追加时间戳、`.part` 临时文件原子 rename、路径白名单防穿越；
- 账号随机生成（D6，引导页展示）；单会话串行（佳能单相机场景）。

明确不做（防范围蔓延）：下载/浏览/删除命令、多相机并发、断点续传、FTPS、匿名登录、DCIM 镜像。

## API 速查

```ts
import { startServer, stopServer, onEvent } from '@/uni_modules/ftp-receiver/utssdk/interface/index.uts'

// 启动：resolve 时保证端口已绑定、监听已开始、通知已挂起
const { ip, port } = await startServer({ port: 21, dir: 'ftp/photos', user: 'cam_1234', pass: 'abc12345' })

// 订阅（页面 onUnmounted 必须退订）
const unsubscribe = onEvent((ev) => {
  // ev: {type:'connected', client} | {type:'transferring', name, size}
  //   | {type:'fileReceived', meta:{path,name,size}} | {type:'disconnected', client}
  //   | {type:'error', code, message}
})

await stopServer()   // 服务未运行时 reject(1002)
```

错误码：1000 端口占用 / 1001 前台服务被拒 / 1002 未运行 / 1003 参数非法 / 1004 重复启动 /
1005 存储目录不可用 / 1006 其他启动失败（含无热点 IP 警告）/ 1007 FGS 超时 / 1008 数据通道失败。
1000–1006（启动期）经 `startServer` reject；1005(运行期)/1007/1008 经 `error` 事件上报。

## 与 H5 原型的对接点（业务层，本插件不含业务代码）

`useFtpServer()` 组合式封装（阶段②c 实现，`src/composables/useFtpServer.uts`）只负责服务生命周期与
文件到达通知；照片是否为新品、GPS 提取、归类、入库全部由业务层处理。对接管线（设计文档 6.2）：

1. `fileReceived.meta.path` → EXIF 解析模块读取拍摄时间 `DateTimeOriginal` 与 GPS
   （复用 H5 原型：GPS 解析超时 8s 则用地图中心 ±0.0015 随机偏移兜底）；
2. GPS 坐标 → 500m 距离归类（复用原型 pendingPhotos 归类算法）；
3. 归类结果 → 写入本地库（照片表）。

**对齐保证**：`fileReceived` 事件结构 `{path, size, name}` 与 H5 原型 `wsWritePending(thumb, exifDate, lng, lat, gpsSource)`
的调用点一一对应——编码阶段替换 `wsWritePending` 的"文件来源"一端即可，归类管线不改动。
页面生命周期：`onMounted` 注册 `onFileReceived` 管线；`onUnmounted` 自动退订。

**注意（L7）**：接收文件为相机原始格式（含 CR3 佳能 RAW），需独立解析器，H5 原型 JPEG EXIF 解析不适用。

## 打包与权限（D1 双路径）

- **在线打包（主路径）**：权限与前台服务声明随 `manifest.json` 自动合并；
- **离线打包（兜底）**：在离线工程 `AndroidManifest.xml` 手工补同样的 permissions 与 service 节点
  （`android:foregroundServiceType="dataSync"` 必须显式声明，否则 Android 14+ 启动前台服务报错）：

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

- **包名**：插件 id `ftp-receiver` 与目录 `app-android` 的连字符按 DCloud 编译规则统一转下划线，
  最终包名 `uni_modules.ftp_receiver.utssdk.app_android`（M8；`index.uts` import / `.kt` package / manifest
  android:name 三统一）。此归一需 HBuilderX 编译验证（见下）。

## iOS

`utssdk/app-ios/index.uts` 为占位实现（错误码 9001）。激活条件见设计文档 9.2；
激活时 interface 层状态机原样复用，仅重写副作用执行器，API 签名零改动。

## 示例

见 `example/`（示例页接入步骤见 example/README.md）。
