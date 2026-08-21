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
    // 进入联机页即请求相机权限（Android 6.0+ runtime permission），让 WebView 的 getUserMedia 能工作
    this.ensureCameraPermission()
  },
  onShow() {
    this.buildWebSrc()
    uni.$emit('tab-change', 1)
    this.ensureCameraPermission()
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

    // ---------- 相机权限：Android 6.0+ 必须运行时请求，否则 WebView 内 getUserMedia 必失败 ----------
    ensureCameraPermission() {
      // #ifdef APP-PLUS
      if (plus && plus.android) {
        plus.android.requestPermissions(
          ['android.permission.CAMERA'],
          (result) => {
            // granted: 已授权 → 通知 web 层可以调用 getUserMedia
            const granted = result && result.granted && result.granted.length > 0
            if (granted) {
              this.evalWeb("window.__plCameraReady && window.__plCameraReady(true)")
            }
          },
          (err) => {
            console.log('[connect] CAMERA permission denied:', err)
          }
        )
      }
      // #endif
    },

    // ---------- 系统相机拍照（兜底：getUserMedia 不可用时，用系统相机 App 拍照 → base64 回传 web 层） ----------
    takeCameraPhoto() {
      uni.chooseImage({
        count: 1,
        sourceType: ['camera'],
        success: (res) => {
          const filePath = res.tempFilePaths[0]
          if (!filePath) {
            this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto(null)")
            return
          }
          // 读为 base64 回传 web 层（connect-prototype.html 的 __plCameraPhoto 回调）
          uni.getFileSystemManager().readFile({
            filePath: filePath,
            encoding: 'base64',
            success: (readRes) => {
              const base64 = 'data:image/jpeg;base64,' + readRes.data
              this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto('" + base64 + "')")
            },
            fail: () => {
              this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto(null)")
            }
          })
        },
        fail: () => {
          this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto(null)")
        }
      })
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
      // 无障碍未开启：手势注入会无效 → 先引导用户去系统设置开启
      let a11yOn = false
      try { a11yOn = ScreenControl.isAccessibilityEnabled() } catch (e) {}
      if (!a11yOn) {
        uni.showModal({
          title: '需先开启无障碍',
          content: '远程控制手势需要开启「无障碍」服务。点确定跳转系统设置，找到并开启「地图相册」，然后回到本页重试。',
          confirmText: '去开启',
          cancelText: '暂不',
          success: (res) => {
            if (res.confirm) ScreenControl.openAccessibilitySettings()
          },
        })
        return
      }
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
        // 通知 web 层相机权限已就绪（如果已授权）
        this.ensureCameraPermission()
      } else if (msg.type === 'pl_screen_start') {
        this.startScreen()
      } else if (msg.type === 'pl_screen_stop') {
        this.stopScreen()
      } else if (msg.type === 'pl_touch') {
        this.sendTouch(msg.data)
      } else if (msg.type === 'pl_open_accessibility') {
        ScreenControl.openAccessibilitySettings()
      } else if (msg.type === 'pl_camera_permission') {
        // web 层请求相机权限（getUserMedia 失败时触发）
        this.ensureCameraPermission()
      } else if (msg.type === 'pl_camera_photo') {
        // web 层请求系统相机拍照（getUserMedia 不可用时的兜底）
        this.takeCameraPhoto()
      }
    },
  },
}
</script>
