package uni_modules.ftp_receiver.utssdk.app_android

import android.content.Context
import android.os.PowerManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * FtpServer.kt —— 控制连接 ServerSocket 监听 + 单会话管理 + 状态机桥接（设计文档 5.x）
 *
 * 职责：
 *  - 绑定监听端口（热点 IP 优先，回退 0.0.0.0），accept 循环（单会话串行，文档 4.7 并发策略）
 *  - 会话内：控制连接读写 + 经 FtpProtocolBridge 调用 UTS 状态机，执行返回的 responses/effects
 *  - 定时器矩阵（M1）：控制空闲 60s（TRANSFER 期间挂起）、待 STOR 30s、传输 stall 60s（数据通道内）
 *  - 传输级 PartialWakeLock（M3：传输开始获取 / 结束释放，acquire(10min) 兜底防泄漏）
 *  - effects 执行器：openDataListen/connectData/receiveFile/discardTemp/closeData/closeControl/
 *    emitFileReceived/emitTransferring/emitError（M9 错误统一由状态机 effect 产出）
 *
 * 启动错误（onError 回调）：1000 端口占用/绑定失败（含 <1024 个别 ROM EACCES，H3）、1006 其他。
 * 无热点 IP（L6）：仍绑定 0.0.0.0 正常启动，onReady 后发 error(1006) 警告事件。
 */
class FtpServer(
    private val options: ServerOptions,
    private val context: Context,
    private val ip: String
) {
    companion object {
        private const val TAG = "FtpServer"
        /** 控制连接空闲超时（文档 4.7：60s） */
        private const val CTRL_IDLE_TIMEOUT_MS = 60_000
        /** 数据连接就绪后等待 STOR 超时（M1：30s） */
        private const val WAIT_STOR_TIMEOUT_MS = 30_000L
        /** 传输级 wakelock 兜底时长（M3：10 分钟） */
        private const val WAKELOCK_TIMEOUT_MS = 10 * 60 * 1000L
        private const val WAKELOCK_TAG = "ftp-receiver:transfer"
        /** 桥调用失败时的兜底结果（按 fatal 处理） */
        private val EMPTY_FATAL: String = """{"responses":[],"effects":[],"fatal":true}"""
    }

    data class ServerOptions(
        val port: Int,
        val dirSpec: String,
        val user: String,
        val pass: String
    )

    private val store = FtpStore(context)
    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val stopped = AtomicBoolean(false)

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var sessionActive = false
    private val sessionLock = Object()

    @Volatile
    private var controlSocket: Socket? = null

    @Volatile
    private var dataChannel: FtpDataChannel? = null

    @Volatile
    private var receiving = false // 是否处于 receiveFile 中（waitStor 定时器判定用）
    private var waitStorTimer: Thread? = null

    private val writeLock = Object()

    private var wakeLock: PowerManager.WakeLock? = null

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    /**
     * 启动监听。
     * @param onReady 端口绑定成功、accept 循环已开始（可接收连接）
     * @param onStartError 启动失败（code/message），服务应自行收尾
     */
    fun start(onReady: (() -> Unit)?, onStartError: ((code: Int, message: String) -> Unit)?) {
        executor.execute {
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                val bindAddr = try {
                    if (ip.isNotEmpty()) InetAddress.getByName(ip) else InetAddress.getByName("0.0.0.0")
                } catch (e: Exception) {
                    InetAddress.getByName("0.0.0.0")
                }
                ss.bind(InetSocketAddress(bindAddr, options.port))
                serverSocket = ss
                onReady?.invoke()
                if (ip.isEmpty()) {
                    // L6：未检测到热点 IP 的警告（服务级特例，不属协议错误，原生层直接发出）
                    FtpEvents.emit("error", JSONObject()
                        .put("code", 1006)
                        .put("message", "未检测到热点网段 IP，请确认已开启手机热点"))
                }
                acceptLoop(ss)
            } catch (e: BindException) {
                onStartError?.invoke(1000, "端口 " + options.port + " 被占用或无权绑定（" + e.message + "）")
            } catch (e: IOException) {
                onStartError?.invoke(1000, "端口绑定失败（" + e.message + "）")
            } catch (e: Exception) {
                onStartError?.invoke(1006, "服务启动失败（" + e.message + "）")
            }
        }
    }

    /** 停止：关闭监听与活跃会话（stopForeground/stopSelf 由 FGS 负责）。 */
    fun stop() {
        stopped.set(true)
        try {
            serverSocket?.close()
        } catch (_: IOException) {
        }
        synchronized(sessionLock) {
            controlSocket?.let { closeQuietly(it) }
            dataChannel?.close()
        }
        releaseWake()
        executor.shutdown()
    }

    // ------------------------------------------------------------------
    // accept 循环（单会话串行，文档 4.7）
    // ------------------------------------------------------------------

    private fun acceptLoop(ss: ServerSocket) {
        while (!stopped.get()) {
            val client = try {
                ss.accept()
            } catch (e: IOException) {
                break // 服务关闭
            }
            synchronized(sessionLock) {
                if (sessionActive) {
                    // 会话互斥：响应 421 并关闭（用例 #27）
                    try {
                        client.getOutputStream().write("421 Too many users\r\n".toByteArray())
                        client.getOutputStream().flush()
                    } catch (_: IOException) {
                    }
                    closeQuietly(client)
                    continue
                }
                sessionActive = true
            }
            handleSession(client)
            synchronized(sessionLock) {
                sessionActive = false
            }
        }
    }

    // ------------------------------------------------------------------
    // 单会话处理
    // ------------------------------------------------------------------

    private fun handleSession(client: Socket) {
        controlSocket = client
        receiving = false
        val clientId = (client.inetAddress?.hostAddress ?: "?") + ":" + client.port // L4：ip:port

        // 新会话重置状态机（凭据 + 热点 IP + 对端 IP）
        val config = JSONObject()
            .put("user", options.user)
            .put("pass", options.pass)
            .put("ip", ip)
            .put("peerIp", client.inetAddress?.hostAddress ?: "")
        FtpProtocolBridge.resetImpl?.invoke(config.toString())

        try {
            client.soTimeout = CTRL_IDLE_TIMEOUT_MS
            val reader = BufferedReader(InputStreamReader(client.getInputStream(), StandardCharsets.ISO_8859_1))
            val writer = client.getOutputStream()
            writeLine(writer, "220 FTP receiver ready")

            FtpEvents.emit("connected", JSONObject().put("client", clientId))

            var line: String?
            while (!stopped.get()) {
                line = try {
                    reader.readLine()
                } catch (e: SocketTimeoutException) {
                    // 控制空闲超时（TRANSFER 期间已挂起 soTimeout，不会走到这里）
                    val r = bridgeEvent("ctrlIdleTimeout", "{}")
                    if (applyResult(r, writer)) break
                    continue
                } catch (e: IOException) {
                    null // 对端关闭
                }
                if (line == null) break
                if (line.isNotEmpty()) {
                    // H1：记录真实相机控制报文（含 PORT 原始行），供真机验证
                    Log.i(TAG, "CMD<$clientId>: $line")
                    val r = FtpProtocolBridge.commandImpl?.invoke(line) ?: EMPTY_FATAL
                    if (applyResult(r, writer)) break
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "session error: " + e.message)
        } finally {
            // 会话收尾：状态机 peerClosed 回注（幂等，CLOSED 状态忽略）→ 执行 discardTemp 等清理
            executeEffects(parseEffects(bridgeEvent("peerClosed", "{}")))
            dataChannel?.close()
            dataChannel = null
            cancelWaitStorTimer()
            releaseWake()
            closeQuietly(client)
            controlSocket = null
            FtpEvents.emit("disconnected", JSONObject().put("client", clientId))
        }
    }

    // ------------------------------------------------------------------
    // 状态机结果应用
    // ------------------------------------------------------------------

    private fun applyResult(resultJson: String, writer: OutputStream): Boolean {
        val json = try {
            JSONObject(resultJson)
        } catch (e: Exception) {
            return true // 桥异常按 fatal 处理
        }
        val responses = json.optJSONArray("responses")
        if (responses != null) {
            for (i in 0 until responses.length()) {
                val resp = responses.optString(i, "")
                if (resp.isNotEmpty()) writeLine(writer, resp)
            }
        }
        executeEffects(json.optJSONArray("effects"))
        return json.optBoolean("fatal", false)
    }

    private fun executeEffects(effects: JSONArray?) {
        if (effects == null) return
        for (i in 0 until effects.length()) {
            val e = effects.optJSONObject(i) ?: continue
            try {
                when (e.getString("kind")) {
                    "openDataListen" -> {
                        cancelWaitStorTimer()
                        suspendCtrlIdle() // LISTENING 期间控制空闲挂起（M1）
                        val ch = FtpDataChannel(::onDataChannelEvent)
                        dataChannel = ch
                        ch.openListen(ip)
                    }
                    "connectData" -> {
                        cancelWaitStorTimer()
                        suspendCtrlIdle()
                        val ch = FtpDataChannel(::onDataChannelEvent)
                        dataChannel = ch
                        ch.connect(e.getString("host"), e.getInt("port"))
                    }
                    "receiveFile" -> startReceive(e.getString("temp"), e.getString("target"))
                    "discardTemp" -> store.discard(store.openPart(e.getString("temp")))
                    "closeData" -> {
                        dataChannel?.close()
                        dataChannel = null
                        cancelWaitStorTimer()
                        resumeCtrlIdle()
                    }
                    "closeControl" -> {
                        // fatal 场景由会话收尾统一关闭控制连接
                    }
                    "emitFileReceived" -> {
                        val meta = e.getJSONObject("meta")
                        val name = meta.getString("name")
                        FtpEvents.emit("fileReceived", JSONObject()
                            .put("path", store.absPath(name))
                            .put("name", name)
                            .put("size", meta.getLong("size")))
                    }
                    "emitTransferring" -> {
                        FtpEvents.emit("transferring", JSONObject()
                            .put("name", e.getString("name"))
                            .put("size", e.getLong("size")))
                    }
                    "emitError" -> {
                        // M9：错误事件统一由状态机 effect 产出
                        FtpEvents.emit("error", JSONObject()
                            .put("code", e.getInt("code"))
                            .put("message", e.optString("message", "")))
                    }
                }
            } catch (ex: Exception) {
                Log.w(TAG, "effect execute failed: " + ex.message)
            }
        }
    }

    // ------------------------------------------------------------------
    // 数据通道事件回注（执行器 → 状态机 → 写回控制流）
    // ------------------------------------------------------------------

    private fun onDataChannelEvent(kind: String, payload: JSONObject) {
        when (kind) {
            "dataListening" -> {
                // 227 由状态机生成，回注结果要写回控制连接
                val r = bridgeEvent("dataListening", payload.toString())
                writeResponsesFrom(r)
                executeEffects(parseEffects(r))
            }
            "dataAccepted", "dataConnected" -> {
                suspendCtrlIdle()
                startWaitStorTimer()
                val r = bridgeEvent(kind, "{}")
                writeResponsesFrom(r)
                executeEffects(parseEffects(r))
            }
            "dataTimeout", "dataConnectFailed" -> {
                cancelWaitStorTimer()
                resumeCtrlIdle()
                val r = bridgeEvent(kind, "{}")
                writeResponsesFrom(r)
                executeEffects(parseEffects(r))
            }
            "dataComplete" -> {
                cancelWaitStorTimer()
                resumeCtrlIdle()
                releaseWake()
                val r = bridgeEvent(kind, payload.toString())
                writeResponsesFrom(r)
                executeEffects(parseEffects(r))
            }
            "transferStalled", "transferFailed" -> {
                resumeCtrlIdle()
                releaseWake()
                val r = bridgeEvent(kind, "{}")
                writeResponsesFrom(r)
                executeEffects(parseEffects(r))
            }
        }
    }

    private fun bridgeEvent(kind: String, payloadJson: String): String {
        return FtpProtocolBridge.eventImpl?.invoke(kind, payloadJson) ?: EMPTY_FATAL
    }

    /** 回注结果中的 responses 写回控制连接（数据线程 → 控制流，加锁） */
    private fun writeResponsesFrom(resultJson: String) {
        val json = try {
            JSONObject(resultJson)
        } catch (e: Exception) {
            return
        }
        val writer = controlSocket?.getOutputStream() ?: return
        val responses = json.optJSONArray("responses")
        if (responses != null) {
            for (i in 0 until responses.length()) {
                val resp = responses.optString(i, "")
                if (resp.isNotEmpty()) writeLine(writer, resp)
            }
        }
    }

    private fun parseEffects(resultJson: String): JSONArray? {
        return try {
            JSONObject(resultJson).optJSONArray("effects")
        } catch (e: Exception) {
            null
        }
    }

    // ------------------------------------------------------------------
    // STOR 写盘（设计文档 5.3）+ wakelock（M3）
    // ------------------------------------------------------------------

    private fun startReceive(temp: String, target: String) {
        cancelWaitStorTimer()
        receiving = true
        acquireWake()
        val part = store.openPart(temp)
        dataChannel?.receive(part,
            onComplete = { bytes ->
                receiving = false
                val final = store.finalize(part, target)
                if (final != null) {
                    onDataChannelEvent("dataComplete", JSONObject().put("size", bytes))
                } else {
                    // rename 失败（极少）：按写盘失败处理（M4/M9 → 450 + error 1005）
                    onDataChannelEvent("transferFailed", JSONObject())
                }
            },
            onFailure = { reason ->
                receiving = false
                when (reason) {
                    "stall" -> onDataChannelEvent("transferStalled", JSONObject())
                    "peerClosed" -> {
                        // 数据连接对端中途关闭：会话终结（状态机 peerClosed 路径会清 .part）
                        bridgeEvent("peerClosed", "{}")
                    }
                    else -> onDataChannelEvent("transferFailed", JSONObject())
                }
            }
        )
    }

    private fun acquireWake() {
        synchronized(this) {
            try {
                if (wakeLock == null) {
                    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
                        setReferenceCounted(false)
                    }
                }
                // M3：传输级持有，10 分钟兜底自动释放防泄漏
                wakeLock?.acquire(WAKELOCK_TIMEOUT_MS)
            } catch (e: Exception) {
                Log.w(TAG, "wake lock acquire failed: " + e.message)
            }
        }
    }

    private fun releaseWake() {
        synchronized(this) {
            try {
                wakeLock?.let {
                    if (it.isHeld) it.release()
                }
            } catch (e: Exception) {
            }
            wakeLock = null
        }
    }

    // ------------------------------------------------------------------
    // 定时器（M1 矩阵）
    // ------------------------------------------------------------------

    /** 控制空闲 60s：TRANSFER 期间挂起（soTimeout=0 即无限），回 LOGGED_IN 后恢复 */
    private fun suspendCtrlIdle() {
        try {
            controlSocket?.soTimeout = 0
        } catch (_: IOException) {
        }
    }

    private fun resumeCtrlIdle() {
        try {
            controlSocket?.soTimeout = CTRL_IDLE_TIMEOUT_MS
        } catch (_: IOException) {
        }
    }

    /** 数据连接就绪后 30s 无 STOR → dataTimeout（M1） */
    private fun startWaitStorTimer() {
        cancelWaitStorTimer()
        val t = Thread {
            try {
                Thread.sleep(WAIT_STOR_TIMEOUT_MS)
            } catch (_: InterruptedException) {
                return@Thread
            }
            if (!stopped.get() && !receiving) {
                onDataChannelEvent("dataTimeout", JSONObject())
            }
        }
        waitStorTimer = t
        t.start()
    }

    private fun cancelWaitStorTimer() {
        waitStorTimer?.interrupt()
        waitStorTimer = null
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    private fun writeLine(writer: OutputStream, line: String) {
        synchronized(writeLock) {
            try {
                writer.write((line + "\r\n").toByteArray(StandardCharsets.ISO_8859_1))
                writer.flush()
            } catch (e: IOException) {
                Log.w(TAG, "write failed: " + e.message)
            }
        }
    }

    private fun closeQuietly(s: Socket) {
        try {
            s.close()
        } catch (_: IOException) {
        }
    }
}
