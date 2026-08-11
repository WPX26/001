<template>
  <view class="subscribe-page">
    <!-- 未登录：引导登录 -->
    <view v-if="!loggedIn" class="login-guide">
      <view class="guide-card">
        <view class="guide-emoji">👑</view>
        <view class="guide-title">开通会员</view>
        <view class="guide-desc">请先登录后再开通会员</view>
        <view class="guide-btn" hover-class="guide-btn-hover" @tap="goLogin">
          <text>去登录</text>
        </view>
      </view>
    </view>

    <template v-else>
      <!-- 顶部 hero（照原型 member-hero 深色渐变） -->
      <view class="member-hero">
        <view class="member-crown">👑</view>
        <view class="member-title">尊享会员</view>
        <view class="member-subtitle">解锁高级权益，升级认证摄影师</view>
        <view class="member-status-badge" :class="{ active: isMemberActive }">
          {{ isMemberActive ? '会员已开通' : '未开通' }}
        </view>
      </view>

      <view class="subscribe-scroll">
        <!-- 已开通状态 -->
        <view v-if="isMemberActive" class="active-tip">
          <text>🎉 您的会员处于有效状态，剩余 {{ memberRemainingDays }} 天</text>
        </view>

        <!-- 套餐卡片（照原型 plan-card：¥6/月 + 权益） -->
        <view class="plan-card">
          <view class="plan-name">{{ planName }}</view>
          <view class="plan-desc">解锁全部高级功能，可升级为认证摄影师，享受工作 / 生活双模式切换</view>
          <view class="plan-price">
            <text class="plan-price-symbol">¥</text>
            <text class="plan-price-num">{{ planPriceYuan }}</text>
            <text class="plan-price-unit">/ 月</text>
          </view>
          <view class="plan-benefits">
            <view v-for="(b, i) in planBenefits" :key="i" class="plan-benefit">
              <text class="benefit-check">✓</text>
              <text>{{ b }}</text>
            </view>
          </view>
        </view>

        <!-- 下单成功后：收款码面板（照原型 qr-panel） -->
        <view v-if="order" class="qr-panel">
          <view class="qr-title">请扫码付款</view>
          <view class="qr-subtitle">请使用微信 / 支付宝扫一扫<br />向收款方支付 ¥{{ orderAmountYuan }}</view>
          <view class="qr-order-id">订单号：{{ order.orderNo }}</view>
          <view class="qr-img-wrap">
            <image
              v-if="order.payeeQrCodeUrl"
              class="qr-img"
              :src="order.payeeQrCodeUrl"
              mode="aspectFit"
            />
            <view v-else class="qr-img-placeholder">收款码加载中，请稍候</view>
          </view>
          <view class="qr-tip">{{ order.remark || '请扫码支付并在付款时备注订单号' }}</view>
          <view v-if="polling" class="qr-waiting">
            <text class="spin"></text>
            <text>已通知商家，等待确认中…</text>
            <text class="qr-waiting-sub">请耐心等待，确认后自动跳转</text>
          </view>
          <view v-else class="qr-waiting qr-waiting-idle">
            <text>确认失败或已超时</text>
            <view class="retry-btn" @tap="startPolling">重新查询订单状态</view>
          </view>
        </view>

        <!-- 底部支付按钮（照原型 pay-footer） -->
        <view class="pay-footer">
          <view
            v-if="!order"
            class="pay-confirm"
            :class="{ disabled: paying }"
            hover-class="pay-confirm-hover"
            @tap="handleCreateOrder"
          >
            <text>{{ paying ? '下单中…' : '立即支付 ¥' + planPriceYuan }}</text>
          </view>
        </view>
      </view>
    </template>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'

const POLL_INTERVAL = 5000 // 轮询间隔（照 Web 端 photographer-payment.html）
const POLL_MAX_TRIES = 72 // 最多约 6 分钟，超时后提供手动重新查询

export default {
  data() {
    return {
      loggedIn: false,
      planId: 'plan_pro_monthly',
      planName: '高级会员',
      planPriceYuan: 6,
      planBenefits: [],
      order: null,
      orderAmountYuan: 0,
      paying: false,
      polling: false,
      pollTries: 0,
      pollTimer: null,
      memberStatus: null,
      memberRemainingDays: 0,
    }
  },
  computed: {
    isMemberActive() {
      return this.memberStatus === 'active'
    },
  },
  onLoad() {
    if (!memoApi.isLoggedIn()) {
      this.loggedIn = false
      return
    }
    this.loggedIn = true
    this.loadPlans()
    this.loadMemberStatus()
  },
  onUnload() {
    this.stopPolling()
  },
  methods: {
    /* ===== 套餐 / 会员状态 ===== */
    loadPlans() {
      memoApi
        .get('/member/plans')
        .then((plan) => {
          if (!plan) return
          if (plan.planId) this.planId = plan.planId
          if (plan.name) this.planName = plan.name
          if (plan.priceYuan != null) {
            this.planPriceYuan = plan.priceYuan
          } else if (plan.price != null) {
            this.planPriceYuan = plan.price / 100
          }
          this.planBenefits = plan.benefits || []
        })
        .catch(() => {})
    },
    loadMemberStatus() {
      memoApi
        .get('/member/status')
        .then((data) => {
          if (!data) return
          this.memberStatus = data.memberStatus
          this.memberRemainingDays = Math.max(0, Number(data.remainingDays) || 0)
        })
        .catch(() => {})
    },

    /* ===== 下单：POST /member/order（半自动人工确认） ===== */
    handleCreateOrder() {
      if (this.paying) return
      this.paying = true
      uni.showLoading({ title: '创建订单' })
      memoApi
        .post('/member/order', { planId: this.planId, paymentMethod: 'wechat' })
        .then((data) => {
          uni.hideLoading()
          this.paying = false
          if (!data || !data.orderId) {
            uni.showToast({ title: '下单失败，请重试', icon: 'none' })
            return
          }
          this.order = data
          this.orderAmountYuan = data.amount != null ? Number(data.amount) / 100 : this.planPriceYuan
          this.startPolling()
        })
        .catch(() => {
          uni.hideLoading()
          this.paying = false
        })
    },

    /* ===== 轮询订单状态：paid → 开通成功 ===== */
    startPolling() {
      this.pollTries = 0
      this.stopPolling()
      this.polling = true
      this.pollTimer = setInterval(() => this.pollOrder(), POLL_INTERVAL)
      this.pollOrder() // 立即查询一次
    },
    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
      this.polling = false
    },
    pollOrder() {
      if (!this.order || !this.order.orderId) return
      this.pollTries += 1
      memoApi
        .get('/member/order/' + encodeURIComponent(this.order.orderId))
        .then((data) => {
          if (!data) return
          if (data.status === 'paid') {
            this.stopPolling()
            uni.showToast({ title: '开通成功！已升级认证摄影师', icon: 'success' })
            // 返回我的页刷新会员状态
            setTimeout(() => uni.navigateBack({ delta: 1 }), 1200)
          } else if (this.pollTries >= POLL_MAX_TRIES) {
            this.stopPolling()
          }
        })
        .catch(() => {
          // 网络异常：停止轮询，提供手动重新查询
          if (this.pollTries >= POLL_MAX_TRIES) {
            this.stopPolling()
          }
        })
    },

    /* ===== 其他 ===== */
    goLogin() {
      uni.reLaunch({ url: '/pages/login/login' })
    },
  },
}
</script>

<style>
.subscribe-page {
  min-height: 100vh;
  background: linear-gradient(165deg, #f8ecd8 0%, #f3dcb4 100%);
  display: flex;
  flex-direction: column;
}

/* ===== 未登录引导 ===== */
.login-guide {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx;
}
.guide-card {
  width: 100%;
  background: rgba(250, 243, 231, 0.9);
  border-radius: 40rpx;
  border: 1px solid rgba(212, 165, 116, 0.35);
  box-shadow: 0 24rpx 80rpx rgba(28, 15, 8, 0.1);
  padding: 80rpx 48rpx;
  text-align: center;
}
.guide-emoji {
  font-size: 96rpx;
  margin-bottom: 24rpx;
}
.guide-title {
  font-size: 40rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 12rpx;
}
.guide-desc {
  font-size: 26rpx;
  color: #6b4423;
  margin-bottom: 48rpx;
}
.guide-btn {
  height: 92rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  border-radius: 24rpx;
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
  letter-spacing: 4rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 12rpx 48rpx rgba(232, 144, 32, 0.4);
}
.guide-btn-hover {
  transform: translateY(2rpx) scale(0.98);
  filter: brightness(0.95);
}

/* ===== 顶部 hero（照原型 member-hero 深色渐变） ===== */
.member-hero {
  background: linear-gradient(135deg, #2a1810 0%, #4a2818 50%, #6b3818 100%);
  padding: 56rpx 40rpx 64rpx;
  color: #faf5ec;
  position: relative;
  overflow: hidden;
}
.member-hero::before {
  content: '';
  position: absolute;
  top: -80rpx;
  right: -80rpx;
  width: 320rpx;
  height: 320rpx;
  background: radial-gradient(circle, rgba(240, 160, 64, 0.25) 0%, transparent 70%);
  border-radius: 50%;
}
.member-crown {
  width: 112rpx;
  height: 112rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 28rpx;
  font-size: 52rpx;
  box-shadow: 0 12rpx 40rpx rgba(240, 160, 64, 0.4);
  position: relative;
  z-index: 1;
}
.member-title {
  font-size: 40rpx;
  font-weight: 700;
  margin-bottom: 10rpx;
  position: relative;
  z-index: 1;
}
.member-subtitle {
  font-size: 24rpx;
  opacity: 0.7;
  position: relative;
  z-index: 1;
}
.member-status-badge {
  display: inline-flex;
  align-items: center;
  margin-top: 20rpx;
  padding: 8rpx 20rpx;
  border-radius: 24rpx;
  font-size: 22rpx;
  font-weight: 600;
  background: rgba(240, 160, 64, 0.2);
  color: #f0a040;
  border: 1px solid rgba(240, 160, 64, 0.4);
  position: relative;
  z-index: 1;
}
.member-status-badge.active {
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  color: #ffffff;
  border-color: transparent;
}

/* ===== 内容区 ===== */
.subscribe-scroll {
  flex: 1;
  padding: 32rpx 40rpx 60rpx;
}

/* 已开通提示 */
.active-tip {
  background: rgba(46, 125, 50, 0.1);
  border: 1px solid rgba(46, 125, 50, 0.3);
  border-radius: 24rpx;
  padding: 20rpx 28rpx;
  font-size: 26rpx;
  color: #2e7d32;
  margin-bottom: 24rpx;
}

/* ===== 套餐卡片（照原型 plan-card） ===== */
.plan-card {
  background: rgba(255, 250, 242, 0.9);
  border: 1px solid rgba(212, 165, 116, 0.3);
  border-radius: 32rpx;
  padding: 40rpx 36rpx;
  box-shadow: 0 16rpx 60rpx rgba(28, 15, 8, 0.08);
}
.plan-name {
  font-size: 34rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 12rpx;
}
.plan-desc {
  font-size: 24rpx;
  color: #8b5e3c;
  line-height: 1.6;
  margin-bottom: 24rpx;
}
.plan-price {
  display: flex;
  align-items: baseline;
  margin-bottom: 24rpx;
}
.plan-price-symbol {
  font-size: 32rpx;
  font-weight: 700;
  color: #e89020;
}
.plan-price-num {
  font-size: 72rpx;
  font-weight: 700;
  color: #e89020;
  line-height: 1;
}
.plan-price-unit {
  font-size: 24rpx;
  color: #9b7b5a;
  margin-left: 8rpx;
}
.plan-benefits {
  border-top: 1rpx dashed rgba(212, 165, 116, 0.4);
  padding-top: 20rpx;
}
.plan-benefit {
  display: flex;
  align-items: center;
  gap: 12rpx;
  font-size: 24rpx;
  color: #6b4423;
  margin-bottom: 12rpx;
}
.benefit-check {
  color: #e89020;
  font-weight: 700;
}

/* ===== 收款码面板（照原型 qr-panel） ===== */
.qr-panel {
  margin-top: 28rpx;
  background: rgba(255, 250, 242, 0.9);
  border: 1px solid rgba(212, 165, 116, 0.3);
  border-radius: 32rpx;
  padding: 40rpx 36rpx;
  box-shadow: 0 16rpx 60rpx rgba(28, 15, 8, 0.08);
  text-align: center;
}
.qr-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #1c0f08;
  margin-bottom: 8rpx;
}
.qr-subtitle {
  font-size: 24rpx;
  color: #8b5e3c;
  line-height: 1.6;
  margin-bottom: 20rpx;
}
.qr-order-id {
  display: inline-block;
  padding: 8rpx 24rpx;
  border: 1px solid rgba(240, 160, 64, 0.25);
  border-radius: 16rpx;
  background: rgba(240, 160, 64, 0.08);
  font-size: 24rpx;
  font-weight: 600;
  color: #d4691c;
  margin-bottom: 24rpx;
}
.qr-img-wrap {
  width: 400rpx;
  height: 400rpx;
  margin: 0 auto 24rpx;
  background: #ffffff;
  border: 1px solid rgba(212, 165, 116, 0.3);
  border-radius: 24rpx;
  overflow: hidden;
}
.qr-img {
  width: 100%;
  height: 100%;
}
.qr-img-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24rpx;
  color: #9b7b5a;
}
.qr-tip {
  font-size: 24rpx;
  color: #d4691c;
  margin-bottom: 20rpx;
}
.qr-waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8rpx;
  font-size: 26rpx;
  color: #6b4423;
  padding: 16rpx 0;
}
.qr-waiting-sub {
  font-size: 22rpx;
  color: #b89070;
}
.qr-waiting-idle {
  color: #b89070;
}
.spin {
  width: 32rpx;
  height: 32rpx;
  border: 4rpx solid #e8d3b4;
  border-top-color: #d4691c;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.retry-btn {
  margin-top: 8rpx;
  padding: 12rpx 36rpx;
  border: 1px solid rgba(240, 160, 64, 0.5);
  border-radius: 20rpx;
  color: #e89020;
  font-size: 24rpx;
}

/* ===== 底部支付按钮（照原型 pay-confirm） ===== */
.pay-footer {
  padding-top: 32rpx;
}
.pay-confirm {
  height: 100rpx;
  background: linear-gradient(135deg, #f0a040 0%, #d4691c 100%);
  border-radius: 24rpx;
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
  letter-spacing: 2rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 12rpx 48rpx rgba(232, 144, 32, 0.5), inset 0 2rpx 0 rgba(255, 233, 184, 0.4);
}
.pay-confirm.disabled {
  opacity: 0.6;
}
.pay-confirm-hover {
  transform: translateY(2rpx) scale(0.98);
  filter: brightness(0.95);
}
</style>
