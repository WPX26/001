<template>
  <view class="tab-bar">
    <view
      v-for="(item, i) in items"
      :key="i"
      class="tab-item"
      :class="{ active: selected === i, center: item.center }"
      @tap="onTap(i)"
    >
      <image
        v-if="!item.center"
        class="tab-icon"
        :src="selected === i ? item.activeIcon : item.icon"
        mode="aspectFit"
      />
      <view v-else class="center-btn">
        <image class="center-icon" src="data:image/png;base64,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" mode="aspectFit" />
      </view>
      <text v-if="!item.center" class="tab-label">{{ item.text }}</text>
    </view>
  </view>
</template>

<script>
// 自定义 tabBar：首页/联机/[相机凸起]/消息/我（与 H5 原型 5 元素导航一致）
// 选中态通过页面 onShow 里 uni.$emit('tab-change', index) 同步
export default {
  data() {
    return {
      selected: 0,
      items: [
        { path: '/pages/home/home', text: '首页', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAAD/UlEQVR4nOycT2sTQRTA30wq9OChR48peC149FJMP4DiUYPQFKzgN5BWsAVb/AZCKzSCtN7Fc1P07kGPQuPNo3eTHedtGltKdvft5M2ftO93acluZpNf3pt92cxbDcLUaBCmRiQyMAcJs7/RfoV/DcCvZ7uHXUgUBQny9sWj5lxDn158zL7Q/t9htvL8zcc+JEZy6by30e5cFojYaGzeaOjjcXSmRAMS4t1m+8CG3FbJLgt2e+vB8hJ8+vL9BBIhiXQepa86sC+nRX1OSukdPRL3Xz5paQXfrJYm1GOhodXD+8tLC7GjMqrE0fxmuuBOEukdJZ1d0reKmOkd/Ox8Xr5QBJreYJgtoqDKPc/O3jg+BCaoxKLyZRJWXHd95yiPLIwwa2mr6jmxyqBg6Yzli32THdLOSq+sv/7Qu/xwLkdVy8yx0td3D7chAN4l1pn/MG2N0muTBF4cD6MNow4I44WYJ71KxPIFTHZM29v0MH0pe+YfjNarlKjMPxhjpwaPUemtxKlVvuSpd7QGRD5//fEHSxosbbDEqdjdexnEHonc6Us5Xuz0ZpU46epLMfT0pRw3pki2EselfAEmYpdBLJHIUb5wEaMMmkpi6PmvzusKmd7OEn2VL1yELIOcShyf5QsXIcugWpGYavpW4Tu9yRJjlS9c+BRJKnFili9c+CyDKiMxpfKFC+4yqFQiVWBK8x+VmundfbpzWHhyLE1nWgSanj3A4iwJRGqmd6dse2EkkurAgBc+fUJK75Kpyum7c/6bBw56BQQi+D6ov+VMwkliXt3PWPpWgemN7wsckKV1DIhEBkQiAyKRgeArZbF0UiZbtf+2gBkDpj8YmrXQS0mCShzXngZ8ofAq06n9NrIYUmTYdDbDIMs7RpfrwhE4nflWgaVxnBFyYmFAJDKQTB+L6/dWyqUs3yQiES+n1b8avr/5+NhhrTc7ks4MiEQGRCIDIpEBkciASGRAJDIgEhkQiQyIRAZEIgMikQGRyIBIZEAkMiASGRCJDIhEBkQiAyKRAZHIgEhkQCQyUChxMBj0i7aBMi24gihVvBCgzEehxNHSNNObeDBQzRh3QvJNWb9K2VI9pxUQ4963vY32ttK6Xxq1JNS824ei5ou21BkP+6JtFHaK1k1iR1Xp88s2GqPeq4JeYRRptx2AyWCuMfXUepfewUqj7nhlC08zA6U90JUNkmfrXVpwbaluO64MIVwDDdcYyvuvlHjWaXQ9RSpNahwnTWZ4j+tpet9mjf+9i8TWu/r3gCDe4WNmceicdbqly7h8aGiNN9W9BzWxZ8I79sA3M4DfNhV+wpTYcW7bcW65jGenqn7+j9Ynrk2fzvfFEc6R784MiEQG/gEAAP//8coXwQAAAAZJREFUAwB2ZQiInZAc/wAAAABJRU5ErkJggg==', activeIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAADfUlEQVR4nOycS3ITMRCGW1MsWLAn2U2qOABLdgwniXMCwgkIJyCcIOYkOPegCrFKuMQIaTyGlGM959cjcX+buDyvzGe11B631BGzmI6YxbBEAC+oYe6+9Z+nFyP9Pv0k19Qoghrk7mvfC0G/9t6WStEHLVNSYzQXzlrg6oBAgxH741/rbIimWuKf6/5GEa18+ylBV6cf5RdqhCYkzuF7o18OEYc1E97VJWqBgwlTSkPqVrmu3Sqr9ommf1sg0NALRVe1+8kqLTExfH1UC+/iLfFB+jIE7L7RYs70Xxmw73b01uenwhSV6EhfHqFDZH1yKaeWZVqYGZEDDquSBhUL59D0xTCH5Wb//akPVUEyi6ZB2SVG9n+m1V0cErh3PjMY9RR2vuz9ZFaJkenLxoRvyI5Tv9fReWCrzJ4GZZNYIvRaCW+4RHT4Bl6vanhDJVqevtgIDt/A61YTCUtxUtIXAlE7DYK0RET6gqJGP7lIYun+L5TS4Z0sMVf6gqJkGpQksdVvDoco8b9GSWw1fH3kDu9gibXSFxQ5RQalODXTFxQ50yBvS2wpfUGB7iedEiMENtP/hRIT3ia6Xl/KC8d2O/fXvSI/zfV/ocSkQfoera6E4wLePLC1339TCQlvV1eV+t15O3o9A4EGcx8Rv+U8IknilN0/of4vhGn01vdFCXBpHQCWCIAlAmCJAIpXyprUqRN0rrAlJDt2Sb+kghSVuMs9QzL4RKaHJPo6ZyVFFg1nfYNFyjvmx3XFKB3OA5VhoILwwAKAJQJoaR6LpDR6qkwrEpMep+lHdaGP+7PC4QyAJQJgiQBYIgCWCIAlAmCJAFgiAJYIgCUCYIkAWCIAlgiAJQJgiQBYIgCWCIAlAmCJAFgiAJYIgCUCYIkAXBKlbYNQZWtdStEp52/Y0nqcbcNcmraxbO5rrISUG9fEJ1epXmoFxG5JKTMFQ1J6CcgWQS+TPhR9HFmKHaPOt50QtLJfxj2rwClRKfquZQ2WzT2sDlDRu4gZrA+PsxJ1Pk/V6ajo1rXdO0FyrncZ6Hjx1gl5R2dTA01HTMj9eyXO84SPUmToxPGgPNGscb1k7puP1EL4jAX0MmbudvQaEBErfDxJUmbOpq1G8j99MHNS3lMkugW9FSRejTTedyR+0kJGUm866k5SzjeKObpGuk2d9LlocSFmC393BsASAfwFAAD///hCm/EAAAAGSURBVAMA+bXXMGY5bcwAAAAASUVORK5CYII=', center: false },
        { path: '/pages/connect/connect', text: '联机', icon: 'data:image/png;base64,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', activeIcon: 'data:image/png;base64,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', center: false },
        { path: '', text: '相机', icon: '', activeIcon: '', center: true },
        { path: '/pages/message/message', text: '消息', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAACrUlEQVR4nOzcTW4TMRjG8dfO9B5zA45AcgD2CCGVSg0SN0AIqa1EK27AoguyQJQ9B2DKDeAEuUeTuPNO2qgfseOMn0qp/fw2repMlPzrTGYSeaxQMiuUjBEBGBGAEQEYEaCSRN8+vq6rqqrlGRt/+dFIAiNb6qJZuy/GDdvNh5KBNsL05tfmar44+fD113TL7eOdf3pz1G5xLBnToM7JZHz282SLbTbrZt/AfM9l5sXQmO2sHMXMyqg3ltICKidS7w3sn5jbbozYvYQLC3hLQy6ff9ggNHj++e2wvauJFMwYqV+9fPHv99//U99tgoc4xi32XWj8Zicsz5hGcuJq36tNZ6O4uc7Gxncfm44Th94RY0eHicdXu6R71blF1D7woeA+sfsvrNHOwMk4o4Bq+Xxcs27MiKlD23ojLveHhXGmWftnfYMJ9Oh12tfuB6dCK/wAAoARARgRgBEBGBGAEQEYEYARARgRgBEBGBGAEQEYEYARARgRgBEBGBGAEQEYEYARARgRgBEBGBGAEQEYEYARARgRgBEBGBGAEQEYEYARARgRgBHv0JUEvrHZbDb1jSWvMs3M0DcQWp5WfERdt6g/deldaLVE6D6eJKI+sL2BPWof1DvJwMLJZWgcHvF2UY2TXLjm/dnFJHQLaMSUVUk7yww2rnuGRcwyoJPj8enmlWOQiLkF7BZ+GnsQE1AlR8xvBrrm8PRitM0WSRHjA65feLgzdE2ftZd9F332jhgd0NhRbitSH+p32qeXc2HAlZ4zMeKaEIUEVE9z2ldQQIWPWFhAhY1YYECFi1hoQIWJWHBAlR6x8IAqLSIDdrwH26HvFDoMuOKNuPxOwXPOy4D3BE/7ZnN3cDdkd8VLBnwk/iKUVVUz3npbX1OWHuOX9wCMCMCIAIwIwIgA1wAAAP//ctpbLgAAAAZJREFUAwD8v9a50Q8S7QAAAABJRU5ErkJggg==', activeIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAACZ0lEQVR4nOzc0U3DMBSF4euIIeibRwmTABNQJgAmQExAN8Fs4je2qPElqQCROE58kMA+/wMIkhb6NUmbVredsOI6YcURERARAREREBEBnUlhb4/Wxm9W/nG7W++kICMr+0Dr5NIE6eOPvdSR1y8Rwx2DPERUv+bCqxDfnuxdxLuXuvPByGF34x9yL5CFqFufMfIs9Wx5OfkQ5CJnq8x6YGkQUNMN5yVnxUVE3YWlPcBTdrz9yZK7c9yN+9x7o+J0t75OPYInn+J0Ri6DLPyBeBCWf1wXxIbhKVo/s4ru1ro1urnrSCKGxG48HnSdVFLJXrd0TLRTv4zHgENNgNp4e9zMYiuJZhH1npHGiocmN7PIpjw2nfYdzfAMnw3xBQhARAREREBEBEREQEQERERARAREREBEBEREQEQERERARAREREBEBEREQEQERERARAREREBEBEREQEQERERARAREREBEBEREQEQERERARAREREBE/JJOEiQW+7kFxVOmNZWalkiNpzWPOI4an0bv7NQ6Oi2Ruo5fQdR/rDNyF+/ZK6mgY5DX1HI44mmoJkg1ubgrH1IrQBFrnAUMQRbnnmGIVQIaud/tlyfHIIgVAg6Tpfu80TvEB2nUBujO9/5izQWKEFcAOvnDfcz0HeV169DnZsRcwNpGeqfadNqnH+dCwM+2bon90gqtAGq/csbSEqAGR2wNUIMitgiowRBbBdQgiC0DasWIrQNqRYgEHEoh+sQyAn5p9oxlfE/BTS0j4PeSp336cpB8h/QE/Fn2h1DGb5Z4063+TFn2M755D4iIgIgIiIiAiAjoHQAA//8/Sd7bAAAABklEQVQDADTFyz63IEMdAAAAAElFTkSuQmCC', center: false },
        { path: '/pages/profile/profile', text: '我', icon: 'data:image/png;base64,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', activeIcon: 'data:image/png;base64,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', center: false },
      ],
    }
  },
  onLoad() {
    // 同步页面切换（各 tab 页 onShow 会 emit）
    uni.$on('tab-change', (idx) => {
      this.selected = idx
    })
  },
  onUnload() {
    uni.$off('tab-change')
  },
  methods: {
    onTap(i) {
      const item = this.items[i]
      if (item.center) {
        this.takePhoto()
        return
      }
      uni.reLaunch({ url: item.path })
    },
    // 相机：直调系统相机，拍完照片暂存 → 引导去首页地图挂载
    takePhoto() {
      uni.chooseImage({
        count: 1,
        sourceType: ['camera'],
        fail: (err) => {
          // 权限被拒/相机不可用：给用户明确反馈（此前静默无反应）
          uni.showToast({ title: '相机未授权或不可用，请在系统设置中开启', icon: 'none', duration: 2500 })
        },
        success: (res) => {
          if (!res.tempFilePaths || !res.tempFilePaths.length) return
          const file = res.tempFilePaths[0]
          uni.compressImage({
            src: file,
            quality: 70,
            success: (c) => {
              const thumb = c.tempFilePath || file
              // 暂存：原图路径 + 缩略图路径（挂载桥接时转 base64 注入 H5）
              uni.setStorageSync('memo_pending_photo', { file: file, thumb: thumb, time: Date.now() })
              uni.showToast({ title: '照片已拍摄，去地图挂载', icon: 'success' })
              setTimeout(() => {
                uni.reLaunch({ url: '/pages/home/home' })
              }, 600)
            },
            fail: () => {
              uni.setStorageSync('memo_pending_photo', { file: file, thumb: file, time: Date.now() })
              uni.showToast({ title: '照片已拍摄，去地图挂载', icon: 'success' })
              setTimeout(() => {
                uni.reLaunch({ url: '/pages/home/home' })
              }, 600)
            },
          })
        },
      })
    },
  },
}
</script>

<style>
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 112rpx;
  padding-bottom: env(safe-area-inset-bottom);
  background: rgba(250, 243, 231, 0.98);
  border-top: 1px solid rgba(212, 165, 116, 0.25);
  display: flex;
  align-items: center;
  justify-content: space-around;
  box-shadow: 0 -4rpx 24rpx rgba(28, 15, 8, 0.08);
  z-index: 999;
}
.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  padding: 8rpx 0;
  flex: 1;
}
.tab-icon {
  width: 56rpx;
  height: 56rpx;
}
.tab-label {
  font-size: 20rpx;
  color: #9b7b5a;
}
.tab-item.active .tab-label {
  color: #e89020;
}
/* 中间凸起相机按钮 */
.tab-item.center {
  flex: 0 0 112rpx;
}
.center-btn {
  width: 96rpx;
  height: 96rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8rpx 24rpx rgba(232, 144, 32, 0.5), inset 0 2rpx 0 rgba(255, 233, 184, 0.4);
  transform: translateY(-16rpx);
}
.center-icon {
  width: 48rpx;
  height: 48rpx;
}
</style>
