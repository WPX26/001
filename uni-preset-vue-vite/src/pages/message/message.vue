<template>
  <view class="page">
    <!-- 未登录：引导登录 -->
    <view v-if="!loggedIn" class="login-guide">
      <view class="guide-card">
        <view class="guide-emoji">💬</view>
        <view class="guide-title">消息</view>
        <view class="guide-desc">登录后查看点赞、评论与系统通知</view>
        <view class="guide-btn" hover-class="guide-btn-hover" @tap="goLogin">
          <text>去登录</text>
        </view>
      </view>
    </view>

    <!-- 已登录：消息列表 -->
    <view v-else class="msg-page">
      <!-- 头部：未读摘要 + 全部已读 -->
      <view class="msg-header">
        <view class="msg-header-title">
          <text class="msg-header-main">消息</text>
          <text class="msg-header-sub">{{ unreadCount > 0 ? unreadCount + ' 条未读' : '全部已读' }} · 共 {{ total }} 条</text>
        </view>
        <view class="mark-all-btn" @tap="handleReadAll">
          <text class="mark-all-icon">✓</text>
          <text>全部已读</text>
        </view>
      </view>

      <!-- 分类标签（照原型：全部/点赞/评论/关注/通知） -->
      <scroll-view class="category-tabs" scroll-x :show-scrollbar="false">
        <view class="category-tab-wrap">
          <view
            v-for="tab in tabs"
            :key="tab.key"
            class="category-tab"
            :class="{ active: category === tab.key }"
            @tap="switchCategory(tab.key)"
          >
            <text>{{ tab.label }}</text>
            <text v-if="badgeCount(tab.key) > 0" class="badge">{{ badgeCount(tab.key) }}</text>
          </view>
        </view>
      </scroll-view>

      <!-- 列表 -->
      <view v-if="!loaded" class="state-tip">加载中…</view>
      <view v-else class="message-list">
        <!-- 空状态 -->
        <view v-if="filtered.length === 0" class="empty-state">
          <view class="empty-state-icon">📭</view>
          <view class="empty-state-text">暂无此类消息</view>
        </view>

        <!-- 消息项 -->
        <view
          v-for="m in filtered"
          :key="m.id"
          class="message-item"
          :class="{ unread: m.unread }"
          @tap="handleItemTap(m)"
        >
          <view class="msg-avatar" :class="m.avatarClass">
            <image v-if="m.avatarImg" class="msg-avatar-img" :src="m.avatarImg" mode="aspectFill" />
            <text v-else class="msg-avatar-text">{{ m.avatarText }}</text>
          </view>
          <view class="msg-content">
            <view class="msg-header-row">
              <text class="msg-name">{{ m.name }}</text>
              <text class="msg-time">{{ m.timeText }}</text>
            </view>
            <view class="msg-preview">{{ m.content }}</view>
          </view>
          <view
            v-if="m.thumbImg"
            class="msg-thumb"
            :style="{ backgroundImage: 'url(' + m.thumbImg + ')' }"
          ></view>
          <view v-else-if="m.thumb" class="msg-thumb msg-thumb-emoji">{{ m.thumb }}</view>
        </view>

        <!-- 加载更多 -->
        <view v-if="filtered.length > 0" class="load-more">
          <text v-if="loadingMore">加载中…</text>
          <text v-else-if="hasMore">上拉加载更多</text>
          <text v-else>没有更多了</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'

// 后端 type → 页面分类（tab 固定为 全部/点赞/评论/关注/通知，照原型 TYPE_CATEGORY）
const TYPE_CATEGORY = {
  like: 'like',
  comment: 'comment',
  reply: 'comment',
  tip: 'system',
  follow: 'follow',
  system: 'system',
  collect: 'like',
  chat: 'system',
}
// 后端 type → 头像渐变 class（照原型 TYPE_AVATAR_CLASS；打赏用金色 notice）
const TYPE_AVATAR_CLASS = {
  like: 'like',
  comment: 'comment',
  reply: 'comment',
  tip: 'notice',
  follow: 'follow',
  system: 'system',
  collect: 'like',
  chat: 'system',
}
// 后端 type → 名称兜底（actor 缺失时）
const TYPE_NAME = {
  like: '点赞',
  comment: '评论',
  reply: '回复',
  tip: '打赏',
  follow: '关注',
  system: '系统通知',
  collect: '收藏',
  chat: '私信',
}

const PAGE_SIZE = 50

export default {
  data() {
    return {
      loggedIn: false,
      list: [], // 已映射的通知（与原型 messages 同构）
      page: 1,
      hasMore: false,
      loaded: false,
      loadingMore: false,
      unreadCount: 0,
      total: 0,
      category: 'all',
      tabs: [
        { key: 'all', label: '全部' },
        { key: 'like', label: '点赞' },
        { key: 'comment', label: '评论' },
        { key: 'follow', label: '关注' },
        { key: 'system', label: '通知' },
      ],
    }
  },
  computed: {
    filtered() {
      if (this.category === 'all') return this.list
      return this.list.filter((m) => m.category === this.category)
    },
  },
  onShow() {
    uni.$emit('tab-change', 3)
    if (!memoApi.isLoggedIn()) {
      this.loggedIn = false
      return
    }
    if (!this.loggedIn || !this.loaded) {
      this.loggedIn = true
      this.refreshAll()
    }
  },
  onPullDownRefresh() {
    this.refreshAll()
  },
  onReachBottom() {
    this.loadMore()
  },
  methods: {
    /* ===== 数据加载 ===== */
    refreshAll() {
      if (!memoApi.isLoggedIn()) return
      // 第一页 + 未读数（并行）
      this.fetchUnreadCount()
      memoApi
        .get('/notifications?page=1&pageSize=' + PAGE_SIZE)
        .then((data) => {
          this.list = (data && data.list || []).map(this.mapNotification)
          this.page = (data && data.page) || 1
          this.hasMore = !!(data && data.hasMore)
          this.total = (data && data.total) || this.list.length
          this.loaded = true
          this.loadingMore = false
        })
        .catch(() => {
          this.loaded = true
        })
        .finally(() => {
          uni.stopPullDownRefresh()
        })
    },
    loadMore() {
      if (!this.loaded || !this.hasMore || this.loadingMore) return
      this.loadingMore = true
      memoApi
        .get('/notifications?page=' + (this.page + 1) + '&pageSize=' + PAGE_SIZE)
        .then((data) => {
          if (!data || !data.list) return
          const existing = new Set(this.list.map((m) => m.id))
          const fresh = data.list.filter((m) => !existing.has(m.id)).map(this.mapNotification)
          this.list = this.list.concat(fresh)
          this.page = data.page
          this.hasMore = !!data.hasMore
        })
        .catch(() => {})
        .finally(() => {
          this.loadingMore = false
        })
    },
    fetchUnreadCount() {
      memoApi
        .get('/notifications/unread-count')
        .then((data) => {
          if (data && data.count != null) this.unreadCount = Number(data.count) || 0
        })
        .catch(() => {})
    },

    /* ===== 通知 → 消息映射（照原型 mapNotification） ===== */
    mapNotification(n) {
      const actor = n.actor || null
      const name = (actor && actor.nickname) || TYPE_NAME[n.type] || '系统通知'
      const avatarText = actor && actor.nickname ? actor.nickname.charAt(0) : '📢'
      return {
        id: String(n.id),
        type: n.type,
        category: TYPE_CATEGORY[n.type] || 'system',
        name,
        avatarText,
        avatarImg: (actor && actor.avatar) || '',
        avatarClass: TYPE_AVATAR_CLASS[n.type] || 'system',
        content: this.buildContent(n, name),
        timeText: this.formatRelativeTime(n.createdAt),
        unread: !n.isRead,
        thumb: (n.photo && n.photo.thumbnailUrl) || '',
        thumbImg: (n.photo && n.photo.thumbnailUrl) || '',
      }
    },
    // 内容文案：后端 content 为空时按类型模板拼接（照原型 buildNotificationContent）
    buildContent(n, fallbackName) {
      if (n.content) return n.content
      const who = (n.actor && n.actor.nickname) || fallbackName || '有人'
      switch (n.type) {
        case 'like':
          return who + ' 赞了你的照片'
        case 'comment':
          return who + ' 评论了你的照片'
        case 'reply':
          return who + ' 回复了你的评论'
        case 'tip':
          return who + ' 打赏了你的照片'
        case 'follow':
          return who + ' 关注了你'
        case 'collect':
          return who + ' 收藏了你的照片'
        case 'chat':
          return who + ' 给你发来新私信'
        default:
          return who + ' 与你互动'
      }
    },
    // 相对时间（照原型 formatRelativeTime）
    formatRelativeTime(t) {
      if (!t) return ''
      const d = new Date(t)
      if (isNaN(d.getTime())) return ''
      const min = Math.floor((Date.now() - d.getTime()) / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return min + '分钟前'
      const h = Math.floor(min / 60)
      if (h < 24) return h + '小时前'
      const day = Math.floor(h / 24)
      if (day === 1) return '昨天'
      if (day < 7) return day + '天前'
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    },

    /* ===== 分类 ===== */
    switchCategory(key) {
      this.category = key
    },
    badgeCount(key) {
      if (key === 'all') return this.unreadCount
      return this.list.filter((m) => m.unread && m.category === key).length
    },

    /* ===== 已读操作 ===== */
    // 单条已读：乐观更新，失败回滚（照原型 markNotificationRead）
    handleItemTap(m) {
      uni.showToast({ title: '消息详情将在后续阶段开放', icon: 'none' })
      if (!m.unread) return
      m.unread = false
      if (this.unreadCount > 0) this.unreadCount -= 1
      memoApi
        .put('/notifications/' + encodeURIComponent(m.id) + '/read')
        .catch(() => {
          m.unread = true
          this.unreadCount += 1
        })
    },
    // 全部已读：乐观更新，失败重拉恢复
    handleReadAll() {
      if (this.unreadCount === 0) {
        uni.showToast({ title: '已全部已读', icon: 'none' })
        return
      }
      this.list.forEach((m) => (m.unread = false))
      this.unreadCount = 0
      uni.showToast({ title: '已全部标记为已读', icon: 'success' })
      memoApi
        .put('/notifications/read-all')
        .catch(() => {
          this.refreshAll()
        })
    },

    /* ===== 其他 ===== */
    goLogin() {
      uni.reLaunch({ url: '/pages/login/login' })
    },
  },
}
</script>

<style>
.page {
  min-height: 100vh;
  background: linear-gradient(165deg, #f8ecd8 0%, #f3dcb4 100%);
  padding: 20rpx 24rpx 40rpx;
  box-sizing: border-box;
}

/* ===== 未登录引导 ===== */
.login-guide {
  min-height: 80vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.guide-card {
  width: 100%;
  background: rgba(250, 243, 231, 0.9);
  border-radius: 40rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.1);
  padding: 80rpx 48rpx;
  text-align: center;
}
.guide-emoji {
  font-size: 96rpx;
  margin-bottom: 24rpx;
}
.guide-title {
  font-size: 40rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 12rpx;
}
.guide-desc {
  font-size: 26rpx;
  color: #6b4423;
  margin-bottom: 48rpx;
}
.guide-btn {
  height: 92rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  border-radius: 24rpx;
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
  letter-spacing: 4rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 12rpx 48rpx rgba(232, 144, 32, 0.4);
}
.guide-btn-hover {
  transform: translateY(2rpx) scale(0.98);
  filter: brightness(0.95);
}

/* ===== 头部（照原型 page-header） ===== */
.msg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8rpx 8rpx 20rpx;
}
.msg-header-title {
  display: flex;
  flex-direction: column;
}
.msg-header-main {
  font-size: 40rpx;
  font-weight: 700;
  color: #1c0f08;
  letter-spacing: 0.5rpx;
}
.msg-header-sub {
  font-size: 20rpx;
  color: #b89070;
  margin-top: 4rpx;
}
.mark-all-btn {
  display: flex;
  align-items: center;
  gap: 6rpx;
  padding: 14rpx 24rpx;
  background: rgba(255, 250, 242, 0.95);
  border: 1px solid rgba(212, 165, 116, 0.3);
  border-radius: 20rpx;
  box-shadow: 0 2rpx 10rpx rgba(28, 15, 8, 0.08);
  font-size: 24rpx;
  color: #8b5e3c;
}
.mark-all-icon {
  color: #e89020;
  font-weight: 700;
}

/* ===== 分类标签（照原型 category-tabs） ===== */
.category-tabs {
  white-space: nowrap;
  margin-bottom: 20rpx;
}
.category-tab-wrap {
  display: flex;
  gap: 12rpx;
  padding: 4rpx;
}
.category-tab {
  display: inline-flex;
  align-items: center;
  padding: 12rpx 28rpx;
  border-radius: 32rpx;
  background: rgba(255, 245, 230, 0.7);
  border: 1px solid rgba(212, 165, 116, 0.2);
  font-size: 24rpx;
  color: #9b7b5a;
  font-weight: 500;
  transition: all 0.2s ease;
}
.category-tab.active {
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  color: #ffffff;
  border-color: transparent;
  box-shadow: 0 6rpx 20rpx rgba(232, 144, 32, 0.4);
}
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28rpx;
  height: 28rpx;
  padding: 0 8rpx;
  margin-left: 8rpx;
  background: #e85d3c;
  color: #ffffff;
  font-size: 18rpx;
  border-radius: 14rpx;
  font-weight: 600;
  box-sizing: border-box;
}
.category-tab.active .badge {
  background: rgba(255, 255, 255, 0.3);
}

/* ===== 消息列表（照原型 message-list / message-item） ===== */
.state-tip {
  padding: 120rpx 40rpx;
  text-align: center;
  font-size: 26rpx;
  color: #6b4423;
}
.message-item {
  display: flex;
  gap: 20rpx;
  padding: 24rpx;
  background: rgba(255, 250, 242, 0.85);
  border: 1px solid rgba(212, 165, 116, 0.15);
  border-radius: 28rpx;
  margin-bottom: 16rpx;
  position: relative;
}
.message-item.unread {
  background: rgba(255, 245, 230, 0.95);
  border-color: rgba(240, 160, 64, 0.3);
}
.message-item.unread::before {
  content: '';
  position: absolute;
  left: 14rpx;
  top: 50%;
  transform: translateY(-50%);
  width: 10rpx;
  height: 10rpx;
  border-radius: 50%;
  background: #e89020;
}
/* 头像：type 渐变（照原型 msg-avatar） */
.msg-avatar {
  width: 88rpx;
  height: 88rpx;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}
.msg-avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
}
.msg-avatar-text {
  font-size: 34rpx;
  font-weight: 700;
  color: #ffffff;
}
.msg-avatar.system {
  background: linear-gradient(135deg, #f0a040, #d4691c);
}
.msg-avatar.like {
  background: linear-gradient(135deg, #e89020, #b85e3c);
}
.msg-avatar.comment {
  background: linear-gradient(135deg, #d4691c, #8b4513);
}
.msg-avatar.follow {
  background: linear-gradient(135deg, #9b7b5a, #6b4423);
}
.msg-avatar.notice {
  background: linear-gradient(135deg, #f5b870, #e89020);
}
.msg-content {
  flex: 1;
  min-width: 0;
}
.msg-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6rpx;
}
.msg-name {
  font-size: 26rpx;
  font-weight: 600;
  color: #1c0f08;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msg-time {
  font-size: 20rpx;
  color: #b89070;
  flex-shrink: 0;
  margin-left: 16rpx;
}
.msg-preview {
  font-size: 24rpx;
  color: #8b5e3c;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.msg-thumb {
  width: 84rpx;
  height: 84rpx;
  border-radius: 16rpx;
  flex-shrink: 0;
  background: linear-gradient(135deg, #ebc9a0, #d4a870);
  background-size: cover;
  background-position: center;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32rpx;
  color: #8b5e3c;
}

/* 空状态 / 加载更多 */
.empty-state {
  text-align: center;
  padding: 100rpx 40rpx;
}
.empty-state-icon {
  font-size: 72rpx;
  margin-bottom: 16rpx;
  opacity: 0.5;
}
.empty-state-text {
  font-size: 26rpx;
  color: #b89070;
}
.load-more {
  padding: 28rpx 0 8rpx;
  text-align: center;
  font-size: 24rpx;
  color: rgba(107, 68, 35, 0.6);
}
</style>
