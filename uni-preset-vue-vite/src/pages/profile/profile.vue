<template>
  <web-view :src="webSrc" @message="handleMessage" style="width:100%;height:calc(100vh - 160rpx);"></web-view>
  <custom-tab-bar />
</template>

<script>
import memoApi from '../../utils/memoApi'
import { PROFILE_URL } from '../../utils/config'

// 我的页：1:1 嵌入原型 profile-prototype.html
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
    uni.$emit('tab-change', 4)
  },
  methods: {
    buildWebSrc() {
      const sep = PROFILE_URL.indexOf('?') >= 0 ? '&' : '?'
      const token = memoApi.getToken()
      this.webSrc = PROFILE_URL + (token ? sep + 'token=' + encodeURIComponent(token) + '&full=1' : '?full=1')
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
