<template>
  <view class="page">
    <view class="empty-card">
      <view class="empty-emoji">🖼️</view>
      <view class="empty-title">相册</view>
      <view class="empty-desc">我的照片、收藏与上传记录将在这里展示</view>
      <view class="empty-tag">下一阶段对接</view>
    </view>
  </view>
</template>

<script>
export default {
  data() {
    return {}
  },
}
</script>

<style>
.page {
  min-height: 100vh;
  background: linear-gradient(165deg, #f8ecd8 0%, #f3dcb4 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx;
  box-sizing: border-box;
}

.empty-card {
  width: 100%;
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
