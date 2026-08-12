<template>
  <web-view :src="webSrc" @message="handleMessage"></web-view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { REGISTER_URL } from '../../utils/config'

// 注册页：1:1 嵌入原型 register-prototype.html
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
      const sep = REGISTER_URL.indexOf('?') >= 0 ? '&' : '?'
      this.webSrc = REGISTER_URL + sep + 'full=1'
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
