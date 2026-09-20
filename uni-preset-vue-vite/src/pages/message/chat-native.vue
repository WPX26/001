<template>
  <view class="cn-root" :style="{ paddingTop: statusBarH + 'px' }">
    <!-- ===== 会话列表 ===== -->
    <view v-if="view === 'list'" class="cn-list">
      <view class="cn-title">消息</view>
      <view v-if="!convs.length && !loading" class="cn-empty">暂无会话
去地图相册找朋友聊两句吧</view>
      <view v-for="c in convs" :key="c.conversationId" class="cn-conv" @click="openConv(c)">
        <view class="cn-avatar-wrap">
          <image class="cn-avatar" :src="c.peerAvatar || DEFAULT_AVATAR" mode="aspectFill" />
          <view v-if="c.unreadCount" class="cn-badge">{{ c.unreadCount > 99 ? '99+' : c.unreadCount }}</view>
        </view>
        <view class="cn-conv-main">
          <view class="cn-row">
            <text class="cn-name">{{ c.peerName || '用户' }}</text>
            <text class="cn-time">{{ fmtTime(c.lastTime) }}</text>
          </view>
          <view class="cn-row">
            <image
              v-if="c.lastImageUrl && c.lastMessage === '[图片]'"
              class="cn-thumb" :src="c.lastImageUrl" mode="aspectFill"
            />
            <text class="cn-preview">{{ preview(c) }}</text>
          </view>
        </view>
      </view>
    </view>

    <!-- ===== 聊天窗口 ===== -->
    <view v-else class="cn-chat">
      <view class="cn-chat-head">
        <text class="cn-back" @click="backList">‹ 会话</text>
        <text class="cn-peer">{{ activeConv.peerName || '聊天' }}</text>
        <text class="cn-head-spacer"></text>
      </view>
      <scroll-view
        class="cn-msgs" scroll-y scroll-with-animation
        :scroll-into-view="scrollAnchor" :scroll-top="0"
      >
        <view v-if="hasMore" class="cn-more" @click="loadOlder">加载更早的消息</view>
        <view
          v-for="m in msgs" :key="m.id" :id="'m-' + m.id"
          class="cn-msg" :class="isMine(m) ? 'mine' : ''"
        >
          <view v-if="m.type === 'image'" class="cn-imgwrap">
            <image class="cn-img" :src="m.imageUrl" mode="widthFix" @click="previewImg(m.imageUrl)" />
          </view>
          <view v-else-if="m.type === 'coord'" class="cn-bubble cn-bubble-coord">📍 位置消息</view>
          <view v-else class="cn-bubble">{{ m.content }}</view>
        </view>
        <view v-if="!msgs.length && !loading" class="cn-empty">还没有消息，打个招呼吧</view>
      </scroll-view>
      <view class="cn-inputbar">
        <view class="cn-imgbtn" @click="chooseAndSendImage">图片</view>
        <input
          class="cn-input" v-model="draft" confirm-type="send"
          placeholder="说点什么…" :disabled="sending"
          @confirm="sendText"
        />
        <button class="cn-send" size="mini" :disabled="sending || !draft.trim()" @click="sendText">发送</button>
      </view>
    </view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { API_BASE_URL } from '../../utils/config'

/**
 * 消息页「应用版」：原生 uni-app 实现（非 H5 套壳）
 * - 会话列表 / 聊天 / 文本 + 图片消息，后端接口与演示版共用
 * - 实时：uni.connectSocket 连 /chat/ws（JWT query token + 心跳 + 断线重连），兜底 8s 轮询
 * - 切换：utils/config.js 的 MESSAGE_MODE（'demo' 走 H5 套壳，'app' 走本组件）
 */
const DEFAULT_AVATAR = '/static/logo.png'
const CHAT_IMG_MAX = 10 * 1024 * 1024

export default {
  data() {
    return {
      DEFAULT_AVATAR,
      statusBarH: 0,
      view: 'list',
      loading: false,
      convs: [],
      activeConv: {},
      msgs: [],
      hasMore: false,
      draft: '',
      sending: false,
      scrollAnchor: '',
      wsTask: null,
      wsOpen: false,
      wsTimer: null,
      pollTimer: null,
    }
  },

  onLoad() {
    const sys = uni.getSystemInfoSync()
    this.statusBarH = (sys && sys.statusBarHeight) || 0
  },

  onShow() {
    this.loadConvs()
    this.startPoll()
  },

  onHide() { this.cleanup() },
  onUnload() { this.cleanup() },

  methods: {
    /* ---------- 会话列表 ---------- */
    async loadConvs() {
      try {
        this.loading = true
        const data = await memoApi.get('/chat/conversations')
        this.convs = (data && data.list) || []
      } catch (e) { console.warn('[chat-native] 会话列表失败', e) }
      finally { this.loading = false }
    },

    preview(c) {
      if (c.lastMessage === '[图片]' && c.lastImageUrl) return '[图片]'
      return c.lastMessage || ''
    },

    fmtTime(t) {
      if (!t) return ''
      const d = new Date(t)
      if (isNaN(d.getTime())) return ''
      const now = new Date()
      const hm = (x) => String(x).padStart(2, '0')
      const sameDay = d.toDateString() === now.toDateString()
      if (sameDay) return hm(d.getHours()) + ':' + hm(d.getMinutes())
      return hm(d.getMonth() + 1) + '-' + hm(d.getDate())
    },

    /* ---------- 聊天 ---------- */
    async openConv(c) {
      this.activeConv = c
      this.view = 'chat'
      this.msgs = []
      this.hasMore = false
      await this.loadMessages()
      this.connectWS()
      this.markRead()
    },

    backList() {
      this.view = 'list'
      this.closeWS()
      this.loadConvs()
    },

    async loadMessages() {
      try {
        this.loading = true
        const data = await memoApi.get('/chat/conversations/' + this.activeConv.conversationId + '/messages?limit=30')
        const list = (data && data.list) || []
        this.msgs = list.slice().reverse()
        this.hasMore = !!(data && data.hasMore)
        this.anchorLast()
      } catch (e) { console.warn('[chat-native] 拉取消息失败', e) }
      finally { this.loading = false }
    },

    async loadOlder() {
      if (!this.msgs.length || !this.hasMore) return
      const earliest = this.msgs[0].createdAt
      try {
        const data = await memoApi.get('/chat/conversations/' + this.activeConv.conversationId + '/messages?limit=30&before=' + encodeURIComponent(earliest))
        const older = ((data && data.list) || []).slice().reverse()
        this.msgs = older.concat(this.msgs)
        this.hasMore = !!(data && data.hasMore)
      } catch (e) { console.warn('[chat-native] 翻页失败', e) }
    },

    isMine(m) {
      const peerId = this.activeConv.peerId
      if (peerId) return String(m.senderId) !== String(peerId) // 1:1 会话，非对方即我
      return false
    },

    anchorLast() {
      const last = this.msgs[this.msgs.length - 1]
      if (last) this.scrollAnchor = 'm-' + last.id
    },

    markRead() {
      const id = this.activeConv.conversationId
      if (!id) return
      memoApi.put('/chat/conversations/' + id + '/read').catch(() => {})
      const row = this.convs.find((c) => c.conversationId === id)
      if (row) row.unreadCount = 0
    },

    /* ---------- 发送 ---------- */
    async sendText() {
      const content = (this.draft || '').trim()
      if (!content || this.sending) return
      this.sending = true
      try {
        const data = await memoApi.post('/chat/conversations/' + this.activeConv.conversationId + '/messages', { type: 'text', content })
        if (data && data.message) {
          this.msgs.push(data.message)
          this.anchorLast()
        }
        this.draft = ''
      } catch (e) {
        uni.showToast({ title: '发送失败，请稍后重试', icon: 'none' })
      } finally { this.sending = false }
    },

    chooseAndSendImage() {
      if (this.sending) return
      uni.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        success: (res) => {
          const path = res.tempFilePaths && res.tempFilePaths[0]
          if (path) this.uploadAndSendImage(path)
        },
      })
    },

    uploadAndSendImage(filePath) {
      this.sending = true
      const token = memoApi.getToken()
      uni.uploadFile({
        url: API_BASE_URL + '/upload/file',
        filePath,
        name: 'file',
        formData: { scene: 'chat' },
        header: token ? { Authorization: 'Bearer ' + token } : {},
        success: async (up) => {
          try {
            const json = typeof up.data === 'string' ? JSON.parse(up.data) : up.data
            const url = json && json.data && json.data.url
            if (up.statusCode !== 200 || !url) throw new Error(json && json.message || '上传失败')
            const data = await memoApi.post('/chat/conversations/' + this.activeConv.conversationId + '/messages', { type: 'image', imageUrl: url })
            if (data && data.message) {
              this.msgs.push(data.message)
              this.anchorLast()
            }
          } catch (e) {
            uni.showToast({ title: '图片发送失败', icon: 'none' })
          } finally { this.sending = false }
        },
        fail: () => {
          this.sending = false
          uni.showToast({ title: '图片发送失败', icon: 'none' })
        },
      })
    },

    previewImg(url) {
      if (url) uni.previewImage({ urls: [url] })
    },

    /* ---------- 实时：WS + 轮询兜底 ---------- */
    connectWS() {
      if (this.wsTask) return
      const token = memoApi.getToken()
      if (!token) return
      const wsUrl = API_BASE_URL.replace(/^http/, 'ws') + '/chat/ws?token=' + encodeURIComponent(token)
      try {
        this.wsTask = uni.connectSocket({ url: wsUrl, complete: () => {} })
        this.wsTask.onOpen(() => { this.wsOpen = true })
        this.wsTask.onMessage((ev) => {
          try {
            const d = JSON.parse(ev.data)
            if (d && d.type === 'new_message' && d.data && d.data.message) this.onPush(d.data.message)
          } catch (e) { /* 忽略非 JSON 帧 */ }
        })
        this.wsTask.onClose(() => {
          this.wsOpen = false
          this.wsTask = null
          if (this.view === 'chat') this.wsTimer = setTimeout(() => this.connectWS(), 3000)
        })
        this.wsTask.onError(() => { /* 交给 onClose 重连 */ })
        // 心跳，防代理空闲断链
        this.wsTimer = setInterval(() => {
          if (this.wsOpen && this.wsTask) {
            try { this.wsTask.send({ data: JSON.stringify({ type: 'ping' }) }) } catch (e) {}
          }
        }, 25000)
      } catch (e) { console.warn('[chat-native] WS 建连失败，走轮询', e) }
    },

    closeWS() {
      if (this.wsTimer) { clearTimeout(this.wsTimer); clearInterval(this.wsTimer); this.wsTimer = null }
      if (this.wsTask) {
        try { this.wsTask.close({}) } catch (e) {}
        this.wsTask = null
      }
      this.wsOpen = false
    },

    onPush(m) {
      if (m.conversationId === this.activeConv.conversationId && this.view === 'chat') {
        if (!this.msgs.some((x) => x.id === m.id)) {
          this.msgs.push(m)
          this.anchorLast()
        }
        this.markRead()
      } else {
        const row = this.convs.find((c) => c.conversationId === m.conversationId)
        if (row) {
          row.unreadCount = (row.unreadCount || 0) + 1
          row.lastMessage = m.type === 'image' ? '[图片]' : m.content || ''
          if (m.type === 'image' && m.imageUrl) row.lastImageUrl = m.imageUrl
          row.lastTime = m.createdAt
        }
      }
    },

    startPoll() {
      this.stopPoll()
      this.pollTimer = setInterval(() => {
        if (this.view === 'chat') this.refreshNew()
        else this.loadConvs()
      }, 8000)
    },
    stopPoll() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    },
    async refreshNew() {
      try {
        const data = await memoApi.get('/chat/conversations/' + this.activeConv.conversationId + '/messages?limit=20')
        const list = ((data && data.list) || []).slice().reverse()
        const known = new Set(this.msgs.map((m) => m.id))
        const fresh = list.filter((m) => !known.has(m.id))
        if (fresh.length) {
          this.msgs = this.msgs.concat(fresh)
          this.anchorLast()
          this.markRead()
        }
      } catch (e) { /* 静默 */ }
    },

    cleanup() {
      this.stopPoll()
      this.closeWS()
    },
  },
}
</script>

<style>
.cn-root { height: 100vh; background: #FAF3E7; display: flex; flex-direction: column; }
.cn-list, .cn-chat { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.cn-title { font-size: 40rpx; font-weight: 600; padding: 24rpx 32rpx 8rpx; color: #333; }
.cn-empty { color: #999; font-size: 26rpx; text-align: center; padding: 120rpx 40rpx; white-space: pre-line; }
.cn-conv { display: flex; align-items: center; padding: 20rpx 32rpx; }
.cn-avatar-wrap { position: relative; margin-right: 20rpx; }
.cn-avatar { width: 88rpx; height: 88rpx; border-radius: 44rpx; background: #eee; }
.cn-badge { position: absolute; top: -6rpx; right: -10rpx; background: #E5484D; color: #fff; font-size: 20rpx; min-width: 32rpx; height: 32rpx; line-height: 32rpx; border-radius: 16rpx; text-align: center; padding: 0 6rpx; }
.cn-conv-main { flex: 1; min-width: 0; }
.cn-row { display: flex; justify-content: space-between; align-items: center; }
.cn-name { font-size: 30rpx; color: #333; font-weight: 500; }
.cn-time { font-size: 22rpx; color: #aaa; }
.cn-preview { font-size: 26rpx; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.cn-thumb { width: 44rpx; height: 44rpx; border-radius: 8rpx; margin-right: 10rpx; flex-shrink: 0; }
.cn-chat-head { display: flex; align-items: center; height: 88rpx; padding: 0 24rpx; border-bottom: 1rpx solid #eee; background: #FAF3E7; }
.cn-back { font-size: 30rpx; color: #666; padding: 8rpx 16rpx 8rpx 0; }
.cn-peer { flex: 1; text-align: center; font-size: 32rpx; font-weight: 600; color: #333; }
.cn-head-spacer { width: 90rpx; }
.cn-msgs { flex: 1; padding: 16rpx 24rpx; box-sizing: border-box; }
.cn-more { text-align: center; color: #999; font-size: 24rpx; padding: 16rpx 0; }
.cn-msg { display: flex; margin-bottom: 20rpx; }
.cn-msg.mine { justify-content: flex-end; }
.cn-bubble { max-width: 70%; background: #fff; border-radius: 16rpx; padding: 16rpx 22rpx; font-size: 28rpx; color: #333; word-break: break-all; }
.cn-msg.mine .cn-bubble { background: #FFE7BA; }
.cn-bubble-coord { color: #666; }
.cn-imgwrap { max-width: 60%; }
.cn-img { width: 320rpx; border-radius: 12rpx; background: #eee; }
.cn-msg.mine .cn-imgwrap { display: flex; justify-content: flex-end; }
.cn-inputbar { display: flex; align-items: center; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: #fff; border-top: 1rpx solid #eee; }
.cn-imgbtn { font-size: 24rpx; color: #666; background: #F3EAD8; border-radius: 10rpx; padding: 12rpx 18rpx; margin-right: 16rpx; }
.cn-input { flex: 1; height: 64rpx; background: #F7F7F7; border-radius: 12rpx; padding: 0 20rpx; font-size: 28rpx; }
.cn-send { margin-left: 16rpx; background: #E8A33D; color: #fff; font-size: 26rpx; }
</style>
