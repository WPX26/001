# ============================================================
# 地图相册平台 - 后端容器镜像（Node.js + Express + MongoDB）
#
# 构建命令（在项目根目录执行）：
#   docker build -t <镜像仓库>/memomap-backend:1.0 ./server
#
# 基础镜像选择：node:24-alpine
#   - 体积小（约 120MB，全量 node:24 镜像 400MB+）
#   - 升级原因：日志系统使用 Node 内置 node:sqlite（22.13+ 免 flag 可用），
#     日志库 server/data/logs.db 由进程内创建，需 node:24 提供该模块
#   - 已核对 server/package-lock.json 全依赖树：均为纯 JS 包，
#     无 esbuild / sharp / 原生 bcrypt 等需要 node-gyp 编译的模块
#     （bcryptjs 是纯 JS 实现，无需编译）；node:sqlite 编译进 Node 二进制，
#     musl（alpine）环境下同样可用
#   - 唯一带 postinstall 的包是 @alicloud/openapi-core，其脚本
#     为纯 JS 版本号写入（node scripts/ts_version.js），
#     musl（alpine）环境下无兼容问题
#   - 若未来引入 sharp 等原生依赖，把基础镜像改回 node:24（glibc 全量镜像）
#     即可，其余 Dockerfile 无需改动
# ============================================================
FROM node:24-alpine

WORKDIR /app

# 依赖锁文件（package-lock.json 的 resolved 已指向华为云镜像源，国内拉取快）
COPY package.json package-lock.json ./
# npm ci 与 lockfile 严格一致，保证构建可复现；--omit=dev 裁剪开发依赖
# （scripts/ 目录为 smoke 测试脚本，生产镜像不需要，不拷贝）
RUN npm ci --omit=dev

# 业务代码
COPY src ./src

# 照片存储目录（STORAGE_MODE=local 时照片写入此目录）
# 生产环境必须挂载持久卷到 /app/uploads（Sealos 部署时配置），
# 否则容器重建后照片全部丢失
# /app/data：日志 SQLite 库目录（server/data/logs.db，进程内自动创建），
# 生产环境同样需挂持久卷，否则容器重建后日志全部丢失
RUN mkdir -p /app/uploads /app/data

# 生产模式（可在 Sealos 环境变量中按需覆盖）
ENV NODE_ENV=production

EXPOSE 3000

# 健康检查：命中 /health（该接口不依赖数据库，仅检查进程存活）
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
