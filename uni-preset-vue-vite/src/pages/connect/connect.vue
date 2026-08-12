<template>
  <view class="page">
    <!-- 占位说明：真实相机互联（阶段②a 相机 FTP 直传）暂缓，后续接入 -->
    <view class="hero">
      <view class="hero-icon">📷</view>
      <view class="hero-title">相机联机</view>
      <view class="hero-desc">快门一按，照片实时导入</view>
    </view>

    <view class="status-card">
      <view class="status-row">
        <view class="status-dot"></view>
        <text class="status-text">未连接相机</text>
      </view>
      <view class="status-sub">真实相机互联正在开发中，敬请期待</view>
    </view>

    <view class="feature-list">
      <view class="feature-item">
        <text class="feature-icon">🔌</text>
        <view class="feature-body">
          <text class="feature-title">WiFi 直连</text>
          <text class="feature-desc">相机连接手机热点，照片实时传输</text>
        </view>
      </view>
      <view class="feature-item">
        <text class="feature-icon">⚡</text>
        <view class="feature-body">
          <text class="feature-title">快门即导</text>
          <text class="feature-desc">按下快门，照片自动进入待归类</text>
        </view>
      </view>
      <view class="feature-item">
        <text class="feature-icon">🗂️</text>
        <view class="feature-body">
          <text class="feature-title">原图入库</text>
          <text class="feature-desc">支持 RAW 原图，落应用私有目录</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
export default {
  onShow() {
    uni.$emit('tab-change', 1)
  },
}
</script>

<style>
.page {
  min-height: 100vh;
  background: linear-gradient(165deg, #f8ecd8 0%, #f3dcb4 100%);
  padding: 60rpx 40rpx;
  box-sizing: border-box;
}
.hero {
  text-align: center;
  padding: 80rpx 0 60rpx;
}
.hero-icon {
  font-size: 110rpx;
  margin-bottom: 24rpx;
}
.hero-title {
  font-size: 44rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 12rpx;
}
.hero-desc {
  font-size: 26rpx;
  color: #6b4423;
}
.status-card {
  background: rgba(255, 250, 242, 0.9);
  border: 1px solid rgba(212, 165, 116, 0.3);
  border-radius: 28rpx;
  padding: 32rpx;
  margin-bottom: 40rpx;
  display: flex;
  align-items: center;
  gap: 20rpx;
}
.status-dot {
  width: 18rpx;
  height: 18rpx;
  border-radius: 50%;
  background: #d9c9b2;
  flex-shrink: 0;
}
.status-text {
  font-size: 28rpx;
  font-weight: 600;
  color: #8b5e3c;
}
.status-sub {
  font-size: 22rpx;
  color: #b89070;
  margin-left: auto;
}
.feature-list {
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}
.feature-item {
  display: flex;
  align-items: center;
  gap: 24rpx;
  background: rgba(255, 250, 242, 0.85);
  border: 1px solid rgba(212, 165, 116, 0.15);
  border-radius: 24rpx;
  padding: 28rpx;
}
.feature-icon {
  font-size: 48rpx;
  flex-shrink: 0;
}
.feature-body {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}
.feature-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #1c0f08;
}
.feature-desc {
  font-size: 24rpx;
  color: #8b5e3c;
}
</style>
