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
        <image class="center-icon" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAABTUlEQVR4nO2bUY7CMAwFY8T9r2zEfu0HQrV5qZN45gBBHp5rl9IxAAAAAAAAVsVmHu7uPhbBzKbV+ph1cCeQKACJApAowE4cIncPG5IoAIkCkCgAiQKQKOA5DrsF84ItgSQKQKIA67hkqy8x1l2eQmaqnU8VmK0tLPFkgdkaQxI7CMzUynQWcFlipxRGayaJApAoAIkCkLjqrzgW3Pp/GVqZOwz1kCxPov9Y0ApbQ6lEFwmoFlkm0cWFV4osb+cTKJHok1JTlUaSuKNEn5wWHlRtSskj08wiXb3GfINrogAknt7OvnAL/4ck7ijRJv4P547zP0ESd5Vok9JSkcI3JHFniSZOTVUK/z77tHVDzZUvh3YWgEQBSBSAxDslVk6/Kq7WTBIFhCR2SqMFag0nsYNIC9aYaueTRVqiNt5jaRAMAAAAAAAAAAAAGMvwApnpdF0qZCcaAAAAAElFTkSuQmCC" mode="aspectFit" />
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
        { path: '/pages/home/home', text: '首页', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAABpUlEQVR4Ae3By5FbQQhA0QvlKNkTRa+JovekiRNwlUfi/aThHMYYY4wxxvgH4Yf2suKX8UjhB4QX7GXFL+GRwg8JL9rLii/nkcILhDfsZcWX8kjhRcKb9rLiy3ik8AahYS8rvoRHCm8Smvay4sN5pNAgHGAvKz6URwpNwkH2suLDeKRwAOFAe1nxITxSOIhwsL2seDiPFA4knGAvKx7KI4WDCSfZy4qH8UjhBMKJ9rLiITxSOIky2oST7WXFzTxSOJFwgb2suIlHCicTLrKXFRfzSOECwoX2suIiHilcRLjYXlaczCOFCwk32MuKk3ikcDHhJntZcTCPFG4g3GgvKw7ikcJNhJvtZUWTRwo3Eh5gLyve5JHCzYSH2MuKF3mk8ADCg+xlxQ95pPAQwsPsZcV/eKTwIMKb9rLiy3ik8AZltCmjTRltymhTRpsy2pTRpow2ZbQpo00ZbcpoU0bbHx7AI4U37WXFzZTRpow2ZbQpo00ZbcpoU0abMtqU0aaMNmW0KaNNGW3KaFNGmzLalNGmjDZltCmjTRltyhhjjDHGGOMUfwF/wnRpQCFTGAAAAABJRU5ErkJggg==', activeIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAABpUlEQVR4Ae3By5FbQQhA0QvlIFgSYodCiL0kC5yAqzwS7ycN5zDGGGOMMcY/CD+U4cUvY2sLPyC8IMOLX8LWFn5IeFGGF1/O1hZeILwhw4svZWsLLxLelOHFl7G1hTcIDRlefAlbW3iT0JThxYeztYUG4QAZXnwoW1toEg6S4cWHsbWFAwgHyvDiQ9jawkGEg2V48XC2tnAg4QQZXjyUrS0cTDhJhhcPY2sLJxBOlOHFQ9jawkmU0SacLMOLm9nawomEC2R4cRNbWziZcJEMLy5mawsXEC6U4cVFbG3hIsLFMrw4ma0tXEi4QYYXJ7G1hYsJN8nw4mC2tnAD4UYZXhzE1hZuItwsw4smW1u4kfAAGV68ydYWbiY8RIYXL7K1hQcQHiTDix+ytYWHEB4mw4v/sLWFBxHelOHFl7G1hTcoo00ZbcpoU0abMtqU0aaMNmW0KaNNGW3KaFNGmzLa/vAAtrbwpgwvbqaMNmW0KaNNGW3KaFNGmzLalNGmjDZltCmjTRltymhTRpsy2pTRpow2ZbQpo00ZbcpoU8YYY4wxxhin+AvmQHRpV4qWPgAAAABJRU5ErkJggg==', center: false },
        { path: '/pages/connect/connect', text: '联机', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAAB6klEQVR4nO2cQXLDIAxFcY7ZPafoOqf4+1yznS4808k4iYW+AYn/trEz5FkYkCClCCGEEGIutrIA+P76efVZvT/cDrZV5TFl3kpSYBDYcn16iWgU0npfuu6MFyKOuqvl2mUk4kDKGSGt96XuzlYR3hE6tcRepJGIpy5pja7n6y2DTBqJI5FEApJIQBIJSCKBFBJxMJJ6185LTbbhSBywuEWWhw8Czwr2Pohwa2c0/mAlIMo5ebsoT2S1rKNDRCI+SLFEmfV7wktEgzzL/ZbvCicRTnll9UIVyAJ7ME2DEFDeDqVhcHSXyPJ2XA30vLhhmLLMTnMjPVMIJIi+/2wzrVdrMHk724i6bhZ5O9uoum4Wge4sjqeuW++PLYNAk0T2exAT5AGHR6K3rpuJsEnZmZBEApJIQBJHSuy5nTeNRPboWhON1q7u7ClJ4kTJMwpaOxNQFoeA8okElNkmoBoLgWmmGQhcMpiuYQgoc7plXyVuDenFdE/1iqhcbhsJU+bSG5qOsBb7tbXOGZXa5HkSqyhtN7548Fn+vHN9I0nnnQ1cMQHXUd3Sty4+3YolIpJIQBIJSCKBtBKhv7myM7IunjYS/9BR3Ub0X2EkemdxUnbn2vh+bL0vpcTey74wmW0P2Y+ACCGEEKI88Qv/GU1X7AWG7QAAAABJRU5ErkJggg==', activeIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAAB6klEQVR4nO2cQXLDIAxFcU7BskfMUXrELP8t2unCM52Mk1joG5D4bxs7Q56FAQlSihBCCCHmYisLgO+vn1ef1fvD7WBbVR5T5q0kBQaBLdenl4hGIa33pevOeCHiqLtarl1GIg6knBHSel/q7mwV4R2hU0vsRRqJeOqS1uh6vt4yyKSROBJJJCCJBCSRgCQSSCERByOpd+281GQbjsQBi1tkefgg8Kxg74MIt3ZG4w9WAqKck7eL8kRWyzo6RCTigxRLlFm/J7xENMiz3G/5rnAS4ZRXVi9UgSywB9M0CAHl7VAaBkd3iSxvx9VAz4sbhinL7DQ30jOFQILo+88203q1BpO3s42o62aRt7ONqutmEejO4njquvX+2DIINElkvwcxQR5weCR667qZCJuUnQlJJCCJBCRxpMSe23nTSGSPrjXRaO3qzp6SJE6UPKOgtTMBZXEIKJ9IQJltAqqxEJhmmoHAJYPpGoaAMqdb9lXi1pBeTPdUr4jK5baRMGUuvaHpCGuxX1vrnFGpTZ4nsYrSduOLB5/lzzvXN5J03tnAFRNwHdUtfevi061YIiKJBCSRgCQSSCsR+psrOyPr4mkj8Q8d1W1E/xVGoncWJ2V3ro3vx9b7UkrsvewLk9n2kP0IiBBCCCHKE78giE2n+Fy6CgAAAABJRU5ErkJggg==', center: false },
        { path: '', text: '相机', icon: '', activeIcon: '', center: true },
        { path: '/pages/message/message', text: '消息', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAAA8ElEQVR4Ae3BwW3EMBRDQX6Wqbuq0FlV6K42lQ4C21wgiPfNCAAAAAAA/Kr0IWu0o3+mz136gFJgjXb0En3u0kOlB9ZoRy/V5y7dVLppjXb0cn3u0g0WYqUb1mhHX6LPXbrIQsxCrHTRGu3oy/S5SxdYiFmIWYhZiFmIWYhZiFmIWYhZiFmIWYhZiFmIWYhZiFmIWYhZiFmIWYhZiFmIWYhZiFmIWYhZiJVuWKMdfYk+d+kiCzELsdJNa7Sjl+tzl26wECs9sEY7eqk+d+mmUmCNdvQSfe7SQ6UPWaMd/TN97hIAAAAAAAAAAAAAAH/sB9OHLFDUBIFsAAAAAElFTkSuQmCC', activeIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAAA8ElEQVR4Ae3BwW3EMBRDQX5WoaNKVCkqUUd1oXQQ2OYCQbxvRgAAAAAA4FelD9mzH/0zbazSB5QCe/ajl2hjlR4qPbBnP3qpNlbpptJNe/ajl2tjlW6wECvdsGc/+hJtrNJFFmIWYqWL9uxHX6aNVbrAQsxCzELMQsxCzELMQsxCzELMQsxCzELMQsxCzELMQsxCzELMQsxCzELMQsxCzELMQsxCzELMQqx0w5796Eu0sUoXWYhZiJVu2rMfvVwbq3SDhVjpgT370Uu1sUo3lQJ79qOXaGOVHip9yJ796J9pY5UAAAAAAAAAAAAAAPhjP0eFLFDoF7myAAAAAElFTkSuQmCC', center: false },
        { path: '/pages/profile/profile', text: '我', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAABr0lEQVR4Ae3BsbEkMQgFwPcUJj5RYBMFPmly/llbi0aa/UU3xhhjjDHGGGN8K0wKL0e8SJgUPqSexEsQLxAmhS+pJ3EZcVmYFJrUk7iIuChMCpuoJ3EJcUmYFDZTT+IC4oIwKTxEPYnDiMPCpPAw9SQOWhhtxEFhUjhEPYlDFkbbwmhbGG0Lo404JEwKh6kncQBxUJgUDlFP4pCF0bYw2hZG28JoIw4Lk8LD1JM4aGG0EReESeEh6kkcRlwSJoXN1JO4gLgoTAqbqCdxCXFZmBSa1JO4iHiBMCl8ST2Jy4gXCZPCh9STGJ8Jk8IYY4wxxhj/CZPCyxEvECaFL6kncRlxSZgUNlNP4gLisDApPEw9iYOIg8KkcIh6EocQB4RJ4RL1JB5GPCxMCpepJ/Eg4kFhUngJ9SQeQjwkTAovo57EA4gHhEnhpdST2IzYLEwKL6eexEbERmFS+BHqSWyyMNqITcKk8GPUk9iA2CBMCj9KPYmmhdFGNIVJ4cepJ9GwMNoWRhvRECaFP0I9iS8tjLaF0bYw2hZG28JoWxhtxJfCpPDHqCcxxhhjjDHGJv8AGW6Ll23maugAAAAASUVORK5CYII=', activeIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAYAAACqj0o2AAABr0lEQVR4Ae3BsbEkMQgFwPcUBSYhEgohYpIF55+1tWik2V90Y4wxxhhjjDHGt9K18HLEi6Rr4UNiQbwE8QLpWviSWBCXEZela6FJLIiLiIvStbCJWBCXEJeka2EzsSAuIC5I18JDxII4jDgsXQsPEwvioIXRRhyUroVDxII4ZGG0LYy2hdG2MNqIQ9K1cJhYEAcQB6Vr4RCxIA5ZGG0Lo21htC2MNuKwdC08TCyIgxZGG3FBuhYeIhbEYcQl6VrYTCyIC4iL0rWwiVgQlxCXpWuhSSyIi4gXSNfCl8SCuIx4kXQtfEgsiPGZdC2MMcYYY4zxn3QtvBzxAula+JJYEJcRl6RrYTOxIC4gDkvXwsPEgjiIOChdC4eIBXEIcUC6Fi4RC+JhxMPStXCZWBAPIh6UroWXEAviIcRD0rXwMmJBPIB4QLoWXkosiM2IzdK18HJiQWxEbJSuhR8hFsQmC6ON2CRdCz9GLIgNiA3StfCjxIJoWhhtRFO6Fn6cWBANC6NtYbQRDela+CPEgvjSwmhbGG0Lo21htC2MtoXRRnwpXQt/jFgQY4wxxhhjbPIPqOyMDyAVUxcAAAAASUVORK5CYII=', center: false },
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
