package uni_modules.ftp_receiver.utssdk.app_android

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * FtpDataChannel.kt —— PASV/PORT 数据连接与 STOR 流式接收（设计文档 5.x）
 *
 * 全部方法异步执行（独立线程池），结果通过 onEvent 回调回注状态机：
 *  - openListen：PASV 绑定随机端口 → dataListening(port) → accept（30s 超时）→ dataAccepted / dataTimeout
 *  - connect：PORT 主动连相机（H1 有界重试 3×500ms，单次超时 5s）→ dataConnected / dataConnectFailed
 *  - receive：从已就绪数据连接读流写盘（64KB 缓冲）→ dataComplete(size) / transferStalled / transferFailed
 *    （对端中途关闭 → SocketException/EOF → 按 "peerClosed" 上报，由上层决定映射）
 *
 * 线程安全：close() 幂等；回调保证最多一次。
 */
class FtpDataChannel(
    private val onEvent: (kind: String, payload: JSONObject) -> Unit
) {
    companion object {
        /** 流式写盘/读取缓冲（设计文档 5.3：64KB） */
        private const val BUFFER_SIZE = 64 * 1024
        /** PASV 监听等待数据连接超时（文档 4.7：30s） */
        private const val PASV_TIMEOUT_MS = 30_000L
        /** 数据传输无进展超时（文档 4.7：60s） */
        private const val STALL_TIMEOUT_MS = 60_000L
        /** PORT 主动连接单次超时 */
        private const val CONNECT_TIMEOUT_MS = 5_000
        /** PORT 有界重试次数与间隔（H1：相机可能延迟绑定数据端口） */
        private const val CONNECT_RETRIES = 3
        private const val CONNECT_RETRY_DELAY_MS = 500L
    }

    private val executor: ExecutorService = Executors.newCachedThreadPool()

    @Volatile
    private var passiveServer: ServerSocket? = null

    @Volatile
    private var dataSocket: Socket? = null

    @Volatile
    private var closed = false

    /**
     * PASV 数据监听：绑定随机端口 → 回注 dataListening(port)；accept（30s）→ dataAccepted / dataTimeout。
     * 绑定地址优先热点 IP，失败回退 0.0.0.0。
     */
    fun openListen(hotspotIp: String) {
        executor.execute {
            var server: ServerSocket? = null
            try {
                server = ServerSocket()
                server!!.reuseAddress = true
                val addr = try {
                    if (hotspotIp.isNotEmpty()) InetAddress.getByName(hotspotIp) else InetAddress.getByName("0.0.0.0")
                } catch (e: Exception) {
                    InetAddress.getByName("0.0.0.0")
                }
                server!!.bind(InetSocketAddress(addr, 0)) // 随机端口
                passiveServer = server
                onEvent("dataListening", JSONObject().put("port", server!!.localPort))

                server!!.soTimeout = PASV_TIMEOUT_MS.toInt()
                val sock = server!!.accept() // SocketTimeoutException → dataTimeout
                if (closed) {
                    sock.close()
                    return@execute
                }
                dataSocket = sock
                onEvent("dataAccepted", JSONObject())
            } catch (e: SocketTimeoutException) {
                if (!closed) onEvent("dataTimeout", JSONObject())
            } catch (_: IOException) {
                // 被 close() 打断等，忽略（closed 已置位）
            } catch (_: Exception) {
                if (!closed) onEvent("dataTimeout", JSONObject())
            } finally {
                try {
                    server?.close()
                } catch (_: IOException) {
                }
            }
        }
    }

    /**
     * PORT 主动连接（H1）：
     *  - host 由状态机保证为控制连接对端 IP（相机 LAN 地址），此处只负责连接；
     *  - 有界重试 CONNECT_RETRIES 次（间隔 500ms），全部失败才回注 dataConnectFailed。
     */
    fun connect(host: String, port: Int) {
        executor.execute {
            var lastError: Exception? = null
            for (attempt in 0 until CONNECT_RETRIES) {
                if (closed) return@execute
                if (attempt > 0) {
                    try {
                        Thread.sleep(CONNECT_RETRY_DELAY_MS)
                    } catch (_: InterruptedException) {
                        return@execute
                    }
                }
                try {
                    val s = Socket()
                    s.soTimeout = STALL_TIMEOUT_MS.toInt()
                    s.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
                    if (closed) {
                        try {
                            s.close()
                        } catch (_: IOException) {
                        }
                        return@execute
                    }
                    dataSocket = s
                    onEvent("dataConnected", JSONObject())
                    return@execute
                } catch (e: Exception) {
                    lastError = e
                }
            }
            if (!closed) {
                onEvent("dataConnectFailed", JSONObject())
            }
        }
    }

    /**
     * STOR 流式写盘（设计文档 5.3）：
     * 从数据连接读流边收边写（64KB 缓冲），完成后 onComplete(实际字节数)。
     * 失败上报 kind：stall（60s 无数据）/ peerClosed（对端中途关闭）/ io（写盘 IOException）。
     */
    fun receive(partFile: File, onComplete: (Long) -> Unit, onFailure: (String) -> Unit) {
        executor.execute {
            val s = dataSocket
            if (s == null) {
                onFailure("io")
                return@execute
            }
            var total = 0L
            try {
                val input = BufferedInputStream(s.getInputStream(), BUFFER_SIZE)
                val output = FileOutputStream(partFile)
                val buf = ByteArray(BUFFER_SIZE)
                try {
                    var n: Int
                    while (input.read(buf).also { n = it } != -1) {
                        output.write(buf, 0, n)
                        total += n
                    }
                    output.flush()
                } finally {
                    output.close()
                }
                if (closed) {
                    onFailure("peerClosed")
                    return@execute
                }
                onComplete(total)
            } catch (e: SocketTimeoutException) {
                onFailure("stall")
            } catch (e: SocketException) {
                onFailure("peerClosed")
            } catch (e: IOException) {
                onFailure("io")
            } catch (e: Exception) {
                onFailure("io")
            }
        }
    }

    /** 关闭数据通道（幂等）：打断 accept/connect/read，执行器收尾。 */
    fun close() {
        closed = true
        try {
            passiveServer?.close()
        } catch (_: IOException) {
        }
        try {
            dataSocket?.close()
        } catch (_: IOException) {
        }
        executor.shutdown()
    }
}
