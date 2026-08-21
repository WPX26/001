package io.dcloud.uni_modules.uts_screencontrol

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityManager
import io.dcloud.uts.UTSAndroid

/**
 * 屏控编排对象（UTS 原生混编）：被 app-android/index.uts 以 UTS 方式调用。
 * 返回值一律用 Int 状态码，文案由 UTS 层组装，避免跨语言传递 UTS 接口对象。
 */
object ScreenControl {

  /** 开始录屏。返回 0=已开始/已在共享，3=启动授权页失败 */
  fun tryStart(activity: Activity, onFrame: (String) -> Unit): Int {
    if (ScreenControlService.isRunning) {
      ScreenControlService.frameCallback = onFrame
      return 0
    }
    ScreenControlService.frameCallback = onFrame
    if (Build.VERSION.SDK_INT >= 33) {
      try {
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41003)
        }
      } catch (_: Exception) {}
    }
    ScreenShareRequestActivity.onResult = { code, data ->
      val act = UTSAndroid.getUniActivity() ?: activity
      if (code == Activity.RESULT_OK && data != null) {
        val intent = Intent(act, ScreenControlService::class.java)
        intent.putExtra("resultCode", code)
        intent.putExtra("resultData", data)
        try {
          act.startForegroundService(intent)
        } catch (_: Exception) {
          try { act.startService(intent) } catch (_: Exception) {}
        }
      } else {
        ScreenControlService.frameCallback = null
      }
    }
    return try {
      activity.startActivity(Intent(activity, ScreenShareRequestActivity::class.java))
      0
    } catch (_: Exception) {
      3
    }
  }

  /** 停止录屏（前台服务与投影一并释放） */
  fun stop(activity: Activity?) {
    if (activity != null) {
      try {
        activity.stopService(Intent(activity, ScreenControlService::class.java))
      } catch (_: Exception) {}
    }
    ScreenControlService.frameCallback = null
  }

  /** 真实整屏尺寸（含状态栏/导航栏）。截屏与手势坐标统一用它，保证 B 端点选位置准确 */
  fun realScreenSize(): IntArray {
    val activity = try { UTSAndroid.getUniActivity() } catch (_: Exception) { null }
    if (activity != null) {
      try {
        if (Build.VERSION.SDK_INT >= 30) {
          val b = activity.windowManager.currentWindowMetrics.bounds
          if (b.width() > 0 && b.height() > 0) return intArrayOf(b.width(), b.height())
        } else {
          val dm = android.util.DisplayMetrics()
          @Suppress("DEPRECATION")
          activity.windowManager.defaultDisplay.getRealMetrics(dm)
          if (dm.widthPixels > 0 && dm.heightPixels > 0) return intArrayOf(dm.widthPixels, dm.heightPixels)
        }
      } catch (_: Exception) {}
    }
    return intArrayOf(1080, 1920)
  }

  /** 注入手势。返回 0=成功，1=无障碍未开启，4=未知手势 */
  fun injectGesture(action: String, x: Number?, y: Number?, x2: Number?, y2: Number?, duration: Number?): Int {
    val svc = ScreenControlAccessibilityService.instance
    if (svc == null) return 1
    val size = realScreenSize()
    val w = size[0]
    val h = size[1]
    when (action) {
      "back" -> svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
      "home" -> svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
      "recent" -> svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS)
      "tap" -> {
        val px = (x ?: 0.5).toFloat() * w.toFloat()
        val py = (y ?: 0.5).toFloat() * h.toFloat()
        svc.gestureTap(px, py)
      }
      "longpress" -> {
        val px = (x ?: 0.5).toFloat() * w.toFloat()
        val py = (y ?: 0.5).toFloat() * h.toFloat()
        svc.gestureLongPress(px, py)
      }
      "swipe" -> {
        val px1 = (x ?: 0.5).toFloat() * w.toFloat()
        val py1 = (y ?: 0.5).toFloat() * h.toFloat()
        val px2 = (x2 ?: x ?: 0.5).toFloat() * w.toFloat()
        val py2 = (y2 ?: y ?: 0.5).toFloat() * h.toFloat()
        val dur = (duration ?: 300.0).toLong()
        svc.gestureSwipe(px1, py1, px2, py2, dur)
      }
      else -> return 4
    }
    return 0
  }

  /** 跳转系统无障碍设置页 */
  fun openAccessibility(activity: Activity?) {
    if (activity != null) {
      try {
        activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
      } catch (_: Exception) {}
    }
  }

  /** 本 App 的无障碍服务是否已开启 */
  fun isEnabled(activity: Activity?): Boolean {
    if (activity == null) return false
    return try {
      val am = activity.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
      val list = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
      var i = 0
      while (i < list.size) {
        val pkg = list.get(i).resolveInfo?.serviceInfo?.packageName ?: ""
        if (pkg == activity.packageName) return true
        i++
      }
      false
    } catch (_: Exception) {
      false
    }
  }
}
