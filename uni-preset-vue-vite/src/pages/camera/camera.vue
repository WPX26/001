<template>
  <view class="page">
    <!-- 占位页：正常入口在自定义 tabBar 中间凸起按钮（拦截点击直调系统相机，不进入本页） -->
    <view class="tip-card">
      <view class="tip-icon">📸</view>
      <view class="tip-title">拍照请点击底部相机按钮</view>
      <view class="tip-desc">将直接调起系统相机拍摄，拍完回到地图挂载坐标</view>
    </view>
  </view>
</template>

<script>
export default {
  onShow() {
    // 本页仅作 tab 路由占位；若被直接打开（深层链接），引导回首页
    setTimeout(() => {
      uni.reLaunch({ url: '/pages/home/home' })
    }, 1200)
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
  padding: 60rpx;
  box-sizing: border-box;
}
.tip-card {
  text-align: center;
  background: rgba(250, 243, 231, 0.9);
  border-radius: 40rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  padding: 80rpx 48rpx;
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.1);
}
.tip-icon {
  font-size: 100rpx;
  margin-bottom: 24rpx;
}
.tip-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 16rpx;
}
.tip-desc {
  font-size: 26rpx;
  color: #6b4423;
  line-height: 1.6;
}
</style>
