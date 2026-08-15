<template>
  <view class="tab-page">
  <web-view :src="webSrc" @message="handleMessage" style="width:100%;height:100vh;"></web-view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { MEMO_HOME_URL } from '../../utils/config'

// 首页：1:1 嵌入原型 memo-home.html（主地图）
// 登录态由原型自身处理（未登录时原型内跳登录页），登录成功经 postMessage 同步回 App
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
    uni.$emit('tab-change', 0)
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
      let src = MEMO_HOME_URL + sep + 'full=1' + (token ? '&token=' + encodeURIComponent(token) : '')
      // 相机拍完待挂载：URL 带 photo_pending=1，H5 提示用户点地图坐标挂载
      if (uni.getStorageSync('memo_pending_photo')) {
        src += '&photo_pending=1'
      }
      this.webSrc = src
    },
    handleMessage(e) {
      const msg = e && e.detail && e.detail.data && e.detail.data[0]
      if (!msg) return
      // 登录成功：同步 token/user 到 App storage
      if (msg.type === 'memo_login') {
        memoApi.setAuth(msg.token, msg.user ? JSON.parse(msg.user) : null)
        this.buildWebSrc()
        return
      }
      // 注册成功：跳登录页
      if (msg.type === 'memo_go_login') {
        uni.reLaunch({ url: '/pages/login/login' })
        return
      }
      // H5 请求照片（点地图挂载前）：读缩略图 → base64 → evalJS 注入 H5
      if (msg.type === 'memo_get_pending_photo') {
        // #ifdef APP-PLUS
        const pending = uni.getStorageSync('memo_pending_photo')
        if (!pending || !pending.thumb) return
        plus.io.resolveLocalFileSystemURL(
          pending.thumb,
          (entry) => {
            entry.file((file) => {
              const reader = new plus.io.FileReader()
              reader.onloadend = (evt) => {
                const b64 = evt.target && evt.target.result
                if (!b64) return
                const wv = plus.webview.currentWebview().children()[0]
                if (wv && wv.evalJS) {
                  wv.evalJS('window.__memo_pending_photo = ' + JSON.stringify(b64))
                }
              }
              reader.readAsDataURL(file)
            })
          },
          () => {}
        )
        // #endif
      }
    },
  },
}
</script>
