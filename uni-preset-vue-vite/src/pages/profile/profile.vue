<template>
  <view class="page">
    <!-- 未登录：引导登录 -->
    <view v-if="!loggedIn" class="login-guide">
      <view class="guide-card">
        <view class="guide-emoji">🧑‍🚀</view>
        <view class="guide-title">我的</view>
        <view class="guide-desc">登录后查看作品、会员权益与更多功能</view>
        <view class="guide-btn" hover-class="guide-btn-hover" @tap="goLogin">
          <text>点击登录</text>
        </view>
      </view>
    </view>

    <!-- 已登录 -->
    <template v-else>
      <!-- 用户信息卡 -->
      <view class="user-card">
        <view class="user-avatar">
          <image v-if="me.avatar" class="user-avatar-img" :src="me.avatar" mode="aspectFill" />
          <text v-else>{{ avatarText }}</text>
        </view>
        <view class="user-info">
          <view class="user-name-row">
            <text class="user-name">{{ me.nickname || '未设置昵称' }}</text>
            <view v-if="isPhotographer" class="photographer-badge">
              <text class="badge-camera">📷</text>
              <text>认证摄影师</text>
            </view>
          </view>
          <view class="user-bio">{{ me.bio || '这个人很懒，还没有写简介' }}</view>
          <view class="user-phone">{{ me.phone || '' }}</view>
        </view>
      </view>

      <!-- 统计（照原型 profile-stats） -->
      <view class="stats-bar">
        <view class="stat-item">
          <view class="stat-num">{{ stats.coordCount }}</view>
          <view class="stat-label">标记点</view>
        </view>
        <view class="stat-item">
          <view class="stat-num">{{ stats.photoCount }}</view>
          <view class="stat-label">照片</view>
        </view>
        <view class="stat-item">
          <view class="stat-num">{{ stats.likeCount }}</view>
          <view class="stat-label">获赞</view>
        </view>
      </view>

      <!-- 会员区块（照原型 member-hero） -->
      <view class="member-card">
        <view class="member-card-top">
          <view class="member-crown">👑</view>
          <view class="member-card-info">
            <view class="member-card-title">尊享会员</view>
            <view class="member-card-desc">
              <text v-if="isMemberActive">会员有效，剩余 {{ memberRemainingDays }} 天</text>
              <text v-else>开通会员 · 订阅即认证摄影师</text>
            </view>
          </view>
          <view
            v-if="isMemberActive"
            class="member-status-badge active"
          >已开通</view>
          <view
            v-else
            class="member-open-btn"
            hover-class="member-open-btn-hover"
            @tap="goSubscribe"
          >开通会员</view>
        </view>
        <view v-if="isMemberActive" class="member-auto-renew">
          <text v-if="memberAutoRenew">自动续费已开启</text>
          <text v-else>自动续费未开启，到期后会员失效</text>
        </view>
      </view>

      <!-- 邀请码兑换（照原型 invite-card） -->
      <view class="invite-card">
        <view class="invite-title">
          <text class="invite-title-icon">🎁</text>
          <text>邀请码兑换</text>
        </view>
        <view class="invite-desc">输入好友的邀请码，可获得 <text class="invite-desc-strong">1 个月会员</text>，兑换即认证摄影师</view>
        <view class="invite-input-row">
          <input
            class="invite-input"
            v-model="inviteCode"
            placeholder="请输入邀请码"
            placeholder-class="invite-placeholder"
            maxlength="12"
            confirm-type="done"
            @confirm="handleRedeem"
          />
          <view
            class="invite-btn"
            :class="{ disabled: inviting }"
            hover-class="invite-btn-hover"
            @tap="handleRedeem"
          >
            <text>{{ inviting ? '兑换中…' : '兑 换' }}</text>
          </view>
        </view>
      </view>

      <!-- 功能入口（我的照片 / 回收站 / 设置） -->
      <view class="menu-card">
        <view class="menu-item" @tap="goMyPhotos">
          <view class="menu-icon">🖼️</view>
          <view class="menu-label">我的照片</view>
          <view class="menu-arrow">›</view>
        </view>
        <view class="menu-item" @tap="handleTrash">
          <view class="menu-icon">🗑️</view>
          <view class="menu-label">回收站</view>
          <view class="menu-arrow">›</view>
        </view>
        <view class="menu-item" @tap="handleSettings">
          <view class="menu-icon">⚙️</view>
          <view class="menu-label">设置</view>
          <view class="menu-arrow">›</view>
        </view>
      </view>
    </template>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'

export default {
  data() {
    return {
      loggedIn: false,
      me: {}, // GET /users/me
      member: null, // GET /member/status
      inviteCode: '',
      inviting: false,
    }
  },
  computed: {
    avatarText() {
      const name = this.me.nickname || 'U'
      return name.charAt(0).toUpperCase()
    },
    stats() {
      return (this.me.stats) || { coordCount: 0, photoCount: 0, likeCount: 0 }
    },
    isMemberActive() {
      return this.member ? this.member.memberStatus === 'active' : false
    },
    memberRemainingDays() {
      return this.member ? Math.max(0, Number(this.member.remainingDays) || 0) : 0
    },
    memberAutoRenew() {
      return !!(this.member && this.member.autoRenew)
    },
    isPhotographer() {
      if (this.me.isPhotographer !== undefined) return !!this.me.isPhotographer
      return !!(this.member && this.member.isPhotographer)
    },
  },
  onShow() {
    if (!memoApi.isLoggedIn()) {
      this.loggedIn = false
      return
    }
    // 从订阅页返回时刷新会员状态
    this.loggedIn = true
    this.loadProfile()
  },
  methods: {
    /* ===== 数据加载 ===== */
    loadProfile() {
      memoApi
        .get('/users/me')
        .then((data) => {
          if (data) this.me = data
        })
        .catch(() => {})
      memoApi
        .get('/member/status')
        .then((data) => {
          if (data) this.member = data
        })
        .catch(() => {})
    },

    /* ===== 邀请码兑换（POST /invite/redeem） ===== */
    handleRedeem() {
      const code = String(this.inviteCode || '').trim()
      if (!code) {
        uni.showToast({ title: '请输入邀请码', icon: 'none' })
        return
      }
      if (this.inviting) return
      this.inviting = true
      uni.showLoading({ title: '兑换中' })
      memoApi
        .post('/invite/redeem', { code })
        .then((data) => {
          uni.hideLoading()
          this.inviting = false
          this.inviteCode = ''
          const days = data && data.remainingDays != null ? data.remainingDays : ''
          uni.showToast({
            title: '兑换成功' + (days ? '，会员剩余 ' + days + ' 天' : ''),
            icon: 'success',
            duration: 2500,
          })
          // 刷新会员状态（兑换即认证摄影师）
          this.loadProfile()
        })
        .catch(() => {
          uni.hideLoading()
          this.inviting = false
        })
    },

    /* ===== 功能入口 ===== */
    goSubscribe() {
      uni.navigateTo({ url: '/pages/subscribe/subscribe' })
    },
    goMyPhotos() {
      uni.switchTab({ url: '/pages/album/album' })
    },
    handleTrash() {
      // 回收站完整功能后续阶段开放
      uni.showToast({ title: '回收站将在后续阶段开放', icon: 'none' })
    },
    handleSettings() {
      uni.showToast({ title: '设置将在后续阶段开放', icon: 'none' })
    },
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
  padding: 24rpx;
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

/* ===== 用户信息卡 ===== */
.user-card {
  display: flex;
  align-items: center;
  background: rgba(250, 243, 231, 0.9);
  border-radius: 32rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  box-shadow: 0 16rpx 60rpx rgba(28, 15, 8, 0.08);
  padding: 36rpx 32rpx;
  margin-bottom: 24rpx;
}
.user-avatar {
  width: 110rpx;
  height: 110rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #f0a040, #d4691c);
  color: #ffffff;
  font-size: 48rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 28rpx;
  flex-shrink: 0;
  overflow: hidden;
}
.user-avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
}
.user-info {
  flex: 1;
  min-width: 0;
}
.user-name-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-bottom: 8rpx;
}
.user-name {
  font-size: 34rpx;
  font-weight: 700;
  color: #1c0f08;
  max-width: 300rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.photographer-badge {
  display: inline-flex;
  align-items: center;
  gap: 4rpx;
  padding: 4rpx 14rpx;
  border-radius: 18rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  color: #ffffff;
  font-size: 20rpx;
  font-weight: 600;
  flex-shrink: 0;
}
.badge-camera {
  font-size: 18rpx;
}
.user-bio {
  font-size: 24rpx;
  color: #6b4423;
  line-height: 1.5;
  margin-bottom: 6rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.user-phone {
  font-size: 22rpx;
  color: #b89070;
}

/* ===== 统计栏（照原型 profile-stats） ===== */
.stats-bar {
  display: flex;
  background: rgba(250, 243, 231, 0.9);
  border: 1px solid rgba(212, 165, 116, 0.35);
  border-radius: 32rpx;
  padding: 28rpx 0;
  margin-bottom: 24rpx;
}
.stat-item {
  flex: 1;
  text-align: center;
}
.stat-num {
  font-size: 36rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 6rpx;
}
.stat-label {
  font-size: 22rpx;
  color: #9b7b5a;
}

/* ===== 会员区块（照原型 member-hero 深色渐变） ===== */
.member-card {
  background: linear-gradient(135deg, #2a1810 0%, #4a2818 50%, #6b3818 100%);
  border-radius: 32rpx;
  padding: 36rpx 32rpx;
  color: #faf5ec;
  margin-bottom: 24rpx;
  position: relative;
  overflow: hidden;
}
.member-card-top {
  display: flex;
  align-items: center;
}
.member-crown {
  width: 88rpx;
  height: 88rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40rpx;
  margin-right: 24rpx;
  box-shadow: 0 8rpx 28rpx rgba(240, 160, 64, 0.4);
  flex-shrink: 0;
}
.member-card-info {
  flex: 1;
  min-width: 0;
}
.member-card-title {
  font-size: 30rpx;
  font-weight: 700;
  margin-bottom: 6rpx;
}
.member-card-desc {
  font-size: 22rpx;
  opacity: 0.75;
}
.member-status-badge {
  padding: 8rpx 20rpx;
  border-radius: 24rpx;
  font-size: 22rpx;
  font-weight: 600;
  background: rgba(240, 160, 64, 0.2);
  color: #f0a040;
  border: 1px solid rgba(240, 160, 64, 0.4);
  flex-shrink: 0;
}
.member-status-badge.active {
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  color: #ffffff;
  border-color: transparent;
}
.member-open-btn {
  padding: 16rpx 28rpx;
  border-radius: 24rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  color: #ffffff;
  font-size: 24rpx;
  font-weight: 600;
  box-shadow: 0 8rpx 24rpx rgba(240, 160, 64, 0.45);
  flex-shrink: 0;
}
.member-open-btn-hover {
  transform: scale(0.96);
  filter: brightness(0.95);
}
.member-auto-renew {
  margin-top: 20rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid rgba(240, 160, 64, 0.25);
  font-size: 22rpx;
  opacity: 0.7;
}

/* ===== 邀请码兑换（照原型 invite-card） ===== */
.invite-card {
  background: linear-gradient(135deg, rgba(240, 160, 64, 0.14) 0%, rgba(212, 105, 28, 0.06) 100%);
  border: 1.5px solid rgba(240, 160, 64, 0.35);
  border-radius: 32rpx;
  padding: 32rpx;
  margin-bottom: 24rpx;
  box-shadow: 0 8rpx 28rpx rgba(28, 15, 8, 0.06);
}
.invite-title {
  display: flex;
  align-items: center;
  gap: 12rpx;
  font-size: 30rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 10rpx;
}
.invite-title-icon {
  font-size: 30rpx;
}
.invite-desc {
  font-size: 24rpx;
  color: #8b5e3c;
  line-height: 1.5;
  margin-bottom: 20rpx;
}
.invite-desc-strong {
  color: #d4691c;
}
.invite-input-row {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}
.invite-input {
  width: 100%;
  box-sizing: border-box;
  height: 88rpx;
  padding: 0 28rpx;
  border: 1.5px solid rgba(212, 165, 116, 0.4);
  border-radius: 20rpx;
  background: #fff5e6;
  font-size: 28rpx;
  font-weight: 600;
  color: #1c0f08;
  letter-spacing: 3rpx;
}
.invite-placeholder {
  color: #b89878;
  font-weight: 400;
  letter-spacing: 1rpx;
}
.invite-btn {
  height: 88rpx;
  border-radius: 20rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  color: #ffffff;
  font-size: 28rpx;
  font-weight: 600;
  letter-spacing: 4rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10rpx 28rpx rgba(240, 160, 64, 0.45);
}
.invite-btn.disabled {
  opacity: 0.6;
}
.invite-btn-hover {
  transform: translateY(2rpx) scale(0.98);
  filter: brightness(0.95);
}

/* ===== 功能入口菜单 ===== */
.menu-card {
  background: rgba(250, 243, 231, 0.9);
  border: 1px solid rgba(212, 165, 116, 0.35);
  border-radius: 32rpx;
  padding: 8rpx 28rpx;
  box-shadow: 0 16rpx 60rpx rgba(28, 15, 8, 0.08);
}
.menu-item {
  display: flex;
  align-items: center;
  padding: 30rpx 0;
}
.menu-item + .menu-item {
  border-top: 1rpx solid rgba(212, 165, 116, 0.25);
}
.menu-icon {
  width: 56rpx;
  height: 56rpx;
  border-radius: 16rpx;
  background: rgba(240, 160, 64, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28rpx;
  margin-right: 20rpx;
}
.menu-label {
  flex: 1;
  font-size: 28rpx;
  color: #1c0f08;
}
.menu-arrow {
  font-size: 36rpx;
  color: rgba(155, 123, 90, 0.6);
}
</style>
