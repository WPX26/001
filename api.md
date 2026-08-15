# 地图相册平台 — 后端接口清单 v2.0

**业务场景**：基于地图的图片社交 / 足迹记录平台（灵感模式、探索模式、联机拍摄、照片上传、评论互动、坐标聚合、会员订阅、摄影师认证）
**接口前缀**：`/api/v1`
**认证方式**：Header `Authorization: Bearer <token>`（除登录/注册外均需携带）

---

## 目录

1. [用户认证](#1-用户认证)
2. [用户资料与社交](#2-用户资料与社交)
3. [地图与坐标](#3-地图与坐标)
4. [灵感模式（他人公开内容）](#4-灵感模式)
5. [探索模式（按作者排名）](#5-探索模式)
6. [照片详情与互动](#6-照片详情与互动)
7. [内容发布与上传](#7-内容发布与上传)
8. [联机拍摄（Tethered Shooting）](#8-联机拍摄)
9. [即时通讯（私信聊天）](#9-即时通讯)
10. [会员与订阅](#10-会员与订阅)
11. [摄影师认证](#11-摄影师认证)
12. [邀请码](#12-邀请码)
13. [相册管理](#13-相册管理)
14. [通用接口](#14-通用接口)

---

## 1. 用户认证

### 1.1 发送短信验证码
```
POST /auth/send-code
```
**功能**：注册/登录前发送手机验证码

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| phone | String | 是 | 手机号（11 位） |
| scene | String | 是 | `login` 登录 / `register` 注册 |

**返回**：
```json
{ "code": 0, "message": "验证码已发送", "data": { "expireSeconds": 300 } }
```

### 1.2 手机号登录
```
POST /auth/login
```
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| phone | String | 是 | 手机号 |
| code | String | 是 | 短信验证码 |

**返回**：
```json
{
  "code": 0,
  "data": {
    "token": "eyJ...",
    "expiresIn": 86400,
    "user": { "id": "u_001", "nickname": "旅行者", "avatar": "https://...", "isNewUser": false }
  }
}
```

### 1.3 手机号注册
```
POST /auth/register
```
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| phone | String | 是 | 手机号 |
| code | String | 是 | 短信验证码 |
| nickname | String | 是 | 昵称（2-20 字符） |
| password | String | 否 | 密码（6-20 字符，可选则后续可用密码登录） |

### 1.4 刷新 Token
```
POST /auth/refresh
```
| 参数 | 类型 | 说明 |
|------|------|------|
| refreshToken | String | 刷新令牌 |

### 1.5 退出登录
```
POST /auth/logout
```

---

## 2. 用户资料与社交

### 2.1 获取我的资料
```
GET /users/me
```
**返回**：完整用户信息，包括昵称、头像、简介、手机号（脱敏）、会员状态、摄影师认证状态、工作/生活模式、统计数据。

### 2.2 更新我的资料
```
PUT /users/me
```
| 参数 | 类型 | 说明 |
|------|------|------|
| nickname | String | 昵称 |
| avatar | File/URL | 头像 |
| bio | String | 个人简介 |

### 2.3 获取他人主页
```
GET /users/{userId}/profile
```
**返回**：
```json
{
  "data": {
    "id": "u_002",
    "nickname": "@摄影师小林",
    "avatar": "https://...",
    "bio": "探索城市角落的视觉记录者",
    "isPhotographer": true,
    "isFollowed": false,
    "stats": {
      "coordCount": 5,
      "photoCount": 12,
      "likeCount": 342,
      "followerCount": 128,
      "followingCount": 56
    }
  }
}
```

### 2.4 获取他人发布的作品列表
```
GET /users/{userId}/coords
```
**分页参数**：`page`, `pageSize`（默认 20）
**返回**：该用户创建的所有公开坐标卡片，包含坐标名、照片数、获赞数、前 4 张照片缩略图。

### 2.5 关注用户
```
POST /users/{userId}/follow
```

### 2.6 取消关注
```
DELETE /users/{userId}/follow
```

### 2.7 获取关注列表
```
GET /users/{userId}/following
```
**参数**：`page`, `pageSize`

### 2.8 获取粉丝列表
```
GET /users/{userId}/followers
```
**参数**：`page`, `pageSize`

### 2.9 切换生活/工作模式
```
PUT /users/me/mode
```
| 参数 | 类型 | 说明 |
|------|------|------|
| mode | String | `life` 生活 / `work` 工作 |

> **业务规则**：需要摄影师认证才能切换为工作模式。工作模式上传的照片进入探索模式数据池，生活模式上传的照片进入灵感模式数据池。

### 2.10 获取我收藏的坐标
```
GET /users/me/collected-coords
```

---

## 3. 地图与坐标

### 3.1 获取视窗内坐标点（核心接口）
```
GET /map/markers
```
**功能**：根据地图经纬度范围和缩放层级，返回后端聚合后的坐标点。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| minLng | Float | 是 | 视窗左边界经度 |
| maxLng | Float | 是 | 视窗右边界经度 |
| minLat | Float | 是 | 视窗下边界纬度 |
| maxLat | Float | 是 | 视窗上边界纬度 |
| zoom | Int | 是 | 缩放层级（1-18） |
| mode | String | 否 | `normal` 默认 / `inspire` 灵感 / `explore` 探索 |
| level | Int | 否 | 细化程度 1/2/3（与 zoom 联动：≤14→1, 15→2, ≥16→3） |

**返回**：
```json
{
  "data": [
    {
      "id": "cluster_001",
      "title": "五四广场及周边",
      "lng": 120.3826,
      "lat": 36.0671,
      "count": 5,
      "color": "#2196F3",
      "isClustered": true,
      "subCoordIds": ["c_001", "c_002"],
      "thumbnailUrls": ["https://...", "https://..."]
    },
    {
      "id": "c_003",
      "title": "万象城",
      "lng": 120.1683,
      "lat": 30.2934,
      "count": 1,
      "color": "#F0A040",
      "isClustered": false,
      "latestPhotoTime": "2026-08-04T15:30:00Z"
    }
  ]
}
```

### 3.2 搜索地点
```
GET /map/search
```
| 参数 | 类型 | 说明 |
|------|------|------|
| keyword | String | 搜索关键词 |
| lng | Float | 当前中心经度（用于就近排序） |
| lat | Float | 当前中心纬度 |

**返回**：匹配的地标/坐标列表，包含名称、经纬度、类型（地标/用户坐标/灵感坐标）。

### 3.3 获取单个坐标详情与照片列表
```
GET /coords/{coordId}/detail
```
**参数**：`page`, `pageSize`
**返回**：
```json
{
  "data": {
    "coordInfo": {
      "id": "c_001",
      "title": "五四广场",
      "lng": 120.3826,
      "lat": 36.0671,
      "date": "2026-08-04",
      "authorId": "u_001",
      "authorName": "旅行者",
      "isCollected": false
    },
    "photos": [
      {
        "id": "p_001",
        "imageUrl": "https://...",
        "thumbnailUrl": "https://...",
        "authorId": "u_002",
        "authorName": "@摄影师小林",
        "authorAvatar": "https://...",
        "likes": 128,
        "tips": 6,
        "isLiked": false,
        "isTipped": false,
        "isCollected": false,
        "uploadTime": "2026-08-04T15:30:00Z",
        "filterApplied": "日系人像",
        "exif": { "iso": 100, "aperture": "2.8", "shutter": "1/200", "wb": "5600K" }
      }
    ],
    "totalCount": 12,
    "page": 1,
    "pageSize": 20
  }
}
```

### 3.4 更新坐标标题
```
PUT /coords/{coordId}
```
**功能**：编辑坐标名称。仅坐标作者本人可操作；软删除（回收站中）的坐标不可修改。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | String | 是 | 新地点名称（1-50 字符，自动 trim） |

**返回**（对齐 POST /coords 结构）：
```json
{
  "code": 0,
  "data": {
    "id": "c_001",
    "title": "五四广场（更新后）",
    "lng": 120.3826,
    "lat": 36.0671,
    "isPublic": true,
    "mode": "life",
    "photoCount": 12
  },
  "message": "坐标标题更新成功"
}
```

**错误**：
- `400/1001`：title 缺失或长度不在 1-50 字符
- `403/1003`：非坐标作者操作
- `404/1004`：坐标不存在或已删除（软删）

---

## 4. 灵感模式

### 4.1 获取灵感坐标列表
```
GET /inspire/coords
```
**功能**：获取他人公开的坐标点（红色标记），按"已关注作者优先 → 热度 → 时间"排序。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| lng | Float | 是 | 中心经度 |
| lat | Float | 是 | 中心纬度 |
| radius | Int | 否 | 搜索半径（米），默认 5000 |
| sortBy | String | 否 | `followed` 关注优先（默认） / `hot` 热度 / `time` 最新 |
| page | Int | 否 | 页码 |
| pageSize | Int | 否 | 每页条数（默认 20） |

**返回**：坐标点列表，每个坐标包含照片列表（按时间分组，每组内按关注优先+热度排序）。

### 4.2 收藏坐标点
```
POST /inspire/collect
```
| 参数 | 类型 | 说明 |
|------|------|------|
| sourceCoordIds | Array\<String\> | 被收藏的坐标点 ID 列表（支持多选合并） |

### 4.3 取消收藏
```
DELETE /inspire/collect/{coordId}
```

---

## 5. 探索模式

### 5.1 获取探索坐标及作者分组
```
GET /explore/coords
```
**功能**：获取工作模式下摄影师发布的公开作品（紫蓝色标记），按"已关注作者优先 → 作品数 → 热度"排序。

| 参数 | 类型 | 说明 |
|------|------|------|
| lng | Float | 中心经度 |
| lat | Float | 中心纬度 |
| radius | Int | 搜索半径（米） |
| page | Int | 页码 |
| pageSize | Int | 每页条数 |

**返回**：
```json
{
  "data": {
    "coords": [ { "...": "坐标信息" } ],
    "authorGroups": [
      {
        "authorId": "u_002",
        "authorName": "@摄影师小林",
        "authorAvatar": "https://...",
        "isFollowed": true,
        "photoCount": 8,
        "totalLikes": 234,
        "photos": [ { "..." : "照片列表" } ]
      }
    ]
  }
}
```

### 5.2 获取探索排行榜
```
GET /explore/ranking
```
**功能**：返回摄影师排行榜（按热度/作品数/获赞数排名，已关注者优先展示）。

| 参数 | 类型 | 说明 |
|------|------|------|
| type | String | `weekly` 周榜 / `monthly` 月榜 / `all` 总榜 |
| page | Int | 页码 |
| pageSize | Int | 每页条数（默认 20） |

**返回**：
```json
{
  "data": {
    "rankings": [
      {
        "rank": 1,
        "authorId": "u_005",
        "authorName": "@婚礼摄影师阿杰",
        "authorAvatar": "https://...",
        "photoCount": 48,
        "totalLikes": 3856,
        "isFollowed": false
      }
    ],
    "myRank": null
  }
}
```

---

## 6. 照片详情与互动

### 6.1 获取照片详情
```
GET /photos/{photoId}
```
**返回**：照片完整信息，包含原图 URL、EXIF、作者信息、互动数据。

### 6.2 点赞
```
POST /photos/{photoId}/like
```

### 6.3 取消点赞
```
DELETE /photos/{photoId}/like
```

### 6.4 打赏
```
POST /photos/{photoId}/tip
```
| 参数 | 类型 | 说明 |
|------|------|------|
| amount | Int | 打赏金额（平台代币，如 1-100） |

### 6.5 收藏照片
```
POST /photos/{photoId}/collect
```

### 6.6 取消收藏照片
```
DELETE /photos/{photoId}/collect
```

### 6.7 获取评论列表
```
GET /photos/{photoId}/comments
```
**分页参数**：`page`, `pageSize`

### 6.8 发表评论
```
POST /photos/{photoId}/comments
```
| 参数 | 类型 | 说明 |
|------|------|------|
| content | String | 评论内容（1-500 字符） |
| replyTo | String | 回复目标用户 ID（可选） |

### 6.9 删除评论
```
DELETE /photos/{photoId}/comments/{commentId}
```

---

## 7. 内容发布与上传

### 7.1 获取上传凭证
```
POST /upload/token
```
**功能**：获取 OSS 直传凭证（推荐使用阿里云 OSS / 腾讯云 COS STS 临时令牌）。

| 参数 | 类型 | 说明 |
|------|------|------|
| fileCount | Int | 上传文件数量 |
| scene | String | `coord` 坐标照片 / `avatar` 头像 / `chat` 聊天图片 |

**返回**：
```json
{
  "data": {
    "ossToken": { "accessKeyId": "...", "accessKeySecret": "...", "securityToken": "...", "expiration": "...", "region": "oss-cn-hangzhou", "bucket": "my-bucket", "prefix": "photos/2026/08/" },
    "uploadUrls": ["https://...", "https://..."]
  }
}
```

### 7.2 创建坐标并关联照片
```
POST /coords
```
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | String | 是 | 地点名称 |
| lng | Float | 是 | 经度 |
| lat | Float | 是 | 纬度 |
| photoIds | Array\<String\> | 是 | 已上传的照片 ID 列表（上传后回调返回） |
| isPublic | Boolean | 否 | 是否公开到灵感/探索模式（默认 true） |
| photoTimes | Object | 否 | `{ "photoId": "2026-08-04T15:30" }` 每张照片的拍摄时间 |
| mode | String | 否 | `life` 生活（进灵感池）/ `work` 工作（进探索池） |

### 7.3 上传完成回调
```
POST /upload/callback
```
**功能**：前端 OSS 直传完成后，通知后端文件就绪。

| 参数 | 类型 | 说明 |
|------|------|------|
| files | Array | `[{ "key": "oss路径", "hash": "文件hash", "size": 12345 }]` |

**返回**：`{ "data": { "photoIds": ["p_101", "p_102"] } }`

### 7.4 删除坐标
```
DELETE /coords/{coordId}
```

### 7.5 恢复已删除的坐标
```
POST /coords/{coordId}/restore
```

### 7.6 删除照片
```
DELETE /photos/{photoId}
```

### 7.7 恢复已删除的照片
```
POST /photos/{photoId}/restore
```

### 7.8 修改坐标标题
```
PUT /coords/{coordId}
```
**功能**：编辑坐标名称，仅作者本人可操作。参数与返回结构见 [3.4 更新坐标标题](#34-更新坐标标题)。

---

## 8. 联机拍摄

## 8. 联机拍摄（Tethered Shooting）

> **参考产品**：像素蛋糕（PixCake）— 支持 WiFi / USB 相机直连、实时取景、远程快门控制、实时色彩预设应用、即拍即传即修。

### 8.1 检测可用相机
```
POST /tether/detect
```
**功能**：扫描当前局域网内可连接的相机（通过 PTP/MTP 或厂商 SDK）。

| 参数 | 类型 | 说明 |
|------|------|------|
| type | String | `wired` 有线 / `wireless` 无线 |

**返回**：
```json
{
  "data": {
    "cameras": [
      {
        "id": "cam_001",
        "model": "Sony A7M4",
        "serialNumber": "SN123456",
        "connectionType": "wireless",
        "ip": "192.168.1.100",
        "batteryLevel": 98,
        "status": "available"
      }
    ]
  }
}
```

### 8.2 连接相机
```
POST /tether/connect
```
| 参数 | 类型 | 说明 |
|------|------|------|
| cameraId | String | 相机 ID |
| connectionType | String | `wired` / `wireless` |

**返回**：`{ "data": { "sessionId": "sess_001", "status": "connected" } }`

> **注意**：实际相机通信由后端通过 PTP/IP、Sony Camera Remote SDK、Canon EDSDK、Nikon SDK 等实现。前端仅通过 REST/WebSocket 与后端中继通信。

### 8.3 断开相机
```
POST /tether/disconnect
```

### 8.4 获取实时取景流
```
GET /tether/session/{sessionId}/liveview
```
**返回**：MJPEG 流或 WebSocket 推送的实时画面帧（Base64 / Binary）。
**WebSocket 端点**：`ws://<host>/api/v1/tether/session/{sessionId}/liveview`

### 8.5 读取相机参数
```
GET /tether/session/{sessionId}/settings
```
**返回**：
```json
{
  "data": {
    "iso": 100,
    "aperture": "2.8",
    "shutterSpeed": "1/200",
    "whiteBalance": "5600K",
    "exposureCompensation": "0.0",
    "batteryLevel": 98,
    "storageRemaining": 12345
  }
}
```

### 8.6 设置相机参数
```
PUT /tether/session/{sessionId}/settings
```
| 参数 | 类型 | 说明 |
|------|------|------|
| iso | Int | ISO 值 |
| aperture | String | 光圈值 |
| shutterSpeed | String | 快门速度 |
| whiteBalance | String | 白平衡 |
| exposureCompensation | String | 曝光补偿 |

### 8.7 远程触发快门
```
POST /tether/session/{sessionId}/capture
```
**功能**：远程触发相机快门，照片自动传输到服务器。

| 参数 | 类型 | 说明 |
|------|------|------|
| filterPreset | String | 应用的色彩预设名称（可选，如 `日系人像`） |

**返回**：
```json
{
  "data": {
    "photoId": "p_200",
    "imageUrl": "https://...",
    "thumbnailUrl": "https://...",
    "filterApplied": "日系人像"
  }
}
```
**WebSocket 事件**：`{ "event": "capture_complete", "photoId": "p_200", "imageUrl": "..." }`

### 8.8 获取色彩预设列表
```
GET /tether/presets
```
**返回**：
```json
{
  "data": [
    { "id": "preset_001", "name": "原生", "cssFilter": "none" },
    { "id": "preset_002", "name": "日系人像", "cssFilter": "contrast(1.2) saturate(1.1) sepia(0.8)" },
    { "id": "preset_003", "name": "胶片色彩", "cssFilter": "sepia(0.3) hue-rotate(-30deg) contrast(1.1)" },
    { "id": "preset_004", "name": "黑白质感", "cssFilter": "grayscale(1) contrast(1.2)" },
    { "id": "preset_005", "name": "风光增强", "cssFilter": "brightness(1.1) contrast(1.3) saturate(1.5)" }
  ]
}
```

### 8.9 联机会话拍摄列表
```
GET /tether/session/{sessionId}/photos
```
**功能**：获取本次联机会话已拍摄的照片列表（实时更新）。

**WebSocket 事件**：`{ "event": "new_photo", "photo": { "id": "...", "thumbnailUrl": "..." } }`

---

## 8.10 手机互联（Phone Link）

> **2026-08-15 王总定稿 UI 后新增**：手机与手机互联（scrcpy 式远程快门）——被控端 A（装了 APP 的 Android/iPhone）创建配对获得 6 位连接码，控制端 B（网页）输入/扫码加入后，B 实时看到 A 的屏幕画面并**只能按快门**，照片自动在 A 的 APP 生成坐标点。
> 画面流（MJPEG/WebRTC）由 A 端本地服务直连 B 或二期 SRS 中转，**不走本模块 WS 通道**；本模块只负责配对与命令/信令转发。

### 8.10.1 创建配对（被控端 A）
```
POST /phonelink/pairs        （需登录：Bearer Token）
```
| 参数 | 类型 | 说明 |
|------|------|------|
| hostDevice | String | 设备名（可选，工作台顶栏展示，如「Mate 60 Pro」） |

**返回**：
```json
{
  "data": {
    "pairId": "ph_a1b2c3d4e5",
    "code": "482913",
    "hostDevice": "",
    "expiresAt": "2026-08-15T12:00:00.000Z"
  }
}
```
> 每用户同时只保留一个 pending 配对（重复创建先关旧的）；连接码 6 位数字、10 分钟有效（TTL 自动过期）。

### 8.10.2 加入配对（控制端 B，匿名）
```
POST /phonelink/pairs/join   （IP 限频 10 次/分钟，防枚举）
```
| 参数 | 类型 | 说明 |
|------|------|------|
| code | String | 6 位连接码 |
| clientLabel | String | 控制端设备标识（可选） |

**返回**：`{ "data": { "pairId": "ph_...", "hostDevice": "", "status": "joined" } }`
> 原子抢占：只能加入 pending 状态的配对；已被加入（joined）或关闭（closed）返回 1005/1004。

### 8.10.3 查询配对状态
```
GET /phonelink/pairs/{code}
```
**返回**：`{ "data": { "pairId": "ph_...", "status": "pending|joined|closed", "hostDevice": "...", "expiresAt": "..." } }`

### 8.10.4 关闭配对（被控端 A）
```
POST /phonelink/pairs/{code}/close    （需登录 + 必须是创建者，幂等）
```

### 8.10.5 WebSocket 通道
**端点**：`ws://<host>/api/v1/phonelink/ws?code=XXXXXX&role=host|client`
- host = 被控端 A；client = 控制端 B；同码同角色只允许一个连接（新连接顶掉旧连接）
- 两端消息原样透传（`{ type, data }`，type=signal/command 等业务自定义）；`ping` 保活回 `pong`
- 服务端事件：`client_joined`（→host）、`host_ready`（→client）、`peer_left`（→对端）
- host 断开 → 配对自动置 closed；心跳 30s 探活

**命令语义（业务层约定，后端透传）**：`{ "type": "capture" }` 远程快门；`{ "type": "status", "data": {...} }` 状态同步。

---

## 9. 即时通讯（私信聊天）

### 9.1 获取会话列表
```
GET /chat/conversations
```
**返回**：
```json
{
  "data": [
    {
      "conversationId": "conv_001",
      "peerId": "u_002",
      "peerName": "@摄影师小林",
      "peerAvatar": "https://...",
      "lastMessage": "你好呀～很高兴在这里相遇！",
      "lastTime": "2026-08-04T22:30:00Z",
      "unreadCount": 2
    }
  ]
}
```

### 9.2 获取聊天记录
```
GET /chat/conversations/{conversationId}/messages
```
| 参数 | 类型 | 说明 |
|------|------|------|
| before | String | 游标（取此消息之前的 N 条） |
| limit | Int | 拉取条数（默认 30） |

### 9.3 发送消息
```
POST /chat/conversations/{conversationId}/messages
```
| 参数 | 类型 | 说明 |
|------|------|------|
| type | String | `text` 文字 / `image` 图片 / `coord` 坐标分享 |
| content | String | 消息内容 |
| imageUrl | String | 图片消息时提供 |

**WebSocket 推送**：`ws://<host>/api/v1/chat/ws` — 实时接收新消息。

### 9.4 创建/获取与某用户的会话
```
POST /chat/conversations
```
| 参数 | 类型 | 说明 |
|------|------|------|
| peerId | String | 对方用户 ID |

### 9.5 标记已读
```
PUT /chat/conversations/{conversationId}/read
```

---

## 10. 会员与订阅

### 10.1 获取会员套餐列表
```
GET /member/plans
```
**返回**：
```json
{
  "data": [
    {
      "planId": "plan_pro",
      "name": "高级会员",
      "price": 198,
      "originalPrice": 398,
      "period": "year",
      "benefits": ["无限上传", "高清原图", "优先展示", "专属滤镜", "数据统计"]
    }
  ]
}
```

### 10.2 创建支付订单
```
POST /member/order
```
| 参数 | 类型 | 说明 |
|------|------|------|
| planId | String | 套餐 ID |
| paymentMethod | String | `wechat` 微信 / `alipay` 支付宝 |

**返回**：`{ "data": { "orderId": "ord_001", "paymentUrl": "https://...", "qrCode": "https://..." } }`

### 10.3 查询订单状态
```
GET /member/order/{orderId}
```

### 10.4 获取我的会员状态
```
GET /member/status
```
**返回**：会员等级、到期时间、剩余天数、权益列表。

### 10.5 取消自动续费
```
POST /member/cancel-renewal
```

---

## 11. 摄影师认证

### 11.1 申请摄影师认证
```
POST /photographer/apply
```
| 参数 | 类型 | 说明 |
|------|------|------|
| realName | String | 真实姓名 |
| portfolio | Array\<String\> | 代表作照片 ID 列表（3-9 张） |
| description | String | 摄影简介/擅长领域 |

### 11.2 获取认证状态
```
GET /photographer/status
```
**返回**：`{ "data": { "status": "pending" | "approved" | "rejected", "reason": "" } }`

### 11.3 获取摄影师权益
```
GET /photographer/benefits
```

---

## 12. 邀请码

### 12.1 获取我的邀请码
```
GET /invite/my-code
```
**返回**：`{ "data": { "code": "PHOTO268", "usedCount": 5, "totalReward": 990 } }`

### 12.2 兑换邀请码
```
POST /invite/redeem
```
| 参数 | 类型 | 说明 |
|------|------|------|
| code | String | 邀请码 |

**返回**：`{ "data": { "reward": "30天高级会员", "expireAt": "2026-09-05" } }`

---

## 13. 相册管理

### 13.1 获取我的照片列表
```
GET /photos/mine
```
| 参数 | 类型 | 说明 |
|------|------|------|
| sortBy | String | `time` 时间 / `coord` 按坐标分组 |
| page | Int | 页码 |
| pageSize | Int | 每页条数 |

### 13.2 获取回收站列表
```
GET /photos/trash
```
**返回**：已删除的照片和坐标点列表（30 天内可恢复）。

| 参数 | 类型 | 说明 |
|------|------|------|
| type | String | `photos` / `markers` / `all` |

### 13.3 永久删除
```
DELETE /photos/{photoId}/permanent
DELETE /coords/{coordId}/permanent
```

---

## 14. 通用接口

### 14.1 消息通知列表
```
GET /notifications
```
| 类型 | 说明 |
|------|------|
| `like` | 有人赞了你的照片 |
| `comment` | 有人评论了你的照片 |
| `follow` | 有人关注了你 |
| `tip` | 收到了打赏 |
| `system` | 系统通知 |

### 14.2 标记通知已读
```
PUT /notifications/{notificationId}/read
PUT /notifications/read-all
```

### 14.3 获取未读通知数
```
GET /notifications/unread-count
```

### 14.4 文件上传（小文件直传，用于头像等）
```
POST /upload/file
```
Content-Type: `multipart/form-data`

| 参数 | 类型 | 说明 |
|------|------|------|
| file | File | 文件 |
| scene | String | `avatar` / `chat` / `portfolio` |

### 14.5 举报内容
```
POST /report
```
| 参数 | 类型 | 说明 |
|------|------|------|
| targetType | String | `photo` / `comment` / `user` |
| targetId | String | 目标 ID |
| reason | String | 举报原因 |

---

## 附录 A：WebSocket 事件汇总

| 端点 | 事件 | 方向 | 说明 |
|------|------|------|------|
| `/tether/session/{id}/liveview` | `frame` | S→C | 实时取景帧 |
| `/tether/session/{id}` | `capture_complete` | S→C | 拍摄完成 |
| `/tether/session/{id}` | `settings_changed` | S→C | 相机参数变化 |
| `/tether/session/{id}` | `new_photo` | S→C | 新照片导入 |
| `/chat/ws` | `new_message` | S→C | 新私信消息 |
| `/chat/ws` | `typing` | S↔C | 正在输入 |
| `/notifications/ws` | `notification` | S→C | 新通知 |

## 附录 B：HTTP 状态码与业务错误码

| HTTP | errcode | 说明 |
|------|---------|------|
| 200 | 0 | 成功 |
| 400 | 1001 | 参数校验失败 |
| 401 | 1002 | Token 过期或无效 |
| 403 | 1003 | 权限不足（如非摄影师切换工作模式） |
| 404 | 1004 | 资源不存在 |
| 409 | 1005 | 重复操作（如已关注/已点赞） |
| 429 | 1006 | 请求频率超限 |
| 500 | 9999 | 服务器内部错误 |

## 附录 C：通用分页格式

**请求**：`page`（从 1 开始）, `pageSize`（默认 20，最大 100）

**返回**：
```json
{
  "code": 0,
  "data": { "list": [...], "total": 256, "page": 1, "pageSize": 20, "hasMore": true },
  "message": "ok"
}
```
