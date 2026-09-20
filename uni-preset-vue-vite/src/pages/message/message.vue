<template>
  <view class="tab-page">
    <chat-native v-if="MESSAGE_MODE === 'app'" />
    <web-view v-else :src="webSrc" @message="handleMessage" style="width:100%;height:100vh;"></web-view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { MESSAGE_URL, MESSAGE_MODE } from '../../utils/config'
import webviewBack from '../../utils/webview-back'
import chatNative from './chat-native.vue'

// 消息页双轨：MESSAGE_MODE='demo' → 1:1 嵌入原型 message-prototype.html（tabBar 承担导航）
//             MESSAGE_MODE='app'  → 原生 uni-app 聊天页 chat-native.vue（应用版）
export default {
  components: { chatNative },
  mixins: [webviewBack],
  data() {
    return {
      MESSAGE_MODE,
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
