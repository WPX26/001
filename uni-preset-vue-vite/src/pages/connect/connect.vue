<template>
  <view class="tab-page">
  <web-view :src="webSrc" @message="handleMessage" style="width:100%;height:100vh;"></web-view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { CONNECT_URL } from '../../utils/config'
// 屏控 UTS 插件（Android）：MediaProjection 录屏 + 无障碍手势注入
// 桥：web-view 页面 ⇄ uni.postMessage / evalJS ⇄ 本层 ⇄ UTS 插件 ⇄ Android
import * as ScreenControl from '@/uni_modules/uts-screencontrol'

// 联机页：1:1 嵌入原型 connect-prototype.html（手机互联 + 屏控）
export default {
  data() {
    return {
      webSrc: '',
      webReady: false,      // web-view 页面是否已就绪（pl_ready）
      pendingFrames: [],    // web 未就绪前的录屏帧暂存（丢 200ms 前旧帧）
    }
  },
  onLoad() {
    this.buildWebSrc()
  },
  onShow() {
    this.buildWebSrc()
    uni.$emit('tab-change', 1)
  },
  onUnload() {
    this.stopScreen()
  },

  methods: {
    buildWebSrc() {
      const sep = CONNECT_URL.indexOf('?') >= 0 ? '&' : '?'
      const token = memoApi.getToken()
      this.webSrc = CONNECT_URL + (token ? sep + 'token=' + encodeURIComponent(token) + '&full=1' : '?full=1')
    },

    // ---------- App → web-view：evalJS ----------
    getWebview() {
      try {
        // #ifdef APP-PLUS
        const pages = getCurrentPages()
        const page = pages[pages.length - 1]
        if (!page || !page.$getAppWebview) return null
        const wv = page.$getAppWebview().children()[0]
        return wv || null
        // #endif
        // #ifndef APP-PLUS
        return null
        // #endif
      } catch (e) {
        return null
      }
    },
    evalWeb(js) {
      const wv = this.getWebview()
      if (wv && wv.evalJS) {
        try { wv.evalJS(js) } catch (e) {}
      }
    },

    // ---------- 录屏帧：插件 → 网页（网页推 WS 给控制端 B） ----------
    pushFrame(dataUrl) {
      if (this.webReady) {
        this.evalWeb("window.__plScreenFrame && window.__plScreenFrame('" + dataUrl + "')")
      } else {
        this.pendingFrames.push(dataUrl)
        if (this.pendingFrames.length > 20) this.pendingFrames.shift()
      }
    },
    flushPendingFrames() {
      const frames = this.pendingFrames.splice(0)
      const self = this
      frames.forEach(function (f) { self.pushFrame(f) })
    },

    // ---------- 屏控控制 ----------
    startScreen() {
      ScreenControl.startScreenShare((frame) => {
        this.pushFrame(frame)
      }).then((res) => {
        const status = res && res.code === 0
          ? { ok: true, message: '屏幕共享中' }
          : { ok: false, message: (res && res.message) || '启动失败' }
        this.evalWeb("window.__plScreenStatus && window.__plScreenStatus(" + JSON.stringify(status) + ")")
        if (!status.ok) {
          uni.showToast({ title: status.message, icon: 'none', duration: 2500 })
        }
      }).catch(() => {
        this.evalWeb("window.__plScreenStatus && window.__plScreenStatus({ok:false,message:'插件调用失败'})")
      })
    },
    stopScreen() {
      ScreenControl.stopScreenShare()
      this.webReady = false
      this.pendingFrames = []
      this.evalWeb("window.__plScreenStatus && window.__plScreenStatus({ok:false,message:'已停止'})")
    },
    sendTouch(g) {
      ScreenControl.injectGesture(g).then((res) => {
        if (res && res.code !== 0) {
          // 无障碍未开启 → 提示并引导去开启
          uni.showToast({ title: res.message, icon: 'none', duration: 3000 })
        }
      }).catch(() => {})
    },

    handleMessage(e) {
      const msg = e && e.detail && e.detail.data && e.detail.data[0]
      if (!msg || !msg.type) return
      if (msg.type === 'memo_login') {
        memoApi.setAuth(msg.token, msg.user ? JSON.parse(msg.user) : null)
        uni.reLaunch({ url: '/pages/home/home' })
      } else if (msg.type === 'memo_go_login') {
        uni.reLaunch({ url: '/pages/login/login' })
      } else if (msg.type === 'pl_ready') {
        // web 页加载完成，开始补推暂存帧
        this.webReady = true
        this.flushPendingFrames()
      } else if (msg.type === 'pl_screen_start') {
        this.startScreen()
      } else if (msg.type === 'pl_screen_stop') {
        this.stopScreen()
      } else if (msg.type === 'pl_touch') {
        this.sendTouch(msg.data)
      } else if (msg.type === 'pl_open_accessibility') {
        ScreenControl.openAccessibilitySettings()
      }
    },
  },
}
</script>
