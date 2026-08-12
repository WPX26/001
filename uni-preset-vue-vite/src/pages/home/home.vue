<template>
  <view class="home-page">
    <!-- 未登录：引导页 -->
    <view v-if="!loggedIn" class="login-guide">
      <view class="guide-card">
        <view class="guide-emoji">🗺️</view>
        <view class="guide-title">地图相册</view>
        <view class="guide-sub">登录后查看附近的美好瞬间</view>
        <view class="guide-btn" hover-class="guide-btn-hover" @tap="goLogin">
          <text>去登录</text>
        </view>
      </view>
    </view>

    <!-- 已登录：web-view 嵌入 memo-home.html（token 经 URL query 注入） -->
    <web-view
      v-else
      :src="webSrc"
      @message="handleMessage"
    ></web-view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { MEMO_HOME_URL } from '../../utils/config'

export default {
  data() {
    return {
      loggedIn: false,
      webSrc: '',
    }
  },
  onLoad() {
    if (memoApi.isLoggedIn()) {
      this.loggedIn = true
      this.buildWebSrc()
    } else {
      // 已登录用户直接进首页；未登录引导登录
      this.loggedIn = false
    }
  },
  onShow() {
    // 从登录页返回时刷新登录态与 token
    if (memoApi.isLoggedIn() && !this.loggedIn) {
      this.loggedIn = true
    }
    if (this.loggedIn) this.buildWebSrc()
  },
  onBackPress() {
    // Android 物理返回键：web-view 内部（H5 页面跳转历史）有可回退页时先回退 H5，
    // 否则交给系统默认行为（首页即退出 App），避免返回键直接退出或行为错乱
    // #ifdef APP-PLUS
    try {
      const wv = plus.webview.currentWebview().children()[0]
      if (wv && wv.canBack && wv.canBack()) {
        wv.back()
        return true
      }
    } catch (e) {}
    // #endif
    return false
  },
  methods: {
    buildWebSrc() {
      const token = memoApi.getToken()
      const sep = MEMO_HOME_URL.indexOf('?') >= 0 ? '&' : '?'
      // full=1：memo-home.html 全屏适配开关（无参时页面保持原型手机框展示，不影响 Web 端 UI）
      this.webSrc = MEMO_HOME_URL + sep + 'token=' + encodeURIComponent(token) + '&full=1'
    },
    handleMessage(e) {
      // web-view postMessage 桥接预留（后续登录态变化/跳转场景使用）
      console.log('[web-view] message', e)
    },
    goLogin() {
      uni.reLaunch({ url: '/pages/login/login' })
    },
  },
}
</script>

<style>
.home-page {
  width: 100%;
  height: 100vh;
  background: #fff5e6;
}

.login-guide {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx;
  box-sizing: border-box;
}

.guide-card {
  width: 100%;
  background: rgba(250, 243, 231, 0.9);
  border-radius: 40rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.12);
  padding: 80rpx 48rpx;
  text-align: center;
}

.guide-emoji {
  font-size: 96rpx;
  margin-bottom: 24rpx;
}

.guide-title {
  font-size: 44rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 12rpx;
}

.guide-sub {
  font-size: 26rpx;
  color: #6b4423;
  margin-bottom: 56rpx;
}

.guide-btn {
  height: 96rpx;
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
</style>
