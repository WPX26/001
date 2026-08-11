<template>
  <view class="page">
    <!-- 未登录：引导登录 -->
    <view v-if="!loggedIn" class="login-guide">
      <view class="guide-card">
        <view class="guide-emoji">🖼️</view>
        <view class="guide-title">我的相册</view>
        <view class="guide-desc">登录后查看我的照片与上传记录</view>
        <view class="guide-btn" hover-class="guide-btn-hover" @tap="goLogin">
          <text>去登录</text>
        </view>
      </view>
    </view>

    <!-- 已登录：照片列表 -->
    <view v-else class="album-content">
      <!-- 首次加载中 -->
      <view v-if="!loaded" class="state-tip">加载中…</view>

      <template v-else>
        <!-- 空状态 -->
        <view v-if="photos.length === 0" class="state-tip">
          <view class="state-emoji">📷</view>
          <view class="state-text">暂无照片，去拍摄第一张吧</view>
        </view>

        <!-- 日期分组 -->
        <view v-for="g in groups" :key="g.date" class="date-section">
          <view class="date-header" @tap="toggleGroup(g.date)">
            <view class="date-info">
              <text class="date-text">{{ g.date }}</text>
              <text class="date-count">{{ g.list.length }}</text>
            </view>
            <view class="date-arrow" :class="{ expanded: isExpanded(g.date) }">
              <text class="arrow-icon">›</text>
            </view>
          </view>
          <view class="photo-grid">
            <view
              v-for="(p, idx) in groupPhotos(g)"
              :key="p.id"
              class="photo-item"
              @tap="handlePhotoTap(p)"
            >
              <image
                v-if="p.thumbnailUrl"
                class="photo-img"
                :src="p.thumbnailUrl"
                mode="aspectFill"
                lazy-load
              />
              <view v-else class="photo-placeholder" :class="placeholderClass(idx)"></view>
            </view>
            <!-- 补齐最后一排空格（与原型一致：3 列网格补全） -->
            <view
              v-for="pad in padCount(g)"
              :key="'pad-' + g.date + '-' + pad"
              class="photo-item photo-pad"
            ></view>
          </view>
        </view>

        <!-- 加载更多状态 -->
        <view v-if="photos.length > 0" class="load-more">
          <text v-if="loadingMore">加载中…</text>
          <text v-else-if="hasMore">上拉加载更多</text>
          <text v-else>没有更多了</text>
        </view>
      </template>
    </view>
  </view>
</template>

<script>
import memoApi from '../../utils/memoApi'

// 无缩略图时的渐变占位（照原型 ph-* 色系，循环复用）
const PLACEHOLDER_CLASSES = [
  'ph-1',
  'ph-2',
  'ph-3',
  'ph-4',
  'ph-5',
  'ph-6',
]

const PAGE_SIZE = 100

export default {
  data() {
    return {
      loggedIn: false,
      photos: [],
      page: 1,
      hasMore: false,
      loaded: false,
      loadingMore: false,
      expanded: {}, // 日期 → 是否展开（默认收起显示一排，照原型）
    }
  },
  computed: {
    // 按日期分组：优先 takenAt，缺失回退 uploadTime（照原型 buildDateGroups）
    groups() {
      const groups = []
      const map = {}
      this.photos.forEach((p) => {
        const t = this.parseTime(p.takenAt) || this.parseTime(p.uploadTime)
        const key = t ? this.formatDateKey(t) : '未知日期'
        if (!map[key]) {
          map[key] = []
          groups.push({ date: key, list: map[key] })
        }
        map[key].push(p)
      })
      return groups
    },
  },
  onShow() {
    if (!memoApi.isLoggedIn()) {
      this.loggedIn = false
      return
    }
    // 从登录页返回：首次进入或登录态变化时加载
    if (!this.loggedIn || !this.loaded) {
      this.loggedIn = true
      this.loadFirstPage(true)
    }
  },
  onPullDownRefresh() {
    this.loadFirstPage(true)
  },
  onReachBottom() {
    this.loadMore()
  },
  methods: {
    /* ===== 数据加载 ===== */
    loadFirstPage(showLoading) {
      if (!memoApi.isLoggedIn()) return
      if (showLoading) uni.showLoading({ title: '加载中' })
      memoApi
        .get('/photos/mine?sortBy=time&page=1&pageSize=' + PAGE_SIZE)
        .then((data) => {
          this.photos = (data && data.list) || []
          this.page = (data && data.page) || 1
          this.hasMore = !!(data && data.hasMore)
          this.loaded = true
          this.loadingMore = false
        })
        .catch(() => {
          this.loaded = true
        })
        .finally(() => {
          uni.hideLoading()
          uni.stopPullDownRefresh()
        })
    },
    loadMore() {
      if (!this.loaded || !this.hasMore || this.loadingMore) return
      this.loadingMore = true
      memoApi
        .get('/photos/mine?sortBy=time&page=' + (this.page + 1) + '&pageSize=' + PAGE_SIZE)
        .then((data) => {
          if (!data || !data.list) return
          const existing = new Set(this.photos.map((p) => p.id))
          const fresh = data.list.filter((p) => !existing.has(p.id))
          this.photos = this.photos.concat(fresh)
          this.page = data.page
          this.hasMore = !!data.hasMore
        })
        .catch(() => {})
        .finally(() => {
          this.loadingMore = false
        })
    },

    /* ===== 分组/渲染辅助（照原型 buildDateGroups） ===== */
    parseTime(t) {
      if (!t) return null
      const d = new Date(t)
      return isNaN(d.getTime()) ? null : d
    },
    // 日期文案：2026年7月23日
    formatDateKey(d) {
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
    },
    isExpanded(date) {
      return !!this.expanded[date]
    },
    toggleGroup(date) {
      this.expanded[date] = !this.expanded[date]
    },
    // 收起时只显示一排（3 个），照原型默认折叠视觉
    groupPhotos(g) {
      return this.isExpanded(g.date) ? g.list : g.list.slice(0, 3)
    },
    // 补齐最后一排空格数
    padCount(g) {
      const shown = this.groupPhotos(g).length
      return (3 - (shown % 3)) % 3
    },
    placeholderClass(idx) {
      return PLACEHOLDER_CLASSES[idx % PLACEHOLDER_CLASSES.length]
    },

    /* ===== 交互 ===== */
    handlePhotoTap(p) {
      // 照片详情页后续阶段开放
      uni.showToast({ title: '照片详情将在后续阶段开放', icon: 'none' })
    },
    goLogin() {
      uni.reLaunch({ url: '/pages/login/login' })
    },
  },
}
</script>

<style>
.page {
  min-height: 100vh;
  background: linear-gradient(165deg, #f8ecd8 0%, #f3dcb4 100%);
  padding: 24rpx 24rpx 40rpx;
  box-sizing: border-box;
}

/* ===== 未登录引导 ===== */
.login-guide {
  min-height: 80vh;
  display: flex;
  align-items: center;
  justify-content: center;
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

/* ===== 加载中 / 空状态 ===== */
.state-tip {
  padding: 120rpx 40rpx;
  text-align: center;
  font-size: 26rpx;
  color: #6b4423;
}
.state-emoji {
  font-size: 72rpx;
  margin-bottom: 16rpx;
}
.state-text {
  color: #6b4423;
}

/* ===== 日期分组（照原型 album-prototype.html 结构） ===== */
.date-section {
  margin-bottom: 8rpx;
}
.date-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18rpx 8rpx 14rpx;
}
.date-info {
  display: flex;
  align-items: center;
}
.date-text {
  font-size: 28rpx;
  font-weight: 600;
  color: #1c0f08;
}
.date-count {
  font-size: 22rpx;
  color: rgba(107, 68, 35, 0.6);
  font-weight: 500;
  margin-left: 12rpx;
  background: rgba(212, 165, 116, 0.25);
  border-radius: 18rpx;
  padding: 2rpx 14rpx;
}
.date-arrow {
  width: 44rpx;
  height: 44rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(107, 68, 35, 0.55);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.date-arrow.expanded {
  transform: rotate(90deg);
  color: #e89020;
}
.arrow-icon {
  font-size: 40rpx;
  line-height: 1;
}

/* ===== 照片网格（3 列、gap 2px，照原型） ===== */
.photo-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4rpx;
  border-radius: 16rpx;
  overflow: hidden;
}
.photo-item {
  width: calc((100% - 8rpx) / 3);
  height: calc((100vw - 56rpx) / 3);
  background: #1a1a1a;
  overflow: hidden;
  position: relative;
}
.photo-img {
  width: 100%;
  height: 100%;
  display: block;
}
.photo-pad {
  visibility: hidden;
}

/* 无图渐变占位（照原型 ph-classroom / ph-lecture / ph-portrait 色系） */
.photo-placeholder {
  width: 100%;
  height: 100%;
}
.ph-1 {
  background: linear-gradient(135deg, #3a4a5c 0%, #2c3e50 40%, #5d6d7e 100%);
}
.ph-2 {
  background: linear-gradient(160deg, #4a5568 0%, #2d3748 50%, #1a202c 100%);
}
.ph-3 {
  background: linear-gradient(145deg, #5c4033 0%, #3e2723 50%, #2d1810 100%);
}
.ph-4 {
  background: linear-gradient(150deg, #4a3728 0%, #3e2a1f 40%, #2d1f15 100%);
}
.ph-5 {
  background: linear-gradient(135deg, #3d4f5f 0%, #2c3e50 60%, #1a252f 100%);
}
.ph-6 {
  background: linear-gradient(140deg, #8b7355 0%, #6b5544 40%, #4a3728 100%);
}

/* ===== 加载更多 ===== */
.load-more {
  padding: 32rpx 0 16rpx;
  text-align: center;
  font-size: 24rpx;
  color: rgba(107, 68, 35, 0.6);
}
</style>
