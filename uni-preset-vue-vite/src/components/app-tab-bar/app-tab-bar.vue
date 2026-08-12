<template>
  <view class="tab-bar">
    <view
      v-for="(item, i) in items"
      :key="i"
      class="tab-item"
      :class="{ active: selected === i, center: item.center }"
      @tap="onTap(i)"
    >
      <image
        v-if="!item.center"
        class="tab-icon"
        :src="selected === i ? item.activeIcon : item.icon"
        mode="aspectFit"
      />
      <view v-else class="center-btn">
        <image class="center-icon" src="/static/tabbar/camera-center.png" mode="aspectFit" />
      </view>
      <text v-if="!item.center" class="tab-label">{{ item.text }}</text>
    </view>
  </view>
</template>

<script>
// 自定义 tabBar：首页/联机/[相机凸起]/消息/我（与 H5 原型 5 元素导航一致）
// 选中态通过页面 onShow 里 uni.$emit('tab-change', index) 同步
export default {
  data() {
    return {
      selected: 0,
      items: [
        { path: '/pages/home/home', text: '首页', icon: '/static/tabbar/home.png', activeIcon: '/static/tabbar/home-active.png', center: false },
        { path: '/pages/connect/connect', text: '联机', icon: '/static/tabbar/connect.png', activeIcon: '/static/tabbar/connect-active.png', center: false },
        { path: '', text: '相机', icon: '', activeIcon: '', center: true },
        { path: '/pages/message/message', text: '消息', icon: '/static/tabbar/message.png', activeIcon: '/static/tabbar/message-active.png', center: false },
        { path: '/pages/profile/profile', text: '我', icon: '/static/tabbar/profile.png', activeIcon: '/static/tabbar/profile-active.png', center: false },
      ],
    }
  },
  onLoad() {
    // 同步页面切换（各 tab 页 onShow 会 emit）
    uni.$on('tab-change', (idx) => {
      this.selected = idx
    })
  },
  onUnload() {
    uni.$off('tab-change')
  },
  methods: {
    onTap(i) {
      const item = this.items[i]
      if (item.center) {
        this.takePhoto()
        return
      }
      uni.reLaunch({ url: item.path })
    },
    // 相机：直调系统相机，拍完照片暂存 → 引导去首页地图挂载
    takePhoto() {
      uni.chooseImage({
        count: 1,
        sourceType: ['camera'],
        fail: (err) => {
          // 权限被拒/相机不可用：给用户明确反馈（此前静默无反应）
          uni.showToast({ title: '相机未授权或不可用，请在系统设置中开启', icon: 'none', duration: 2500 })
        },
        success: (res) => {
          if (!res.tempFilePaths || !res.tempFilePaths.length) return
          const file = res.tempFilePaths[0]
          uni.compressImage({
            src: file,
            quality: 70,
            success: (c) => {
              const thumb = c.tempFilePath || file
              // 暂存：原图路径 + 缩略图路径（挂载桥接时转 base64 注入 H5）
              uni.setStorageSync('memo_pending_photo', { file: file, thumb: thumb, time: Date.now() })
              uni.showToast({ title: '照片已拍摄，去地图挂载', icon: 'success' })
              setTimeout(() => {
                uni.reLaunch({ url: '/pages/home/home' })
              }, 600)
            },
            fail: () => {
              uni.setStorageSync('memo_pending_photo', { file: file, thumb: file, time: Date.now() })
              uni.showToast({ title: '照片已拍摄，去地图挂载', icon: 'success' })
              setTimeout(() => {
                uni.reLaunch({ url: '/pages/home/home' })
              }, 600)
            },
          })
        },
      })
    },
  },
}
</script>

<style>
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 112rpx;
  padding-bottom: env(safe-area-inset-bottom);
  background: rgba(250, 243, 231, 0.98);
  border-top: 1px solid rgba(212, 165, 116, 0.25);
  display: flex;
  align-items: center;
  justify-content: space-around;
  box-shadow: 0 -4rpx 24rpx rgba(28, 15, 8, 0.08);
  z-index: 999;
}
.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  padding: 8rpx 0;
  flex: 1;
}
.tab-icon {
  width: 56rpx;
  height: 56rpx;
}
.tab-label {
  font-size: 20rpx;
  color: #9b7b5a;
}
.tab-item.active .tab-label {
  color: #e89020;
}
/* 中间凸起相机按钮 */
.tab-item.center {
  flex: 0 0 112rpx;
}
.center-btn {
  width: 96rpx;
  height: 96rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8rpx 24rpx rgba(232, 144, 32, 0.5), inset 0 2rpx 0 rgba(255, 233, 184, 0.4);
  transform: translateY(-16rpx);
}
.center-icon {
  width: 48rpx;
  height: 48rpx;
}
</style>
