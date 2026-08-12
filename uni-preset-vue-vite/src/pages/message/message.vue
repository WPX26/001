<template>
  <web-view :src="webSrc" @message="handleMessage" style="width:100%;height:calc(100vh - 160rpx);"></web-view>
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
