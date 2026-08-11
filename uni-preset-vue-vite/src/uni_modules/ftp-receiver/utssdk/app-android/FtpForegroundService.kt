package uni_modules.ftp_receiver.utssdk.app_android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject

/**
 * FtpForegroundService.kt —— dataSync 前台服务（设计文档 5.2，v1.0 修订）
 *
 * 生命周期：
 *  - ACTION_START：startForeground(type=dataSync) → 创建 FtpServer 并启动监听
 *  - 常驻：通知文案 D8「📷 相机连接中 · 照片实时接收中」；START_STICKY 被杀死后重建，
 *    若持久化配置仍在则自动恢复监听（不重发 ready 事件）
 *  - M2：主动停止（ACTION_STOP / stopServer）时必须清除持久化配置，防 START_STICKY 停了又起
 *  - M6：onTimeout(startId, fgsType)（API 35 双参签名）处理 dataSync 超时上限（24h 累计）：
 *    error(1007) → 停服务；debug-only 钩子 ACTION_SIMULATE_TIMEOUT 提前触发同一流程
 *  - 启动失败：绑定端口失败 → __startError(1000/1006)；startForeground 权限异常 → __startError(1001)
 *
 * 事件通道（FtpEvents.kt）：__ready{ip,port} / __startError{code,message} / __stopped / error
 */
class FtpForegroundService : Service() {

    companion object {
        private const val TAG = "FtpForegroundService"
        const val ACTION_START = "uni_modules.ftp_receiver.ACTION_START"
        const val ACTION_STOP = "uni_modules.ftp_receiver.ACTION_STOP"
        /** M6：debug-only 测试钩子，仅可调试构建处理（验证 onTimeout 流程用） */
        const val ACTION_SIMULATE_TIMEOUT = "uni_modules.ftp_receiver.ACTION_SIMULATE_TIMEOUT"
        const val KEY_OPTIONS = "options_json"
        private const val PREFS = "ftp_receiver_prefs"
        private const val NOTIF_ID = 10001
        private const val CHANNEL_ID = "ftp_server"
    }

    @Volatile
    private var server: FtpServer? = null

    @Volatile
    private var restoring = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val json = intent.getStringExtra(KEY_OPTIONS) ?: prefs().getString(KEY_OPTIONS, null)
                if (json != null) startWithOptions(json, restore = false)
            }
            ACTION_STOP -> stopServerInternal(emitStopped = true)
            ACTION_SIMULATE_TIMEOUT -> {
                // M6：仅可调试构建处理（release 构建被忽略，防止误触发）
                if (isDebuggable()) {
                    Log.i(TAG, "simulate timeout (debug hook)")
                    handleFgsTimeout()
                }
            }
            else -> {
                // START_STICKY 重建（intent.action == null）：持久化配置仍在则恢复监听
                val json = prefs().getString(KEY_OPTIONS, null)
                if (json != null) {
                    startWithOptions(json, restore = true)
                } else {
                    // 无配置（可能 stop 流程被系统打断）：直接收尾
                    stopForegroundCompat()
                    stopSelf()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // 启动
    // ------------------------------------------------------------------

    private fun startWithOptions(optionsJson: String, restore: Boolean) {
        if (server != null) {
            // 已运行，忽略重复启动（1004 由 UTS 层拦截，此处防御）
            return
        }
        val opts = parseOptions(optionsJson)
        if (opts == null) {
            Log.w(TAG, "options parse failed, stop")
            stopForegroundCompat()
            stopSelf()
            return
        }
        restoring = restore
        try {
            startAsForeground()
        } catch (e: Exception) {
            // 1001：FGS 权限缺失（未声明 dataSync 类型 / 系统拒绝）
            Log.w(TAG, "startForeground failed: " + e.message)
            FtpEvents.emit("__startError", JSONObject()
                .put("code", 1001)
                .put("message", "前台服务启动被拒绝（请确认已声明 dataSync 类型前台服务）"))
            stopSelf()
            return
        }

        val ip = HotspotIp.findHotspotIp() ?: ""
        val s = FtpServer(opts, applicationContext, ip)
        server = s
        s.start(
            onReady = {
                // M7：就绪信号经回调桥回注；恢复场景不发（JS 层可能已不在）
                if (!restoring) {
                    FtpEvents.emit("__ready", JSONObject().put("ip", ip).put("port", opts.port))
                }
            },
            onStartError = { code, message ->
                if (!restoring) {
                    FtpEvents.emit("__startError", JSONObject().put("code", code).put("message", message))
                }
                stopServerInternal(emitStopped = false)
            }
        )
    }

    /** M2：主动停止必须清除持久化配置，防 START_STICKY 停了又起 */
    private fun stopServerInternal(emitStopped: Boolean) {
        prefs().edit().remove(KEY_OPTIONS).apply()
        server?.stop()
        server = null
        stopForegroundCompat()
        stopSelf()
        if (emitStopped) {
            FtpEvents.emit("__stopped", JSONObject())
        }
    }

    // ------------------------------------------------------------------
    // M6：dataSync 超时上限（Android 15，API 35）
    // ------------------------------------------------------------------

    /**
     * API 35 回调：dataSync 前台服务运行超时上限（24h 累计）被触发。
     * 注意：此方法仅在高版本系统存在；低版本系统不会调用。
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.i(TAG, "onTimeout startId=$startId fgsType=$fgsType")
        handleFgsTimeout()
    }

    /** 统一超时处理：error(1007) → 停止监听 → 清理 → 停服务（debug 钩子与系统回调共用） */
    private fun handleFgsTimeout() {
        server?.stop()
        server = null
        stopForegroundCompat()
        stopSelf()
        FtpEvents.emit("error", JSONObject()
            .put("code", 1007)
            .put("message", "FTP 服务已运行超 6 小时（Android 15 dataSync 上限），请重新开启"))
    }

    // ------------------------------------------------------------------
    // 通知与前台化
    // ------------------------------------------------------------------

    private fun startAsForeground() {
        createNotificationChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(CHANNEL_ID, "FTP 接收服务", NotificationManager.IMPORTANCE_LOW)
            manager.createNotificationChannel(channel)
        }
    }

    /** D8 文案：「📷 相机连接中 · 照片实时接收中」；图标暂用系统默认，正式版由 UI 侧补充 */
    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("📷 相机连接中")
            .setContentText("照片实时接收中")
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW)
        return builder.build()
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun isDebuggable(): Boolean {
        return try {
            (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        } catch (e: Exception) {
            false
        }
    }

    private fun parseOptions(json: String): FtpServer.ServerOptions? {
        return try {
            val o = JSONObject(json)
            FtpServer.ServerOptions(
                port = o.getInt("port"),
                dirSpec = o.getString("dir"),
                user = o.getString("user"),
                pass = o.getString("pass")
            )
        } catch (e: Exception) {
            null
        }
    }
}
