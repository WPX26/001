package io.dcloud.uni_modules.uts_screencontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * 无障碍手势注入服务：把控制端 B 的点击/滑动/长按/系统键
 * 通过 dispatchGesture / performGlobalAction 注入到 A 机真实屏幕。
 * 需用户在系统设置中开启本 App 的无障碍服务。
 */
class ScreenControlAccessibilityService : AccessibilityService() {
  companion object {
    var instance: ScreenControlAccessibilityService? = null
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  override fun onInterrupt() {}

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun dispatch(desc: GestureDescription, tag: String) {
    try {
      dispatchGesture(desc, object : AccessibilityService.GestureResultCallback() {
        override fun onCompleted(g: GestureDescription?) { Log.d("ScreenControl", tag + " 手势已执行") }
        override fun onCancelled(g: GestureDescription?) { Log.w("ScreenControl", tag + " 手势被取消(目标窗口不可触或有保护)") }
      }, Handler(Looper.getMainLooper()))
    } catch (e: Exception) { Log.e("ScreenControl", tag + " 手势异常: " + e.message) }
  }

  fun gestureTap(x: Float, y: Float) {
    val path = Path()
    path.moveTo(x, y)
    val stroke = GestureDescription.StrokeDescription(path, 0, 80)
    dispatch(GestureDescription.Builder().addStroke(stroke).build(), "tap")
  }

  fun gestureSwipe(x1: Float, y1: Float, x2: Float, y2: Float, duration: Long) {
    val path = Path()
    path.moveTo(x1, y1)
    path.lineTo(x2, y2)
    val stroke = GestureDescription.StrokeDescription(path, 0, if (duration > 0) duration else 300)
    dispatch(GestureDescription.Builder().addStroke(stroke).build(), "swipe")
  }

  fun gestureLongPress(x: Float, y: Float) {
    val path = Path()
    path.moveTo(x, y)
    val stroke = GestureDescription.StrokeDescription(path, 0, 600)
    dispatch(GestureDescription.Builder().addStroke(stroke).build(), "longpress")
  }
}
