<template>
  <view class="page">
    <view class="card">
      <view class="title">📷 相机 FTP 直传（示例页）</view>

      <view class="account">
        <view class="row"><text class="label">服务器 IP</text><text class="value">{{ serverIp }}</text></view>
        <view class="row"><text class="label">端口</text><text class="value">{{ serverInfo?.port || 21 }}</text></view>
        <view class="row"><text class="label">账号</text><text class="value">{{ account.user }}</text></view>
        <view class="row"><text class="label">密码</text><text class="value">{{ account.pass }}</text></view>
      </view>

      <view class="tip">
        相机 FTP 设置：服务器地址 {{ serverIp }}，端口 {{ serverInfo?.port || 21 }}，用户/密码见上。
        账号每次启动随机生成（D6）。接收目录：应用私有目录 ftp/photos。
      </view>

      <button
        class="btn"
        :type="phase === 'running' ? 'warn' : 'primary'"
        @click="onToggle"
      >{{ phase === 'running' ? '停止服务' : '启动服务' }}</button>
      <view class="phase">状态：{{ phase === 'running' ? '运行中' : '未运行' }}</view>
    </view>

    <view class="card">
      <view class="title">文件接收（{{ files.length }}）</view>
      <scroll-view scroll-y class="list">
        <view v-for="(f, i) in files" :key="i" class="item">
          <text class="fname">{{ f.name }}</text>
          <text class="fsize">{{ formatSize(f.size) }}</text>
          <text class="fpath">{{ f.path }}</text>
        </view>
        <view v-if="files.length === 0" class="empty">暂无接收文件</view>
      </scroll-view>
    </view>

    <view class="card">
      <view class="title">事件日志</view>
      <scroll-view scroll-y class="list">
        <view v-for="(e, i) in logs" :key="i" class="log">{{ e }}</view>
        <view v-if="logs.length === 0" class="empty">暂无事件</view>
      </scroll-view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
// 插件 API 统一入口（UTS 插件规范：导入插件根目录，UTS 编译器自动匹配 utssdk 平台实现）
import { startServer, stopServer, onEvent } from '@/uni_modules/ftp-receiver'
import type { FtpServerEvent, FtpStartResult, FtpFileMeta } from '@/uni_modules/ftp-receiver'

const phase = ref<'idle' | 'running'>('idle')
const serverInfo = ref<FtpStartResult | null>(null)
const logs = ref<string[]>([])
const files = ref<FtpFileMeta[]>([])
let unsubscribe: (() => void) | null = null

const serverIp = computed(() => {
  if (!serverInfo.value) return '—'
  return serverInfo.value.ip || '未检测到热点 IP（请先开启手机热点）'
})

// D6：账号每次启动随机生成（安全 + 免配置）
function genAccount(): { user: string, pass: string } {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  let pass = ''
  for (let i = 0; i < 8; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)]
  }
  const n = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
  return { user: 'cam_' + n, pass }
}
const account = genAccount()

function pushLog(s: string) {
  logs.value.unshift('[' + new Date().toLocaleTimeString() + '] ' + s)
  if (logs.value.length > 200) logs.value.pop()
}

function formatSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

// L2：Android 13+ 通知权限运行时申请（FGS 通知属系统强制通知，未授权不阻塞启动）
// #ifdef APP-ANDROID
function requestNotificationPermission() {
  try {
    const Build = plus.android.importClass('android.os.Build')
    const pm = plus.android.importClass('android.content.pm.PackageManager')
    if (Build.VERSION.SDK_INT >= 33) {
      const main = plus.android.runtimeMainActivity()
      const granted = main.checkSelfPermission('android.permission.POST_NOTIFICATIONS')
      if (granted !== pm.PERMISSION_GRANTED) {
        plus.android.requestPermissions(['android.permission.POST_NOTIFICATIONS'], function () {})
      }
    }
  } catch (e) {
    // 权限 API 异常不阻塞启动
  }
}
// #endif

async function onToggle() {
  if (phase.value === 'running') {
    await doStop()
  } else {
    await doStart()
  }
}

async function doStart() {
  // #ifdef APP-ANDROID
  requestNotificationPermission()
  // #endif
  phase.value = 'running'
  try {
    const res = await startServer({ port: 21, dir: 'ftp/photos', user: account.user, pass: account.pass })
    serverInfo.value = res
    pushLog('启动成功：' + res.ip + ':' + res.port)
  } catch (e: any) {
    phase.value = 'idle'
    pushLog('启动失败：' + e.code + ' ' + e.message)
  }
}

async function doStop() {
  phase.value = 'idle'
  try {
    await stopServer()
    pushLog('服务已停止')
  } catch (e: any) {
    pushLog('停止失败：' + e.code + ' ' + e.message)
  }
}

function handleEvent(ev: FtpServerEvent) {
  switch (ev.type) {
    case 'connected':
      pushLog('连接：' + ev.client)
      break
    case 'transferring':
      pushLog('开始接收：' + ev.name)
      break
    case 'fileReceived':
      files.value.unshift(ev.meta)
      pushLog('接收完成：' + ev.meta.name + ' (' + formatSize(ev.meta.size) + ')')
      break
    case 'disconnected':
      pushLog('断开：' + ev.client)
      break
    case 'error':
      pushLog('错误：' + ev.code + ' ' + ev.message)
      break
  }
}

onMounted(() => {
  unsubscribe = onEvent(handleEvent)
})

onUnmounted(() => {
  // 页面卸载必须退订（onEvent 返回退订函数）
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  // 页面销毁时兜底停止服务（服务生命周期归属业务层，示例页简单处理）
  if (phase.value === 'running') {
    stopServer().catch(() => {})
  }
})
</script>

<style scoped>
.page {
  padding: 24rpx;
  background: #f5f6f8;
  min-height: 100vh;
}
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}
.title {
  font-size: 32rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}
.account {
  background: #f8f9fb;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
}
.row {
  display: flex;
  justify-content: space-between;
  padding: 8rpx 0;
}
.label {
  color: #888;
  font-size: 26rpx;
}
.value {
  font-size: 26rpx;
  font-weight: 500;
}
.tip {
  color: #888;
  font-size: 24rpx;
  margin: 16rpx 0;
  line-height: 1.6;
}
.btn {
  margin-top: 8rpx;
}
.phase {
  margin-top: 16rpx;
  text-align: center;
  color: #666;
  font-size: 26rpx;
}
.list {
  max-height: 400rpx;
}
.item {
  padding: 12rpx 0;
  border-bottom: 1rpx solid #f0f0f0;
}
.fname {
  font-size: 26rpx;
  font-weight: 500;
  margin-right: 12rpx;
}
.fsize {
  font-size: 24rpx;
  color: #2b9939;
}
.fpath {
  display: block;
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}
.log {
  font-size: 24rpx;
  color: #333;
  padding: 6rpx 0;
  border-bottom: 1rpx solid #f5f5f5;
  word-break: break-all;
}
.empty {
  color: #bbb;
  font-size: 24rpx;
  padding: 20rpx 0;
  text-align: center;
}
</style>
