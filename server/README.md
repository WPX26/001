# 地图相册平台 · 后端（P0）

技术栈：Node.js 24 + Express 4 + MongoDB (Mongoose) + JWT。接口契约严格对齐仓库根目录 `api.md`（统一响应 `{code, data, message}`、错误码附录 B、分页附录 C、Bearer Token 认证、前缀 `/api/v1`）。

## 快速启动

```bash
cd server
npm install
# 1. 复制并配置环境变量（.env 已提供本地开发默认值）
cp .env.example .env
# 2. 启动 MongoDB（三种方式任选，详见文末"需要王总提供"）
#    Windows: 安装 MongoDB Community Server 后运行服务
#    Docker:  docker run -d -p 27017:27017 --name memomap-mongo mongo:7
# 3. 启动后端
npm run dev        # 开发模式（node --watch 热重载）
npm start          # 生产启动
# 4. 健康检查
curl http://localhost:3000/health
```

> MongoDB 未启动时，`npm run dev` 会打印明确提示并以退出码 1 优雅退出（不会挂起白屏）。
> 冒烟测试：`npm run smoke`（不依赖 MongoDB 的部分直接可跑，MongoDB 相关部分自动标记"待 MongoDB 就绪"）。

## 目录结构

```
server/
├── src/
│   ├── config/           env 加载、数据库连接、常量（错误码表）
│   ├── models/           12 个 Mongoose 模型（含索引）
│   ├── middleware/       auth（Bearer 校验）、validate（1001）、errorHandler（统一错误）、notFound
│   ├── routes/           按模块路由 + express-validator 校验链
│   ├── controllers/      auth / user / map / coord / photo / upload
│   ├── services/         sms.service（阿里云短信适配层）、storage.service（OSS/本地双模式）、token.service
│   └── utils/            response（统一响应）、errors（AppError）、pagination（附录 C）、geo（网格键）、asyncHandler
├── scripts/smoke.js      冒烟测试
├── uploads/              本地存储模式的上传目录（自动创建）
└── .env.example          全部配置项注释说明
```

## 已实现接口（P0，对照 api.md）

| 模块 | 接口 | api.md |
|------|------|--------|
| 认证 | `POST /auth/send-code` | 1.1 |
| 认证 | `POST /auth/login` | 1.2 |
| 认证 | `POST /auth/register`（可选密码） | 1.3 |
| 认证 | `POST /auth/refresh`（refresh 轮换） | 1.4 |
| 认证 | `POST /auth/logout`（吊销 refresh） | 1.5 |
| 用户 | `GET /users/me` / `PUT /users/me` | 2.1/2.2 |
| 用户 | `GET /users/{userId}/profile` | 2.3 |
| 用户 | `GET /users/{userId}/coords` | 2.4 |
| 用户 | `POST/DELETE /users/{userId}/follow` | 2.5/2.6 |
| 用户 | `GET /users/{userId}/following` / `followers` | 2.7/2.8 |
| 用户 | `PUT /users/me/mode`（工作模式需摄影师认证 → 1003） | 2.9 |
| 用户 | `GET /users/me/collected-coords` | 2.10 |
| 地图 | `GET /map/markers`（bbox + zoom/level 网格聚合） | 3.1 |
| 坐标 | `POST /coords`（关联照片 + photoTimes，工作模式鉴权） | 7.2 |
| 坐标 | `GET /coords/{coordId}/detail`（照片分页） | 3.3 |
| 坐标 | `DELETE /coords/{coordId}`（软删）/ `POST .../restore` / `DELETE .../permanent` | 7.4/7.5/13.3 |
| 照片 | `GET /photos/mine`（time / coord 分组） | 13.1 |
| 照片 | `GET /photos/{photoId}` | 6.1 |
| 照片 | `POST/DELETE /photos/{photoId}/like`（重复 → 1005） | 6.2/6.3 |
| 照片 | `POST/DELETE /photos/{photoId}/collect` | 6.5/6.6 |
| 照片 | `DELETE /photos/{photoId}` / `POST .../restore` / `DELETE .../permanent` | 7.6/7.7/13.3 |
| 照片 | `GET /photos/trash`（photos/markers/all） | 13.2 |
| 上传 | `POST /upload/token`（OSS 模式：STS 凭证 + 预签名 URL） | 7.1 |
| 上传 | `POST /upload/callback`（OSS 验签 + 幂等创建照片） | 7.3 |
| 上传 | `POST /upload/file`（multipart 小文件直传） | 14.4 |
| 基建 | `GET /health`（非业务接口，运维用） | — |

P1 预留（模型已建、路由未接）：灵感模式（4 章）、探索模式（5 章）、评论（6.7-6.9）、打赏（6.4）、联机拍摄（8 章）、私信（9 章）、会员（10 章）、摄影师认证（11 章）、邀请码（12 章）、通知（14.1-14.3）、举报（14.5）、地图搜索（3.2）。

## 设计说明（务实取舍）

- **ID 格式**：api.md 示例中的 `u_001` 风格仅为示意，实际返回 MongoDB ObjectId 字符串，前端按不透明字符串处理即可。
- **点赞/收藏**：`likedBy/collectedBy` 数组 + `likes/collects` 冗余计数，原子 `$push/$inc` 保证不重复；数据量大后（P1）可拆互动表。
- **软删除**：坐标/照片统一 `deletedAt`，删除坐标同时软删其照片；恢复坐标连带恢复照片；30 天清理由运营侧定时任务执行（P1）。
- **地图聚合**：`/map/markers` 按 zoom 联动 level（≤14→1, 15→2, ≥16→3），MongoDB 聚合按网格分组（0.05°/0.02°/0.01°），单点返回坐标、多点返回聚合点（cluster + subCoordIds + 缩略图）；坐标写入时存 `gridKey` 备用。
- **上传回调幂等**：以文件 hash 为 `clientPhotoId` 唯一键，重复回调不产生重复照片。
- **短信/OSS 适配层**：接口契约完整、按阿里云官方 SDK 写法实现；密钥未配置时返回业务错误码 **1007**（HTTP 503，扩展码，未占用 api.md 附录 B 区间）并在日志提示去 `.env` 配置，密钥到位即生效，无需改代码。
- **本地存储模式**（STORAGE_MODE=local，默认）：`/upload/file` 直传 + `/upload/callback` 建照片，`/upload/token` 返回 `{ossToken: null, uploadUrls: []}`；生产切换 `STORAGE_MODE=oss` 后走 STS 直传。

## 需要王总提供的资源清单

### 1. MongoDB（当前未安装）
- 推荐方式（Windows）：下载 [MongoDB Community Server](https://www.mongodb.com/try/download/community)（MSI 安装，勾选"Install as a Service"），或
- Docker：`docker run -d -p 27017:27017 --name memomap-mongo mongo:7`
- 云数据库：提供连接串填入 `.env` 的 `MONGODB_URI` 即可（代码已支持）。

### 2. 阿里云短信（接入 `/auth/send-code`）
| 配置项 | 说明 |
|--------|------|
| `ALIYUN_SMS_ACCESS_KEY_ID` / `_SECRET` | RAM 用户 AccessKey，需短信服务（SMS）发送权限 |
| `ALIYUN_SMS_SIGN_NAME` | 短信签名（控制台申请并审核通过） |
| `ALIYUN_SMS_TEMPLATE_CODE` | 验证码模板 CODE（变量 `${code}`，如 `SMS_123456789`） |

### 3. 阿里云 OSS 直传（接入 `/upload/token` 与 `/upload/callback`）
| 配置项 | 说明 |
|--------|------|
| `OSS_REGION` | Bucket 区域，如 `oss-cn-hangzhou` |
| `OSS_BUCKET` | Bucket 名称 |
| `OSS_ACCESS_KEY_ID` / `_SECRET` | RAM 用户 AccessKey（OSS 写权限 + `AliyunSTSAssumeRoleAccess`） |
| `OSS_ROLE_ARN` | RAM 角色 ARN（如 `acs:ram::123456789:role/memomap-upload`，为该角色授权 OSS 上传策略，并配置信任策略允许上述 AccessKey 扮演） |

> 短信/OSS 密钥到位后仅需改 `.env` 并重启，接口契约与代码无需任何改动。
> P1 依赖：微信/支付宝支付密钥（会员模块）、相机厂商 SDK（联机拍摄）。
