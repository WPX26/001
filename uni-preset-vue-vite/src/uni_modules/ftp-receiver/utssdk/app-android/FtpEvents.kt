package uni_modules.ftp_receiver.utssdk.app_android

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * FtpEvents.kt —— 原生事件 → UTS 层回调桥（设计文档 5.5，M7）
 *
 * 桥接方向：原生 Kotlin（FtpServer/FtpForegroundService）→ UTS 层（app-android/index.uts）。
 * 采用「静态 Lambda 槽 + 主线程 Handler」模式：
 *  - UTS 层在 startServer/onEvent 时调用 setListener 注入回调（UTS → Kotlin 赋值，官方支持）；
 *  - 原生层 emit(kind, payload) 统一在主线程派发，JS 回调不涉及线程竞争。
 *
 * 事件通道约定：
 *  - 业务事件：connected / transferring / fileReceived / disconnected / error
 *  - 服务编排（Promise 信号）：__ready / __startError / __stopped（UTS 层消费，不派发给 JS）
 */
object FtpEvents {
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var listener: ((String, JSONObject) -> Unit)? = null

    /** UTS 层注册监听（全局唯一；多次注册覆盖）。传 null 解除。 */
    fun setListener(l: ((String, JSONObject) -> Unit)?) {
        listener = l
    }

    /** 派发事件：一律切主线程，payload 由调用方构造（避免跨线程修改同一对象）。 */
    fun emit(kind: String, payload: JSONObject) {
        val snapshot = payload.toString()
        mainHandler.post {
            listener?.invoke(kind, JSONObject(snapshot))
        }
    }
}
