package io.dcloud.uni_modules.uts_screencontrol

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.Log

import java.io.ByteArrayOutputStream

/**
 * 录屏前台服务：MediaProjection + VirtualDisplay + ImageReader
 * 逐帧 RGBA→JPEG→base64 dataURL，约 5fps 回调给 frameCallback。
 */
class ScreenControlService : Service() {
  companion object {
    private const val CHANNEL_ID = "screencontrol"
    private const val NOTIF_ID = 41002
    private const val TAG = "ScreenControl"
    /** App 层注册的帧回调 */
    var frameCallback: ((String) -> Unit)? = null
    var isRunning = false
  }

  private var mediaProjection: MediaProjection? = null
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var handler: Handler? = null
  private var lastTs = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    handler = Handler(Looper.getMainLooper())
    createChannel()
  }

  @Suppress("DEPRECATION")
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForegroundCompat()
    val code = intent?.getIntExtra("resultCode", 0) ?: 0
    val data = if (Build.VERSION.SDK_INT >= 33) {
      intent?.getParcelableExtra("resultData", Intent::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent?.getParcelableExtra("resultData")
    }
    if (code == Activity.RESULT_OK && data != null) {
      val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      mediaProjection = mpm.getMediaProjection(code, data)
      startCapture()
    }
    return START_STICKY
  }

  private fun startForegroundCompat() {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIF_ID, notification)
    }
  }

  private fun startCapture() {
    val size = ScreenControl.realScreenSize()
    val width = size[0]
    val height = size[1]
    val density = resources.displayMetrics.densityDpi

    val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
    reader.setOnImageAvailableListener({ r ->
      val now = System.currentTimeMillis()
      if (now - lastTs >= 200) {
        // 到帧间隔：取一帧 RGBA → JPEG → base64 回调
        lastTs = now
        val image = r.acquireLatestImage()
        if (image != null) {
          try {
            val buffer = image.planes[0].buffer
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(buffer)
            val baos = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 60, baos)
            bitmap.recycle()
            val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
            frameCallback?.invoke("data:image/jpeg;base64," + b64)
          } catch (e: Exception) {
            Log.e(TAG, "frame error: " + e.message)
          } finally {
            try { image.close() } catch (e: Exception) {}
          }
        }
      } else {
        // 未到间隔：丢弃这一帧
        try { r.acquireLatestImage()?.close() } catch (e: Exception) {}
      }
    }, handler)

    imageReader = reader
    virtualDisplay = mediaProjection?.createVirtualDisplay(
      "ScreenControl",
      width, height, density,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
      reader.surface,
      null,
      handler
    )
    isRunning = true
  }

  private fun createChannel() {
    try {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val ch = NotificationChannel(CHANNEL_ID, "屏幕共享", NotificationManager.IMPORTANCE_LOW)
      nm.createNotificationChannel(ch)
    } catch (e: Exception) {}
  }

  @Suppress("DEPRECATION")
  private fun buildNotification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    builder.setContentTitle("地图相册 · 屏幕共享中")
      .setContentText("正在向控制端共享屏幕画面，可在控制端远程操作")
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
    return builder.build()
  }

  override fun onDestroy() {
    stopCapture()
    super.onDestroy()
  }

  private fun stopCapture() {
    isRunning = false
    try { virtualDisplay?.release() } catch (e: Exception) {}
    virtualDisplay = null
    try { imageReader?.close() } catch (e: Exception) {}
    imageReader = null
    try { mediaProjection?.stop() } catch (e: Exception) {}
    mediaProjection = null
    frameCallback = null
  }
}
