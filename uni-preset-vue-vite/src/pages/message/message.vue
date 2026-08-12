<template>
  <web-view :src="webSrc" @message="handleMessage" style="width:100%;height:calc(100vh - 160rpx);"></web-view>
  <app-tab-bar />
</template>

<script>
import memoApi from '../../utils/memoApi'
import { MESSAGE_URL } from '../../utils/config'

// 消息页：1:1 嵌入原型 message-prototype.html（full-embed 全屏，导航由 App tabBar 承担）
export default {
  data() {
    return {
      webSrc: '',
    }
  },
  onLoad() {
    this.buildWebSrc()
  },
  onShow() {
    this.buildWebSrc()
    uni.$emit('tab-change', 3)
  },

  onReady() {
    // #ifdef APP-PLUS
    // App 端 web-view 是原生组件，CSS 高度无效（默认全屏盖住自定义 tabBar）
    // 用原生 setStyle 强制留出底部 tabBar 空间
    setTimeout(() => {
      try {
        const pages = getCurrentPages()
        const page = pages[pages.length - 1]
        const wv = page && page.$getAppWebview && page.$getAppWebview().children()[0]
        if (wv && wv.setStyle) {
          const info = uni.getSystemInfoSync()
          const rpx2px = info.windowWidth / 750
          const tabH = 112 * rpx2px + (info.safeAreaInsets ? info.safeAreaInsets.bottom : 0)
          wv.setStyle({ top: 0, left: 0, width: info.windowWidth, height: Math.max(100, info.windowHeight - tabH) })
        }
      } catch (e) {}
    }, 400)
    // #endif
  },

  methods: {
    buildWebSrc() {
      const token = memoApi.getToken()
      const sep = MESSAGE_URL.indexOf('?') >= 0 ? '&' : '?'
      this.webSrc = MESSAGE_URL + (token ? sep + 'token=' + encodeURIComponent(token) + '&full=1' : '?full=1')
    },
    handleMessage(e) {
      const msg = e && e.detail && e.detail.data && e.detail.data[0]
      if (msg && msg.type === 'memo_login') {
        memoApi.setAuth(msg.token, msg.user ? JSON.parse(msg.user) : null)
        uni.reLaunch({ url: '/pages/home/home' })
      } else if (msg && msg.type === 'memo_go_login') {
        uni.reLaunch({ url: '/pages/login/login' })
      }
    },
  },
}
</script>
