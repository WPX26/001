# 地图相册平台 Sealos 部署指南

> 适用版本：后端 `server/`（Node 20 + Express + Mongoose，端口 3000）+ 静态前端（9 个 HTML + api.js）
> 目标平台：Sealos 云平台（cloud.sealos.io）
> 配套文件：`server/Dockerfile`、`server/.dockerignore`、`Dockerfile.static`、`nginx.conf`、根目录 `.dockerignore`

---

## 0. 架构总览

```
浏览器
  │  https://<前端域名>.sealoshzh.site   （Sealos 网关域名）
  ▼
┌──────────────────────────┐      /api/ 反代（内网）      ┌──────────────────────┐
│ 静态前端容器（nginx）      │ ───────────────────────────► │ 后端容器（node）      │
│ 9 个 HTML + api.js       │      /uploads/ 反代（可选）    │ 端口 3000            │
│ api.js 的 localhost 地址  │ ◄─────────────────────────── │ /health /api/v1/... │
│ 由 sub_filter 改写为 /api/v1│                            └──────────┬───────────┘
└──────────────────────────┘                                       │
                                                                    ▼
                                            ┌────────────────────────────────────┐
                                            │ 持久卷 /app/uploads（照片 5-10Gi）    │
                                            │ Sealos MongoDB（test-db 应用）        │
                                            │ 内网 test-db-mongodb.ns-xxxxx.svc:27017│
                                            └────────────────────────────────────┘
```

两个容器应用 + 一个数据库应用（已存在）。前后端之间走 Sealos 应用内网 DNS 互访，不经过公网。

---

## 1. 前置准备

| 项目 | 说明 |
| --- | --- |
| Docker 环境 | 本地安装 Docker Desktop（Windows）或 Docker Engine |
| 镜像仓库账号 | **推荐阿里云 ACR**（国内拉取快）：登录阿里云容器镜像服务控制台 → 个人版 → 创建命名空间 `memomap`。备选 Docker Hub（国外拉取慢，Sealos 拉取时可多试几次） |
| Sealos 控制台 | https://cloud.sealos.io ，已有账号（数据库 test-db 已就绪） |
| 本仓库 | 含 `server/Dockerfile`、`Dockerfile.static`、`nginx.conf` |

---

## 2. 镜像构建与推送

以下命令在**项目根目录**执行（Windows 用 PowerShell 或 Git Bash；`<仓库> = registry.cn-hangzhou.aliyuncs.com/memomap` 阿里云 ACR 示例）。

### 2.1 登录镜像仓库

```bash
# 阿里云 ACR
docker login registry.cn-hangzhou.aliyuncs.com
# 或 Docker Hub
docker login
```

### 2.2 构建并推送后端镜像

```bash
# 镜像名建议：<仓库>/memomap-backend:<版本>，版本用语义化版本号，如 1.0、1.1
docker build -t registry.cn-hangzhou.aliyuncs.com/memomap/memomap-backend:1.0 ./server
docker push registry.cn-hangzhou.aliyuncs.com/memomap/memomap-backend:1.0
```

### 2.3 构建并推送前端镜像

```bash
docker build -f Dockerfile.static -t registry.cn-hangzhou.aliyuncs.com/memomap/memomap-frontend:1.0 .
docker push registry.cn-hangzhou.aliyuncs.com/memomap/memomap-frontend:1.0
```

> 注意：前端镜像构建前，先确认 `nginx.conf` 中的 `proxy_pass` 后端地址（见第 4 章），
> 或部署后在 Sealos 控制台改（更省事：先部署后端，拿到后端应用名/命名空间，再构建前端镜像）。

---

## 3. Sealos 部署后端

Sealos 控制台 → **应用管理** → **创建应用**。

### 3.1 基础配置

| 配置项 | 值 |
| --- | --- |
| 应用名称 | `memomap-backend` |
| 镜像地址 | `registry.cn-hangzhou.aliyuncs.com/memomap/memomap-backend:1.0` |
| 容器端口 | `3000` |
| 副本数 | `1`（免费额度内；照片存储为本地磁盘模式，暂不建议多副本） |

### 3.2 环境变量清单（重点）

在「环境变量」处逐项填写。**所有变量必须显式配置**（镜像内没有 .env 文件）：

| 变量 | 生产值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 生产模式（morgan 日志格式、校验行为切换） |
| `PORT` | `3000` | 与容器端口一致 |
| `MONGODB_URI` | `mongodb://root:4508VjEV6P9bD7J0@test-db-mongodb.ns-hv4ku0s.svc:27017/memomap?authSource=admin&directConnection=true` | **推荐内网地址**：不经公网、更快更安全；`authSource=admin` 指定 root 认证库。若内网连接失败（multi-pod / 鉴权异常），改用外网地址 `mongodb://root:4508VjEV6P9bD7J0@dbconn.sealoshzh.site:42605/memomap?authSource=admin&directConnection=true`（与本地 .env 相同），并在「注意事项」第 6.2 节对照排查 |
| `JWT_SECRET` | 新生成：`openssl rand -hex 32`（至少 32 位随机串） | **务必更换**，不要沿用仓库内 .env 的旧值；一旦泄露可任意伪造登录态 |
| `JWT_ACCESS_EXPIRES` | `86400` | access token 有效期（秒） |
| `JWT_REFRESH_EXPIRES` | `2592000` | refresh token 有效期（秒） |
| `SMS_DEV_MODE` | `true`（**联调阶段**） | 开发模式：验证码直接返回给前端。**正式对外开放前必须改为 false** 并配置 `ALIYUN_SMS_*` 四项，否则任何人可拿到任意手机号验证码登录 |
| `ALIYUN_SMS_ACCESS_KEY_ID` | 留空（密钥到位后填写） | 短信服务密钥，到位后配置 |
| `ALIYUN_SMS_ACCESS_KEY_SECRET` | 留空 | 同上 |
| `ALIYUN_SMS_SIGN_NAME` | 留空 | 短信签名 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 留空 | 短信模板 |
| `STORAGE_MODE` | `local` | 照片存本地磁盘（挂载持久卷）。OSS 密钥到位后改 `oss` 并填 `OSS_*` |
| `LOCAL_BASE_URL` | `https://<你的后端域名>.sealoshzh.site` | **必须填后端公网域名**（第 3.4 节绑定后回填）。`STORAGE_MODE=local` 时照片 URL = 此值 + `/uploads/...`，填错则照片无法显示 |
| `TDT_KEY` | `ee36c38eb7777006970a6e5597f7bae9` | 天地图地名搜索 Key（与 .env 一致） |
| `SMS_CODE_EXPIRE_SECONDS` / `SMS_SEND_INTERVAL_SECONDS` | `300` / `60` | 可保持默认，也可不填（代码有默认值） |

### 3.3 持久卷（必配）

| 配置项 | 值 |
| --- | --- |
| 挂载路径 | `/app/uploads` |
| 容量 | **5~10 GiB**（照片按压缩后 1-3MB/张估算；容量可后续扩容） |
| 挂载点类型 | 可选（Sealos 默认提供） |

> 不挂持久卷，容器重建/升级后照片全部丢失。`STORAGE_MODE=local` 阶段这是**唯一的照片存储**。

### 3.4 端口与域名

| 配置项 | 值 |
| --- | --- |
| 对外端口 | `3000` |
| 域名 | 创建后点击「生成域名」/「绑定域名」，得到形如 `memomap-backend-xxxxx.sealoshzh.site` 的公网域名 |

记住该域名，回填到 `LOCAL_BASE_URL`（如已填，更新后需重新部署生效）以及第 4 章前端反代。

---

## 4. Sealos 部署静态前端

Sealos 控制台 → **应用管理** → **创建应用**。

### 4.1 基础配置

| 配置项 | 值 |
| --- | --- |
| 应用名称 | `memomap-frontend` |
| 镜像地址 | `registry.cn-hangzhou.aliyuncs.com/memomap/memomap-frontend:1.0` |
| 容器端口 | `80` |
| 环境变量 | 无需配置（nginx 纯静态） |
| 持久卷 | 不需要（页面无状态） |

### 4.2 配置反向代理（关键）

前端容器内 `nginx.conf` 已写好反代骨架，部署前把两处 `proxy_pass` 的后端地址替换为**后端应用的内网地址**：

```nginx
location /api/ {
    proxy_pass http://memomap-backend.ns-hv4ku0s.svc:3000;   # ← 改为你的后端应用名+命名空间
    ...
}
location /uploads/ {
    proxy_pass http://memomap-backend.ns-hv4ku0s.svc:3000;
    ...
}
```

**内网地址格式**：Sealos 同一集群内，应用之间用 `http://<应用名>.<命名空间>.svc:<端口>` 互访（`cluster.local` 后缀可省略）。本仓库数据库内网地址就是同格式（`test-db-mongodb.ns-hv4ku0s.svc:27017`）。

> 如何查命名空间：数据库「test-db」的内网地址显示 `ns-hv4ku0s`，后端应用创建在**同一命名空间**下（Sealos 默认把应用建在集群命名空间）。后端应用详情页可看到其内网地址；若后端不在同一命名空间，改为 `memomap-backend.<后端命名空间>.svc:3000`。

修改 nginx.conf 后**重新构建前端镜像并推送**（重复第 2.3 节），或把修改后的 nginx.conf 直接挂载为 configmap 覆盖（进阶做法，此处不展开）。

### 4.3 端口与域名

| 配置项 | 值 |
| --- | --- |
| 对外端口 | `80` |
| 域名 | 生成/绑定域名，形如 `memomap-frontend-xxxxx.sealoshzh.site` |

用户访问的就是这个前端域名，页面全部相对路径跳转，API 走同源 `/api/` 反代，**浏览器无跨域**。

### 4.4 前端 API 地址改写原理

`api.js` 默认写死 `http://localhost:3000/api/v1`。方案选择：

- **采用方案（本仓库已实现，零源码改动）**：nginx `sub_filter` 把 `api.js` 响应中的 `http://localhost:3000/api/v1` 字符串改写为同源 `/api/v1`，再由 `location /api/` 反代到后端。不触碰源码、不破坏本地开发（本地仍走 localhost:3000）。
- 备选方案 A：改 `api.js` 默认为 `/api/v1`——会破坏本地开发（本地 python server.py 无法转发），不推荐。
- 备选方案 B：浏览器控制台执行 `localStorage.setItem('memo_api_base', 'https://<后端域名>/api/v1')` 手动覆盖——仅适合临时联调。

---

## 5. 验证清单（部署后逐项确认）

后端域名记作 `API=https://memomap-backend-xxxxx.sealoshzh.site`，前端域名记作 `WEB=https://memomap-frontend-xxxxx.sealoshzh.site`。

### 5.1 后端健康检查

```bash
curl $API/health
# 期望：{"code":0,"data":{"status":"ok","service":"memomap-server","storageMode":"local","db":"connected"}}
# 若 db:"disconnected" 或请求超时 → 检查 MONGODB_URI（第 6.2 节）
```

### 5.2 地图区域接口（无需登录，验证路由与数据库连通）

```bash
curl "$API/api/v1/map/regions?level=city"
# 期望：code=0 且 data 为行政区列表（TDT_KEY 未配置时为空列表属正常，接口本身通了即可）
```

### 5.3 注册 / 登录冒烟（SMS_DEV_MODE=true 时验证码直接返回）

```bash
# 发送验证码（devCode 即验证码）
curl -X POST $API/api/v1/auth/send-code \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800000000","scene":"register"}'
# → data.devCode 是 6 位验证码（如 123456）

# 注册并登录（拿 token）
curl -X POST $API/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800000000","code":"<devCode>","nickname":"冒烟测试"}'
# → 期望 code=0 返回 accessToken/refreshToken
```

> Windows PowerShell 提示：`curl` 别名的是 Invoke-WebRequest，请在 Git Bash 或 WSL 中执行上述命令，或安装 `curl.exe`。

### 5.4 照片上传落盘（验证持久卷）

```bash
# 用 5.3 的 token
curl -X POST $API/api/v1/upload/file \
  -H "Authorization: Bearer <accessToken>" \
  -F "scene=coord" -F "file=@test.jpg"
# → 期望 code=0，返回 photo 记录（含 id 与 url）

# 验证照片可访问
curl -I "$API/uploads/coord/<文件名>.jpg"   # 期望 200

# 验证落盘：Sealos 控制台 → 后端应用 → 终端/文件管理 → 查看 /app/uploads/coord/
```

### 5.5 前端验证

```bash
# 页面与 api.js 改写
curl -s $WEB/login-prototype.html | head   # 页面可访问
curl -s $WEB/api.js | grep baseUrl          # 期望输出 '/api/v1'（已被 nginx 改写）
# 浏览器打开 $WEB/memo-home.html → 登录 → 地图应加载真实坐标（接口同源，无跨域报错）
```

---

## 6. 注意事项

### 6.1 费用与配额
- Sealos 免费额度：CPU/内存有限额，域名、流量通常计入免费额度，超限需充值。部署后在控制台「费用中心」核对实际用量。
- 两个应用各 1 副本即可跑通；高峰期可临时加副本（后端为本地磁盘存储时多副本会分片照片文件，**升级前先迁移到 OSS**）。

### 6.2 数据库：内网 vs 外网
| | 内网地址（推荐） | 外网地址（dbconn） |
| --- | --- | --- |
| 地址 | `test-db-mongodb.ns-hv4ku0s.svc:27017` | `dbconn.sealoshzh.site:42605` |
| 用途 | 生产环境（Sealos 内应用访问） | 本地开发 / 内网不通时兜底 |
| 特点 | 不暴露公网、延迟低 | 公网可达、有安全暴露面 |

- 内网连不上的排查顺序：① 命名空间是否一致（`ns-hv4ku0s` 是你集群的命名空间）→ ② 应用与数据库是否在同一 Sealos 集群 → ③ 换成外网地址验证是地址问题还是凭据问题。
- 凭据是 `root` 账号，生产环境建议在数据库控制台为后端单独建只读/读写账号，避免 root 密码泄露。

### 6.3 数据备份（必做）
- **数据库**：Sealos 控制台 → 数据库（test-db）→ 备份管理，可配置自动备份（建议每日一次，保留 7 天）。
- **照片**（/app/uploads 持久卷）：Sealos 提供持久卷快照；定期另存一份（如 rsync 到对象存储）。照片是业务核心资产，**备份节奏：上线初期每周，稳定后每月**。

### 6.4 更新发布流程
1. 代码修改 → 本地验证
2. 重新构建镜像（版本号递增，如 `1.1`）并 push
3. Sealos 控制台 → 应用 → 更新镜像版本 → 确认（持久卷保留，数据不丢）
4. 重新验证第 5 章清单

### 6.5 安全红线（上线前必须处理）
- [ ] `JWT_SECRET` 已更换为随机值（第 3.2 节）
- [ ] `SMS_DEV_MODE=false` 且 `ALIYUN_SMS_*` 已配置（否则验证码接口=裸奔）
- [ ] 数据库 root 密码已更换 / 已建专用账号
- [ ] 后端应用如有「公网可访问」开关，确认是否真的需要公网访问（前端已反代，后端可只内网）
- [ ] `cors()` 全放行（`server/src/app.js`）在正式上线前收敛为前端域名白名单

### 6.6 常见问题速查
| 现象 | 原因与处理 |
| --- | --- |
| `/health` 正常但 `/api/v1/*` 404 | 容器端口/域名未指向 3000；或反代配置 path 多写了尾 `/api` |
| 照片 404 | ① `LOCAL_BASE_URL` 填的是 `http://` 或旧域名 → 更新环境变量重新部署；② 未挂持久卷，容器重启后照片丢失 |
| 前端页面能开、接口全红 | `api.js` 未被改写 → 确认 nginx 用的是本仓库 `nginx.conf`（`curl -s $WEB/api.js | grep baseUrl` 应为 `/api/v1`） |
| 验证码提示发送频繁 | `SMS_SEND_INTERVAL_SECONDS=60`，同一手机号 60 秒内只能发一次 |
| 镜像构建慢 | 依赖锁文件 resolved 指向华为云镜像，国内一般秒级；若卡在 npm registry，检查代理 |
