<template>
  <view class="register-page">
    <!-- 装饰光斑 -->
    <view class="orb orb-a"></view>
    <view class="orb orb-b"></view>

    <view class="register-container">
      <view class="back-btn" @tap="goBack">
        <text class="back-icon">‹</text>
        <text class="back-text">返回</text>
      </view>

      <view class="login-header">
        <view class="login-title">创建账号</view>
        <view class="login-subtitle">注册新账号开启精彩旅程</view>
      </view>

      <view class="login-card">
        <view class="input-group">
          <view class="input-label">手机号</view>
          <view class="input-wrapper">
            <text class="input-icon">📱</text>
            <input
              class="input-field"
              type="number"
              maxlength="11"
              placeholder="请输入手机号"
              placeholder-class="input-placeholder"
              v-model="phone"
            />
          </view>
          <view class="input-hint" :class="{ show: phoneHintShow }" :style="{ color: phoneHintColor }">
            {{ phoneHint }}
          </view>
        </view>

        <view class="input-group">
          <view class="input-label">验证码</view>
          <view class="code-wrapper">
            <view class="input-wrapper code-input">
              <text class="input-icon">✉️</text>
              <input
                class="input-field"
                type="number"
                maxlength="6"
                placeholder="请输入验证码"
                placeholder-class="input-placeholder"
                v-model="code"
              />
            </view>
            <view
              class="send-code-btn"
              :class="{ disabled: countdown > 0 }"
              @tap="handleSendCode"
            >
              {{ countdown > 0 ? countdown + 's 后重发' : (codeSent ? '重新获取' : '获取验证码') }}
            </view>
          </view>
        </view>

        <view class="input-group">
          <view class="input-label">用户名</view>
          <view class="input-wrapper">
            <text class="input-icon">👤</text>
            <input
              class="input-field"
              maxlength="16"
              placeholder="请输入用户名"
              placeholder-class="input-placeholder"
              v-model="nickname"
            />
          </view>
          <view class="input-hint" :class="{ show: nicknameHintShow }" :style="{ color: nicknameHintColor }">
            {{ nicknameHint }}
          </view>
        </view>

        <view class="input-group">
          <view class="input-label">密码</view>
          <view class="input-wrapper">
            <text class="input-icon">🔑</text>
            <input
              class="input-field"
              :password="!showPwd1"
              placeholder="请输入密码"
              placeholder-class="input-placeholder"
              v-model="password"
            />
            <view class="pwd-toggle" @tap="showPwd1 = !showPwd1">
              <text>{{ showPwd1 ? '🙈' : '👁' }}</text>
            </view>
          </view>
          <view class="password-strength" :class="{ show: strengthLevel > 0 }">
            <view
              class="password-strength-bar"
              :class="'strength-' + strengthLevel"
            ></view>
          </view>
        </view>

        <view class="input-group">
          <view class="input-label">确认密码</view>
          <view class="input-wrapper">
            <text class="input-icon">🔒</text>
            <input
              class="input-field"
              :password="!showPwd2"
              placeholder="请再次输入密码"
              placeholder-class="input-placeholder"
              v-model="confirmPwd"
            />
            <view class="pwd-toggle" @tap="showPwd2 = !showPwd2">
              <text>{{ showPwd2 ? '🙈' : '👁' }}</text>
            </view>
          </view>
          <view class="input-hint" :class="{ show: confirmHintShow }" :style="{ color: confirmHintColor }">
            {{ confirmHint }}
          </view>
        </view>

        <view class="agreement" @tap="agreed = !agreed">
          <view class="agreement-checkbox" :class="{ checked: agreed }">
            <text v-if="agreed" class="agreement-mark">✓</text>
          </view>
          <text class="agreement-text">我已阅读并同意 </text>
          <text class="agreement-link" @tap.stop="showAgreement('用户协议')">《用户协议》</text>
          <text class="agreement-text"> 和 </text>
          <text class="agreement-link" @tap.stop="showAgreement('隐私政策')">《隐私政策》</text>
        </view>

        <view class="register-btn" hover-class="register-btn-hover" @tap="handleRegister">
          <text>创 建 账 号</text>
        </view>

        <view class="login-link" @tap="goLogin">
          <text>已有账号? </text>
          <text class="login-link-a">立即登录</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'

export default {
  data() {
    return {
      phone: '',
      code: '',
      nickname: '',
      password: '',
      confirmPwd: '',
      showPwd1: false,
      showPwd2: false,
      agreed: false,
      countdown: 0,
      codeSent: false,
      countdownTimer: null,
      // 实时提示
      phoneHint: '',
      phoneHintShow: false,
      phoneHintColor: '#8B5E3C',
      nicknameHint: '',
      nicknameHintShow: false,
      nicknameHintColor: '#8B5E3C',
      strengthLevel: 0,
      confirmHint: '',
      confirmHintShow: false,
      confirmHintColor: '#8B5E3C',
    }
  },
  onUnload() {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
  },
  watch: {
    phone(val) {
      val = (val || '').replace(/\D/g, '')
      this.phone = val
      if (!val) {
        this.phoneHintShow = false
      } else if (val.length < 11) {
        this.phoneHintShow = true
        this.phoneHintColor = '#E05A3A'
        this.phoneHint = '还需输入' + (11 - val.length) + '位'
      } else if (!/^1\d{10}$/.test(val)) {
        this.phoneHintShow = true
        this.phoneHintColor = '#E05A3A'
        this.phoneHint = '手机号格式不正确'
      } else {
        this.phoneHintShow = true
        this.phoneHintColor = '#4CAF50'
        this.phoneHint = '✓ 手机号格式正确'
      }
    },
    nickname(val) {
      if (!val) {
        this.nicknameHintShow = false
        return
      }
      this.nicknameHintShow = true
      if (val.trim().length < 4) {
        this.nicknameHintColor = '#E05A3A'
        this.nicknameHint = '至少4位字符'
      } else {
        this.nicknameHintColor = '#4CAF50'
        this.nicknameHint = '✓ 用户名格式正确'
      }
    },
    password(val) {
      if (!val) {
        this.strengthLevel = 0
        return
      }
      let level = 0
      if (val.length >= 6) level++
      if (/[A-Z]/.test(val) && /[a-z]/.test(val)) level++
      if (/\d/.test(val) && /[^A-Za-z0-9]/.test(val)) level++
      this.strengthLevel = level <= 1 ? 1 : level === 2 ? 2 : 3
      this.checkConfirm()
    },
    confirmPwd() {
      this.checkConfirm()
    },
  },
  methods: {
    checkConfirm() {
      if (!this.confirmPwd) {
        this.confirmHintShow = false
        return
      }
      this.confirmHintShow = true
      if (this.confirmPwd === this.password) {
        this.confirmHintColor = '#4CAF50'
        this.confirmHint = '✓ 密码一致'
      } else {
        this.confirmHintColor = '#E05A3A'
        this.confirmHint = '两次密码不一致'
      }
    },
    handleSendCode() {
      if (this.countdown > 0) return
      if (!/^1\d{10}$/.test(this.phone)) {
        uni.showToast({ title: '手机号格式不正确', icon: 'none' })
        return
      }
      uni.showLoading({ title: '发送中' })
      memoApi
        .post('/auth/send-code', { phone: this.phone, scene: 'register' })
        .then((data) => {
          uni.hideLoading()
          this.codeSent = true
          const devCode = data && data.devCode
          if (devCode) {
            this.code = devCode
            uni.showToast({ title: '验证码: ' + devCode + '（模拟短信）', icon: 'none', duration: 3000 })
          } else {
            uni.showToast({ title: '验证码已发送', icon: 'success' })
          }
          this.startCountdown()
        })
        .catch(() => {
          uni.hideLoading()
        })
    },
    startCountdown() {
      this.countdown = 60
      if (this.countdownTimer) clearInterval(this.countdownTimer)
      this.countdownTimer = setInterval(() => {
        this.countdown--
        if (this.countdown <= 0) {
          clearInterval(this.countdownTimer)
          this.countdownTimer = null
        }
      }, 1000)
    },
    handleRegister() {
      const phone = this.phone
      const code = this.code
      const nickname = this.nickname.trim()
      const pwd = this.password

      if (!/^1\d{10}$/.test(phone)) {
        uni.showToast({ title: '请输入正确的手机号', icon: 'none' })
        return
      }
      if (!code) {
        uni.showToast({ title: '请输入验证码', icon: 'none' })
        return
      }
      if (nickname.length < 4) {
        uni.showToast({ title: '用户名至少4位', icon: 'none' })
        return
      }
      if (pwd.length < 6) {
        uni.showToast({ title: '密码至少6位', icon: 'none' })
        return
      }
      if (pwd !== this.confirmPwd) {
        uni.showToast({ title: '两次密码不一致', icon: 'none' })
        return
      }
      if (!this.agreed) {
        uni.showToast({ title: '请先同意用户协议', icon: 'none' })
        return
      }

      uni.showLoading({ title: '注册中' })
      memoApi
        .post('/auth/register', { phone, code, nickname, password: pwd })
        .then((data) => {
          uni.hideLoading()
          if (data && data.token) {
            // 后端注册即签发 token，直接保存并进入首页（免二次登录）
            memoApi.setAuth(data.token, data.user || {})
            uni.showToast({ title: '注册成功', icon: 'success' })
            setTimeout(() => uni.switchTab({ url: '/pages/home/home' }), 800)
          } else {
            uni.showToast({ title: '注册失败，请重试', icon: 'none' })
          }
        })
        .catch(() => {
          uni.hideLoading()
        })
    },
    showAgreement(name) {
      uni.showToast({ title: name + '页面即将上线', icon: 'none' })
    },
    goBack() {
      uni.navigateBack({
        fail: () => uni.reLaunch({ url: '/pages/login/login' }),
      })
    },
    goLogin() {
      uni.navigateBack({
        fail: () => uni.reLaunch({ url: '/pages/login/login' }),
      })
    },
  },
}
</script>

<style>
/* ===== 页面背景：照原型 ===== */
.register-page {
  min-height: 100vh;
  background: linear-gradient(165deg, #F0B860 0%, #E89020 40%, #B85A10 100%);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.orb {
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 233, 184, 0.5) 0%, rgba(255, 233, 184, 0) 70%);
  pointer-events: none;
}
.orb-a {
  width: 460rpx;
  height: 460rpx;
  top: -120rpx;
  right: -100rpx;
}
.orb-b {
  width: 380rpx;
  height: 380rpx;
  bottom: -100rpx;
  left: -80rpx;
  background: radial-gradient(circle, rgba(255, 184, 77, 0.55) 0%, rgba(255, 184, 77, 0) 70%);
}

.register-container {
  position: relative;
  z-index: 2;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 60rpx 52rpx 40rpx;
}

/* 返回 */
.back-btn {
  display: inline-flex;
  align-items: center;
  color: #1c0f08;
  font-size: 28rpx;
  width: fit-content;
  margin-bottom: 20rpx;
  padding: 8rpx 16rpx;
  border-radius: 16rpx;
}
.back-icon {
  font-size: 36rpx;
  margin-right: 4rpx;
  line-height: 1;
}
.back-text {
  font-size: 28rpx;
}

.login-header {
  text-align: center;
  margin-bottom: 36rpx;
}
.login-title {
  font-size: 48rpx;
  font-weight: 700;
  color: #1c0f08;
  letter-spacing: 2rpx;
  margin-bottom: 8rpx;
}
.login-subtitle {
  font-size: 24rpx;
  color: #6b4423;
}

/* 毛玻璃卡片 */
.login-card {
  background: rgba(250, 243, 231, 0.55);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-radius: 40rpx;
  padding: 40rpx 40rpx;
  border: 1px solid rgba(255, 248, 235, 0.65);
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.18), inset 0 2rpx 0 rgba(255, 255, 255, 0.3);
}

.input-group {
  margin-bottom: 24rpx;
}
.input-label {
  font-size: 24rpx;
  color: #4a2c17;
  margin-bottom: 10rpx;
  font-weight: 500;
  display: block;
}
.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}
.input-icon {
  position: absolute;
  left: 26rpx;
  font-size: 30rpx;
  color: #9b7b5a;
  z-index: 1;
}
.input-field {
  width: 100%;
  height: 88rpx;
  padding: 0 26rpx 0 80rpx;
  background: rgba(255, 250, 242, 0.78);
  border: 2rpx solid rgba(212, 165, 116, 0.35);
  border-radius: 20rpx;
  font-size: 26rpx;
  color: #1c0f08;
  box-sizing: border-box;
}
.input-placeholder {
  color: #9b7b5a;
}

/* 验证码 */
.code-wrapper {
  display: flex;
  gap: 20rpx;
  align-items: center;
}
.code-wrapper .code-input {
  flex: 1;
}
.send-code-btn {
  flex-shrink: 0;
  height: 88rpx;
  padding: 0 28rpx;
  background: rgba(255, 250, 242, 0.78);
  border: 2rpx solid #e89020;
  border-radius: 20rpx;
  color: #e89020;
  font-size: 24rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  min-width: 180rpx;
}
.send-code-btn.disabled {
  background: rgba(212, 165, 116, 0.25);
  border-color: rgba(155, 123, 90, 0.4);
  color: #9b7b5a;
}

/* 密码可见切换 */
.pwd-toggle {
  position: absolute;
  right: 22rpx;
  width: 56rpx;
  height: 56rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  font-size: 28rpx;
}
.input-wrapper .input-field {
  padding-right: 76rpx;
}

/* 密码强度 */
.password-strength {
  height: 6rpx;
  background: rgba(212, 165, 116, 0.3);
  border-radius: 4rpx;
  margin-top: 12rpx;
  overflow: hidden;
  display: none;
}
.password-strength.show {
  display: block;
}
.password-strength-bar {
  height: 100%;
  border-radius: 4rpx;
  transition: width 0.3s ease, background 0.3s ease;
}
.strength-1 {
  width: 33%;
  background: #e05a3a;
}
.strength-2 {
  width: 66%;
  background: #e89020;
}
.strength-3 {
  width: 100%;
  background: #4caf50;
}

/* 提示 */
.input-hint {
  font-size: 22rpx;
  color: #8b5e3c;
  margin-top: 8rpx;
  display: none;
}
.input-hint.show {
  display: block;
}

/* 协议 */
.agreement {
  display: flex;
  align-items: flex-start;
  gap: 12rpx;
  margin: 28rpx 0 32rpx;
  font-size: 22rpx;
  color: #4a2c17;
  line-height: 1.5;
  flex-wrap: wrap;
}
.agreement-checkbox {
  width: 28rpx;
  height: 28rpx;
  border: 2rpx solid #9b7b5a;
  border-radius: 8rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 250, 242, 0.6);
  flex-shrink: 0;
  margin-top: 2rpx;
}
.agreement-checkbox.checked {
  background: linear-gradient(135deg, #f0a040, #d4691c);
  border-color: transparent;
}
.agreement-mark {
  font-size: 18rpx;
  color: #ffffff;
}
.agreement-text {
  font-size: 22rpx;
}
.agreement-link {
  color: #e89020;
  font-size: 22rpx;
}

/* 注册按钮 */
.register-btn {
  width: 100%;
  height: 96rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  border-radius: 24rpx;
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
  letter-spacing: 4rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 12rpx 48rpx rgba(232, 144, 32, 0.5), inset 0 2rpx 0 rgba(255, 233, 184, 0.4);
}
.register-btn-hover {
  transform: translateY(2rpx) scale(0.98);
  filter: brightness(0.95);
}

/* 登录链接 */
.login-link {
  text-align: center;
  margin-top: 28rpx;
  font-size: 24rpx;
  color: #6b4423;
}
.login-link-a {
  color: #e89020;
  font-weight: 600;
}
</style>
