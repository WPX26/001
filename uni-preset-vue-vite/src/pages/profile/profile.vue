<template>
  <view class="page">
    <!-- 登录用户信息卡 -->
    <view class="user-card" v-if="user">
      <view class="user-avatar">{{ avatarText }}</view>
      <view class="user-info">
        <view class="user-name">{{ user.nickname || '未设置昵称' }}</view>
        <view class="user-phone">{{ maskedPhone }}</view>
      </view>
    </view>

    <view class="empty-card">
      <view class="empty-emoji">🧑‍🚀</view>
      <view class="empty-title">我的</view>
      <view class="empty-desc">作品管理、会员权益、设置与更多功能将在这里展示</view>
      <view class="empty-tag">下一阶段对接</view>
    </view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'

export default {
  data() {
    return {
      user: null,
    }
  },
  onShow() {
    this.user = memoApi.getUser()
  },
  computed: {
    avatarText() {
      const name = (this.user && this.user.nickname) || 'U'
      return name.charAt(0).toUpperCase()
    },
    maskedPhone() {
      const phone = (this.user && this.user.phone) || ''
      return phone ? phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : ''
    },
  },
}
</script>

<style>
.page {
  min-height: 100vh;
  background: linear-gradient(165deg, #f8ecd8 0%, #f3dcb4 100%);
  padding: 40rpx;
  box-sizing: border-box;
}

.user-card {
  display: flex;
  align-items: center;
  background: rgba(250, 243, 231, 0.9);
  border-radius: 32rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  box-shadow: 0 16rpx 60rpx rgba(28, 15, 8, 0.08);
  padding: 36rpx 32rpx;
  margin-bottom: 32rpx;
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
}

.user-info {
  flex: 1;
}

.user-name {
  font-size: 34rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 8rpx;
}

.user-phone {
  font-size: 26rpx;
  color: #6b4423;
}

.empty-card {
  background: rgba(250, 243, 231, 0.9);
  border-radius: 40rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.1);
  padding: 100rpx 48rpx;
  text-align: center;
}

.empty-emoji {
  font-size: 100rpx;
  margin-bottom: 28rpx;
}

.empty-title {
  font-size: 40rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 16rpx;
}

.empty-desc {
  font-size: 26rpx;
  color: #6b4423;
  line-height: 1.6;
  margin-bottom: 36rpx;
}

.empty-tag {
  display: inline-block;
  padding: 8rpx 28rpx;
  border-radius: 24rpx;
  font-size: 22rpx;
  color: #e89020;
  background: rgba(232, 144, 32, 0.12);
  border: 1px solid rgba(232, 144, 32, 0.3);
}
</style>
