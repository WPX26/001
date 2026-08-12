<template>
  <web-view :src="webSrc" @message="handleMessage"></web-view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { ALBUM_URL } from '../../utils/config'

// 相册页：1:1 嵌入原型 album-prototype.html（从我的页进入）
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
  },
  methods: {
    buildWebSrc() {
      const sep = ALBUM_URL.indexOf('?') >= 0 ? '&' : '?'
      const token = memoApi.getToken()
      this.webSrc = ALBUM_URL + (token ? sep + 'token=' + encodeURIComponent(token) + '&full=1' : '?full=1')
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
