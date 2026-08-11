<template>
  <view class="login-page">
    <!-- 装饰光斑 -->
    <view class="orb orb-a"></view>
    <view class="orb orb-b"></view>

    <view class="login-container">
      <view class="login-header">
        <view class="login-title">欢迎回来</view>
        <view class="login-subtitle">请登录您的账号</view>
      </view>

      <view class="login-card">
        <!-- 登录方式 Tab -->
        <view class="login-tabs">
          <view
            class="login-tab"
            :class="{ active: mode === 'code' }"
            @tap="mode = 'code'"
          >
            <text class="tab-icon">📱</text>
            <text>验证码登录</text>
          </view>
          <view
            class="login-tab"
            :class="{ active: mode === 'pwd' }"
            @tap="mode = 'pwd'"
          >
            <text class="tab-icon">🔐</text>
            <text>密码登录</text>
          </view>
        </view>

        <!-- 验证码登录面板 -->
        <view v-if="mode === 'code'">
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
          </view>
          <view class="input-group">
            <view class="input-label">验证码</view>
            <view class="code-row">
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
          <view class="login-btn" hover-class="login-btn-hover" @tap="handleLoginByCode">
            <text>登 录</text>
          </view>
        </view>

        <!-- 密码登录面板 -->
        <view v-else>
          <view class="input-group">
            <view class="input-label">用户名 / 手机号</view>
            <view class="input-wrapper">
              <text class="input-icon">👤</text>
              <input
                class="input-field"
                placeholder="请输入用户名或手机号"
                placeholder-class="input-placeholder"
                v-model="username"
              />
            </view>
          </view>
          <view class="input-group">
            <view class="input-label">密码</view>
            <view class="input-wrapper">
              <text class="input-icon">🔑</text>
              <input
                class="input-field"
                :password="!showPwd"
                placeholder="请输入密码"
                placeholder-class="input-placeholder"
                v-model="password"
              />
              <view class="pwd-toggle" @tap="showPwd = !showPwd">
                <text>{{ showPwd ? '🙈' : '👁' }}</text>
              </view>
            </view>
          </view>
          <view class="form-options">
            <view class="remember-me" @tap="remember = !remember">
              <view class="checkbox" :class="{ checked: remember }">
                <text v-if="remember" class="checkbox-mark">✓</text>
              </view>
              <text class="remember-label">记住我</text>
            </view>
            <view class="forgot-link" @tap="handleForgot">忘记密码?</view>
          </view>
          <view class="login-btn" hover-class="login-btn-hover" @tap="handleLoginByPwd">
            <text>登 录</text>
          </view>
        </view>

        <!-- 第三方登录 -->
        <view class="divider"><text>其他方式登录</text></view>
        <view class="social-login">
          <view class="social-btn" @tap="handleWechat">💬</view>
          <view class="social-btn" @tap="handleQQ">🐧</view>
        </view>

        <view class="register-link" @tap="goRegister">
          <text>还没有账号? </text>
          <text class="register-link-a">立即注册</text>
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
      mode: 'code', // code | pwd
      phone: '',
      code: '',
      username: '',
      password: '',
      showPwd: false,
      remember: true,
      countdown: 0,
      codeSent: false,
      countdownTimer: null,
    }
  },
  onUnload() {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
  },
  methods: {
    // ===== 验证码 =====
    handleSendCode() {
      if (this.countdown > 0) return
      if (!/^1\d{10}$/.test(this.phone)) {
        uni.showToast({ title: '请输入正确的手机号', icon: 'none' })
        return
      }
      uni.showLoading({ title: '发送中' })
      memoApi
        .post('/auth/send-code', { phone: this.phone, scene: 'login' })
        .then((data) => {
          uni.hideLoading()
          this.codeSent = true
          const devCode = data && data.devCode
          if (devCode) {
            // 开发模式：后端返回 devCode，提示并自动填充
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
    // ===== 验证码登录 =====
    handleLoginByCode() {
      if (!/^1\d{10}$/.test(this.phone)) {
        uni.showToast({ title: '请输入正确的手机号', icon: 'none' })
        return
      }
      if (!this.code) {
        uni.showToast({ title: '请输入验证码', icon: 'none' })
        return
      }
      uni.showLoading({ title: '登录中' })
      memoApi
        .post('/auth/login', { phone: this.phone, code: this.code })
        .then((data) => {
          uni.hideLoading()
          if (data && data.token) {
            memoApi.setAuth(data.token, data.user || {})
            uni.showToast({ title: '登录成功', icon: 'success' })
            setTimeout(() => uni.switchTab({ url: '/pages/home/home' }), 800)
          } else {
            uni.showToast({ title: '登录失败，请重试', icon: 'none' })
          }
        })
        .catch(() => {
          uni.hideLoading()
        })
    },
    // ===== 密码登录（后端仅支持验证码登录，原型密码 tab 为演示保留） =====
    handleLoginByPwd() {
      if (!this.username || !this.password) {
        uni.showToast({ title: '请输入账号和密码', icon: 'none' })
        return
      }
      uni.showToast({ title: '请使用验证码登录', icon: 'none' })
    },
    // ===== 其他 =====
    handleForgot() {
      uni.showToast({ title: '请使用验证码登录后修改', icon: 'none' })
    },
    handleWechat() {
      uni.showToast({ title: '微信登录即将上线', icon: 'none' })
    },
    handleQQ() {
      uni.showToast({ title: 'QQ登录即将上线', icon: 'none' })
    },
    goRegister() {
      uni.navigateTo({ url: '/pages/register/register' })
    },
  },
}
</script>

<style>
/* ===== 页面背景：照原型 linear-gradient(165deg, #F0B860, #E89020 40%, #B85A10) ===== */
.login-page {
  min-height: 100vh;
  background: linear-gradient(165deg, #F0B860 0%, #E89020 40%, #B85A10 100%);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 装饰光斑（照原型 radial-gradient 光斑，简化为模糊圆） */
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

.login-container {
  position: relative;
  z-index: 2;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 120rpx 64rpx 40rpx;
}

.login-header {
  text-align: center;
  margin-bottom: 56rpx;
}
.login-title {
  font-size: 56rpx;
  font-weight: 700;
  color: #1c0f08;
  letter-spacing: 2rpx;
  margin-bottom: 12rpx;
}
.login-subtitle {
  font-size: 30rpx;
  color: #6b4423;
}

/* 毛玻璃卡片 */
.login-card {
  background: rgba(250, 243, 231, 0.55);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-radius: 40rpx;
  padding: 56rpx 44rpx;
  border: 1px solid rgba(255, 248, 235, 0.65);
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.18), inset 0 2rpx 0 rgba(255, 255, 255, 0.3);
}

/* Tab */
.login-tabs {
  display: flex;
  background: rgba(255, 250, 242, 0.3);
  border-radius: 24rpx;
  padding: 6rpx;
  margin-bottom: 40rpx;
  gap: 6rpx;
}
.login-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  padding: 18rpx 0;
  border-radius: 20rpx;
  font-size: 28rpx;
  font-weight: 600;
  color: rgba(28, 15, 8, 0.55);
  transition: all 0.25s;
}
.login-tab.active {
  background: #ffffff;
  color: #1c0f08;
  box-shadow: 0 4rpx 16rpx rgba(28, 15, 8, 0.12);
}
.tab-icon {
  font-size: 28rpx;
}

/* 表单 */
.input-group {
  margin-bottom: 32rpx;
}
.input-label {
  font-size: 24rpx;
  color: #4a2c17;
  margin-bottom: 12rpx;
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
  left: 28rpx;
  font-size: 32rpx;
  color: #9b7b5a;
  z-index: 1;
}
.input-field {
  width: 100%;
  height: 96rpx;
  padding: 0 28rpx 0 84rpx;
  background: rgba(255, 250, 242, 0.78);
  border: 2rpx solid rgba(212, 165, 116, 0.35);
  border-radius: 24rpx;
  font-size: 28rpx;
  color: #1c0f08;
  box-sizing: border-box;
}
.input-placeholder {
  color: #9b7b5a;
}
.input-field:focus {
  background: rgba(255, 250, 242, 0.95);
  border-color: #e89020;
}

/* 验证码行 */
.code-row {
  display: flex;
  gap: 20rpx;
}
.code-row .code-input {
  flex: 1;
}
.send-code-btn {
  height: 96rpx;
  padding: 0 32rpx;
  background: rgba(255, 250, 242, 0.78);
  border: 2rpx solid #e89020;
  border-radius: 24rpx;
  color: #e89020;
  font-size: 24rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  flex-shrink: 0;
}
.send-code-btn.disabled {
  background: rgba(212, 165, 116, 0.25);
  border-color: rgba(155, 123, 90, 0.4);
  color: #9b7b5a;
}

/* 密码可见切换 */
.pwd-toggle {
  position: absolute;
  right: 24rpx;
  width: 56rpx;
  height: 56rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  font-size: 28rpx;
}
.input-wrapper .input-field {
  padding-right: 80rpx;
}

/* 记住我 / 忘记密码 */
.form-options {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 40rpx 0 44rpx;
  font-size: 24rpx;
}
.remember-me {
  display: flex;
  align-items: center;
  gap: 12rpx;
  color: #4a2c17;
}
.checkbox {
  width: 32rpx;
  height: 32rpx;
  border: 2rpx solid #9b7b5a;
  border-radius: 10rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 250, 242, 0.6);
  transition: all 0.25s ease;
}
.checkbox.checked {
  background: linear-gradient(135deg, #b8864a, #8b5e3c);
  border-color: transparent;
}
.checkbox-mark {
  font-size: 22rpx;
  color: #ffffff;
}
.remember-label {
  font-size: 24rpx;
}
.forgot-link {
  color: #e89020;
  font-size: 24rpx;
}

/* 登录按钮（照原型渐变 + 阴影） */
.login-btn {
  width: 100%;
  height: 100rpx;
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
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.25s ease;
}
.login-btn-hover {
  transform: translateY(2rpx) scale(0.98);
  filter: brightness(0.95);
}

/* 分割线 + 第三方 */
.divider {
  display: flex;
  align-items: center;
  margin: 32rpx 0;
  color: rgba(28, 15, 8, 0.35);
  font-size: 22rpx;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 2rpx;
  background: rgba(212, 165, 116, 0.3);
}
.divider text {
  padding: 0 24rpx;
}
.social-login {
  display: flex;
  justify-content: center;
  gap: 48rpx;
}
.social-btn {
  width: 88rpx;
  height: 88rpx;
  border-radius: 50%;
  border: 2rpx solid rgba(212, 165, 116, 0.3);
  background: rgba(255, 250, 242, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36rpx;
}

/* 注册链接 */
.register-link {
  text-align: center;
  margin-top: 44rpx;
  font-size: 26rpx;
  color: #6b4423;
}
.register-link-a {
  color: #e89020;
  font-weight: 600;
}
</style>
