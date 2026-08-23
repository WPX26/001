<template>
  <view class="tab-page">
  <web-view :src="webSrc" @message="handleMessage" style="width:100%;height:100vh;"></web-view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'
import { CONNECT_URL } from '../../utils/config'
import webviewBack from '../../utils/webview-back'
// 屏控 UTS 插件（Android）：MediaProjection 录屏 + 无障碍手势注入
// 桥：web-view 页面 ⇄ uni.postMessage / evalJS ⇄ 本层 ⇄ UTS 插件 ⇄ Android
import * as ScreenControl from '@/uni_modules/uts-screencontrol'
// 相机USB直连 UTS 插件（Android）：USB Host bulk/interrupt 传输（协议栈在 web 页 camera-ptp.js）
// 桥：web-view 页面(bridge-transport.js) ⇄ uni.postMessage/evalJS ⇄ 本层 ⇄ UTS ⇄ Android USB
import * as UtsUsb from '@/uni_modules/uts-usb-camera'

// 联机页：1:1 嵌入原型 connect-prototype.html（手机互联 + 屏控）
export default {
  mixins: [webviewBack],
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
    // 显式告知页面「当前在 App 内」：App→页面 evalJS 方向可靠，不依赖 uni 桥注入时序
    this.forceAppMode()
  },
  onShow() {
    this.buildWebSrc()
    uni.$emit('tab-change', 1)
    this.ensureCameraPermission()
    this.forceAppMode()
  },
  onUnload() {
    this.stopScreen()
    // 释放 USB 直连（相机 CloseSession 由 web 页协议层负责，这里兜底关原生连接）
    try { UtsUsb.release() } catch (e) {}
  },

  methods: {
    buildWebSrc() {
      const sep = CONNECT_URL.indexOf('?') >= 0 ? '&' : '?'
      const token = memoApi.getToken()
      // 加时间戳破坏 WebView 缓存：每次 onLoad/onShow 都强制加载最新页面
      const cacheBuster = '_t=' + Date.now()
      this.webSrc = CONNECT_URL + (token ? sep + 'token=' + encodeURIComponent(token) + '&full=1&' + cacheBuster : '?full=1&' + cacheBuster)
    },

    // ---------- 显式声明 App 模式：重复探测直至页面加载完成（页面侧 __plSetAppMode 会启用 App UI 与系统相机兜底） ----------
    forceAppMode() {
      for (let i = 1; i <= 8; i++) {
        setTimeout(() => {
          this.evalWeb("window.__plSetAppMode && window.__plSetAppMode(true)")
          // r70：USB 桥安装通知（页面 bridge-transport.js 的 uni 桥注入晚时由这里兜底触发安装）
          this.evalWeb("window.__usbAppBridgeReady && window.__usbAppBridgeReady()")
        }, i * 500)
      }
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
    // 读照片为 base64：优先 uni.getFileSystemManager（App 端可能缺失），回退 plus.io
    readPhotoBase64(filePath) {
      const send = (base64) => {
        if (base64) {
          this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto('" + base64 + "')")
        } else {
          this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto(null)")
        }
      }
      if (uni.getFileSystemManager) {
        uni.getFileSystemManager().readFile({
          filePath: filePath,
          encoding: 'base64',
          success: (readRes) => send('data:image/jpeg;base64,' + readRes.data),
          fail: () => { this.readPhotoViaPlus(filePath, send) }
        })
      } else if (typeof plus !== 'undefined' && plus.io) {
        this.readPhotoViaPlus(filePath, send)
      } else {
        send(null)
      }
    },
    readPhotoViaPlus(filePath, send) {
      try {
        plus.io.resolveLocalFileSystemURL(filePath, (entry) => {
          entry.file((file) => {
            const reader = new plus.io.FileReader()
            reader.onloadend = (evt) => {
              const r = evt.target && evt.target.result
              if (!r) return send(null)
              send(r.indexOf('base64,') >= 0 ? r : 'data:image/jpeg;base64,' + r)
            }
            reader.onerror = () => send(null)
            reader.readAsDataURL(file)
          }, () => send(null))
        }, () => send(null))
      } catch (e) {
        send(null)
      }
    },
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
          this.readPhotoBase64(filePath)
        },
        fail: () => {
          this.evalWeb("window.__plCameraPhoto && window.__plCameraPhoto(null)")
        }
      })
    },

    // ---------- App → web-view：evalJS ----------
    getWebview() {
      // #ifdef APP-PLUS
      try {
        // 策略1：当前页面 webview 自身（当 <web-view> 是根元素时，页面 webview 就是目标）
        const pages = getCurrentPages()
        const page = pages[pages.length - 1]
        if (page && page.$getAppWebview) {
          const appWv = (typeof page.$getAppWebview === 'function') ? page.$getAppWebview() : page.$getAppWebview
          if (appWv && typeof appWv.evalJS === 'function') {
            try { if (appWv.getURL && appWv.getURL().indexOf('connect-prototype') >= 0) return appWv } catch (e) {}
          }
          // 策略2：子视图（<web-view> 作为页面子元素时）
          if (appWv && appWv.children) {
            const children = appWv.children()
            if (children && children.length) {
              for (const c of children) {
                if (c && typeof c.evalJS === 'function') return c
              }
              if (children[0] && typeof children[0].evalJS === 'function') return children[0]
            }
          }
        }
        // 策略3：遍历所有 webview（find by URL 匹配联机页）
        if (plus.webview && plus.webview.all) {
          const all = plus.webview.all()
          for (const wv of all) {
            if (wv && typeof wv.evalJS === 'function') {
              try { if (wv.getURL && wv.getURL().indexOf('connect-prototype') >= 0) return wv } catch (e) {}
            }
          }
          // 策略4：任意带 evalJS 的 webview（最后兜底）
          for (const wv of all) {
            if (wv && typeof wv.evalJS === 'function') return wv
          }
        }
      } catch (e) {}
      // #endif
      return null
    },
    evalWeb(js) {
      const wv = this._usbWebview || this.getWebview()
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
      // 缓存 webview 引用（@message 事件携带目标 webview 的引用）
      if (!this._usbWebview) {
        try {
          if (e && e.target && e.target.evalJS) {
            this._usbWebview = e.target
          }
        } catch (e2) {}
      }
      // 兼容两种数据格式：{detail:{data:[...]}} 或 {detail:{data:{...}}}
      const raw = e && e.detail && e.detail.data
      const msg = Array.isArray(raw) ? raw[0] : raw
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
      } else if (msg.type === 'usb') {
        // web 层 USB 桥命令（bridge-transport.js 的 rpc）: {id, op, args}
        this.handleUsb(msg)
      }
    },

    // ---------- USB 桥：web-view(bridge-transport.js) -> UTS(uts-usb-camera) ----------
    // 命令按 msgId 关联，结果 evalJS 回推 window.__usbBridge.__resolve({id,ok,result})；
    // 中断事件由 App 侧常驻回调 evalJS 主动推 __usbBridge.__interrupt(base64)。
    handleUsb(msg) {
      const self = this
      const d = msg && msg.args ? msg.args : {}
      const id = msg.id
      const reply = (ok, result) => {
        let payload
        try {
          payload = JSON.stringify({ id: id, ok: !!ok, result: result === undefined ? null : result })
        } catch (e) {
          payload = JSON.stringify({ id: id, ok: false, result: { message: '结果序列化失败' } })
        }
        this.evalWeb("window.__usbBridge && window.__usbBridge.__resolve(" + payload + ")")
      }
      try {
        if (msg.op === 'scan') {
          UtsUsb.listDevices().then((s) => reply(true, s)).catch((e) => reply(false, { message: String(e) }))
        } else if (msg.op === 'connect') {
          UtsUsb.connect(d.deviceId || '', d.iface || 0).then((s) => {
            // 连接成功：挂中断回调（相机 ObjectAdded 0x4002 事件 -> 页面协议层）
            if (s && s.indexOf('"ok":true') >= 0) {
              UtsUsb.setInterruptHandler((b64) => {
                self.evalWeb("window.__usbBridge && window.__usbBridge.__interrupt('" + b64 + "')")
              })
            }
            reply(true, s)
          }).catch((e) => reply(false, { message: String(e) }))
        } else if (msg.op === 'out') {
          UtsUsb.bulkOut(d.data || '', d.timeout || 4000)
            .then((n) => reply(true, n)).catch((e) => reply(false, { message: String(e) }))
        } else if (msg.op === 'in') {
          UtsUsb.bulkIn(d.maxLen || 16384, d.timeout || 20000)
            .then((s) => reply(true, s)).catch((e) => reply(false, { message: String(e) }))
        } else if (msg.op === 'clear') {
          UtsUsb.clearPipe().then((b) => reply(true, b)).catch((e) => reply(false, { message: String(e) }))
        } else if (msg.op === 'release') {
          UtsUsb.release()
          reply(true, true)
        } else if (msg.op === 'diag') {
          reply(true, UtsUsb.diag())
        } else {
          reply(false, { message: '未知 op: ' + msg.op })
        }
      } catch (e) {
        reply(false, { message: String(e) })
      }
    },
  },
}
</script>
