package io.dcloud.uni_modules.uts_usbcamera

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * 相机互联「UTS USB 传输层」（Android USB Host 直连 PTP 相机）。
 *
 * 逻辑与 browser-usb-transport.js（r24-r68 真机验证）同构：
 *  - 候选接口收集（class=6 PTP 优先，含 bulk IN/OUT 与中断 IN 端点）
 *  - r41 序列：release 容错 -> claimInterface(force=true)
 *  - bulk 读写的 STALL -> clearHalt -> 重试一次
 *  - 中断端点常驻读（ObjectAdded 0x4002 事件通道，r44 结论）
 *  - 连接前弹 USB 权限框（PendingIntent + 广播，阻塞等待在调用线程）
 *
 * 线程模型：所有 USB 命令走单线程 executor（与协议层 _txRun 串行纪律一致），
 * 中断读循环独立线程（不同 endpoint，usbdevfs 层支持并发，与 WebUSB 同模式）。
 *
 * r71 双通道：
 *  - 回调式（connect/bulkOut/bulkIn...）：UTS index.uts -> connect.vue -> uni.postMessage 桥
 *  - 同步式（connectSync/bulkOutSync/...）：web-view 页面 plus.android(Native.js) 直接反射调用
 *    （Native.js 跑在 web-view 独占 JS 线程，天然串行；阻塞该线程不影响 App 主线程）。
 *    中断事件经 ConcurrentLinkedQueue 暂存，由 pollInterrupts() 轮询取走。
 * 全部公开方法 @JvmStatic：Native.js importClass 反射要求静态方法（Kotlin object
 * 默认编译为实例方法 + INSTANCE 字段，不加注解 Native.js 调不到）。
 */
object UsbCamera {

    private const val ACTION_USB_PERMISSION = "io.dcloud.uni_modules.uts_usbcamera.USB_PERMISSION"
    private const val MAX_CHUNK = 1 shl 20 // 1MB 单次读上限（协议层 bulkInCap 指定）
    private const val INTR_QUEUE_MAX = 64  // 中断队列上限（Native.js 轮询消费，防爆内存）

    private val exec = Executors.newSingleThreadExecutor()
    private val intrQueue = ConcurrentLinkedQueue<String>()

    private var connection: UsbDeviceConnection? = null
    private var claimedItf: UsbInterface? = null
    private var epIn: UsbEndpoint? = null
    private var epOut: UsbEndpoint? = null
    private var epIntr: UsbEndpoint? = null
    private val intrRunning = AtomicBoolean(false)
    private var intrThread: Thread? = null
    private val interruptCb = AtomicReference<((String) -> Unit)?>(null)

    @Volatile var lastErr: String = ""
    @Volatile private var candidatesJson: String = "[]"

    // ---------- 设备枚举（JSON 字符串：[{vid,pid,name,serial,hasPerm}]） ----------
    @JvmStatic fun listDevices(ctx: Context): String {
        lastErr = ""
        val mgr = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
        val sb = StringBuilder("[")
        var first = true
        for ((_, dev) in mgr.deviceList) {
            if (!first) sb.append(',')
            first = false
            val serial = try { dev.serialNumber ?: "" } catch (e: Exception) { "" }
            sb.append("{\"vid\":").append(dev.vendorId)
                .append(",\"pid\":").append(dev.productId)
                .append(",\"name\":\"").append(jsonEsc(dev.productName ?: "USB设备")).append("\"")
                .append(",\"serial\":\"").append(jsonEsc(serial)).append("\"")
                .append(",\"hasPerm\":").append(mgr.hasPermission(dev))
                .append("}")
        }
        sb.append("]")
        return sb.toString()
    }

    private fun jsonEsc(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ")

    // ---------- 连接 ----------
    class IfaceInfo(val itf: UsbInterface, val idx: Int, val epIn: UsbEndpoint?, val epOut: UsbEndpoint?, val epIntr: UsbEndpoint?)

    /** 回调式（UTS 桥用）：连接在 exec 线程执行 */
    @JvmStatic fun connect(ctx: Context, deviceId: String, ifaceIdx: Int, cb: (String) -> Unit) {
        exec.execute {
            try {
                cb(doConnect(ctx, deviceId, ifaceIdx))
            } catch (e: Exception) {
                lastErr = "" + e
                cb("{\"ok\":false,\"message\":\"" + jsonEsc("" + e) + "\"}")
            }
        }
    }

    /** 同步式（Native.js 直连用）：在调用线程（web-view JS 线程）执行，返回 JSON */
    @JvmStatic fun connectSync(ctx: Context, deviceId: String, ifaceIdx: Int): String {
        return try {
            doConnect(ctx, deviceId, ifaceIdx)
        } catch (e: Exception) {
            lastErr = "" + e
            "{\"ok\":false,\"message\":\"" + jsonEsc("" + e) + "\"}"
        }
    }

    private fun doConnect(ctx: Context, deviceId: String, ifaceIdx: Int): String {
        // 解析 deviceId：uts:vid:pid:serial（与 browser 版 webusb: 同语义；serial 空/ns/0 = 无序列号）
        val m = Regex("^uts:([0-9a-fA-F]+):([0-9a-fA-F]+)(?::(.*))?$").find(deviceId)
            ?: return fail("非法设备标识: " + deviceId)
        val vid = m.groupValues[1].toInt(16)
        val pid = m.groupValues[2].toInt(16)
        val serial = m.groupValues[3]

        val mgr = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
        var dev: UsbDevice? = null
        for ((_, d) in mgr.deviceList) {
            if (d.vendorId != vid || d.productId != pid) continue
            val sn = try { d.serialNumber ?: "" } catch (e: Exception) { "" }
            if (serial.isEmpty() || serial == "ns" || serial == "0" || sn == serial) { dev = d; break }
        }
        if (dev == null) {
            return fail("未找到设备(vid=0x" + Integer.toHexString(vid) + " pid=0x" + Integer.toHexString(pid) +
                ")：请确认 OTG 线已插紧、相机已开机后重新检测")
        }

        // USB 权限（非 dangerous 组，须显式 requestPermission + 广播；阻塞等待在调用线程，
        // Android 系统弹框/广播走主线程，不与调用线程互锁）
        if (!mgr.hasPermission(dev)) {
            if (!requestPermissionAndWait(ctx, mgr, dev, 25000)) {
                return fail("USB 授权未通过：" + (if (lastErr.isNotEmpty()) lastErr else "用户拒绝或超时"))
            }
        }

        val conn = mgr.openDevice(dev) ?: return fail("openDevice 失败（设备被占用或系统拒绝，请拔插 USB 线重试）")

        val cand = collectCandidates(dev)
        if (cand.isEmpty()) {
            conn.close()
            return fail("未找到可用 PTP 接口（bulk IN/OUT 端点缺失）")
        }
        candidatesJson = "[" + cand.map { c ->
            "{\"iface\":" + c.idx + ",\"cls\":" + c.itf.interfaceClass +
                ",\"epIn\":" + (c.epIn?.address ?: -1) +
                ",\"epOut\":" + (c.epOut?.address ?: -1) +
                ",\"epIntr\":" + (c.epIntr?.address ?: -1) + "}"
        }.joinToString(",") + "]"

        val idx = if (ifaceIdx in cand.indices) ifaceIdx else 0
        val tgt = cand[idx]

        // r41 序列：release 容错 -> claim(force)
        try { conn.releaseInterface(tgt.itf) } catch (e: Exception) { /* 未 claim 接口的 release 安全失败 */ }
        if (!conn.claimInterface(tgt.itf, true)) {
            conn.close()
            return fail("claimInterface 失败（接口被占用或残留态，请拔插 USB 线重试）")
        }

        closeQuiet() // 接管前释放旧连接
        connection = conn
        claimedItf = tgt.itf
        epIn = tgt.epIn
        epOut = tgt.epOut
        epIntr = tgt.epIntr
        lastErr = ""
        startInterruptLoop()
        return "{\"ok\":true,\"message\":\"connected\",\"iface\":" + tgt.idx + ",\"candidates\":" + candidatesJson + "}"
    }

    private fun fail(msg: String): String {
        lastErr = msg
        return "{\"ok\":false,\"message\":\"" + jsonEsc(msg) + "\"}"
    }

    private fun requestPermissionAndWait(ctx: Context, mgr: UsbManager, dev: UsbDevice, timeoutMs: Int): Boolean {
        val latch = CountDownLatch(1)
        var granted = false
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                if (i?.action == ACTION_USB_PERMISSION) {
                    granted = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    latch.countDown()
                }
            }
        }
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                ctx.registerReceiver(receiver, filter)
            }
        } catch (e: Exception) {
            lastErr = "注册广播失败: " + e
            return false
        }
        // Android 12+ 必须 FLAG_MUTABLE（系统要往广播里填 EXTRA_DEVICE 等字段）
        val pi = PendingIntent.getBroadcast(ctx, 0,
            Intent(ACTION_USB_PERMISSION).setPackage(ctx.packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        try {
            mgr.requestPermission(dev, pi)
        } catch (e: Exception) {
            try { ctx.unregisterReceiver(receiver) } catch (ignore: Exception) {}
            lastErr = "发起授权失败: " + e
            return false
        }
        val ok = latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        try { ctx.unregisterReceiver(receiver) } catch (ignore: Exception) {}
        if (!ok) { lastErr = "授权等待超时"; return false }
        return granted
    }

    /** 收集全部候选接口（有 bulk IN+OUT 的接口；class=6 PTP 优先排序）--对齐 browser 版 collectCandidates */
    private fun collectCandidates(dev: UsbDevice): List<IfaceInfo> {
        val list = ArrayList<IfaceInfo>()
        for (i in 0 until dev.interfaceCount) {
            val itf = dev.getInterface(i)
            var epIn: UsbEndpoint? = null
            var epOut: UsbEndpoint? = null
            var epIntr: UsbEndpoint? = null
            for (j in 0 until itf.endpointCount) {
                val ep = itf.getEndpoint(j)
                when (ep.type) {
                    UsbConstants.USB_ENDPOINT_XFER_BULK -> {
                        if (ep.direction == UsbConstants.USB_DIR_IN) { if (epIn == null) epIn = ep }
                        else { if (epOut == null) epOut = ep }
                    }
                    UsbConstants.USB_ENDPOINT_XFER_INTERRUPT -> {
                        if (ep.direction == UsbConstants.USB_DIR_IN && epIntr == null) epIntr = ep
                    }
                }
            }
            if (epIn != null && epOut != null) list.add(IfaceInfo(itf, i, epIn, epOut, epIntr))
        }
        list.sortBy { if (it.itf.interfaceClass == 6) 0 else 1 }
        return list
    }

    // ---------- bulk 读写（STALL -> clearHalt -> 重试一次，对齐 browser 版语义） ----------

    /** 回调式（UTS 桥用） */
    @JvmStatic fun bulkOut(dataB64: String, timeoutMs: Int, cb: (Int) -> Unit) {
        exec.execute { cb(doBulkOut(dataB64, timeoutMs)) }
    }

    /** 同步式（Native.js 直连用）：调用线程执行（web-view JS 线程） */
    @JvmStatic fun bulkOutSync(dataB64: String, timeoutMs: Int): Int = doBulkOut(dataB64, timeoutMs)

    private fun doBulkOut(dataB64: String, timeoutMs: Int): Int {
        val conn = connection
        val ep = epOut
        if (conn == null || ep == null) return -1
        return try {
            val data = Base64.decode(dataB64, Base64.NO_WRAP)
            var n = conn.bulkTransfer(ep, data, data.size, timeoutMs)
            if (n < 0) {
                clearHalt(ep)
                n = conn.bulkTransfer(ep, data, data.size, timeoutMs)
            }
            n
        } catch (e: Exception) {
            lastErr = "bulkOut: " + e
            -1
        }
    }

    /** 回调式（UTS 桥用） */
    @JvmStatic fun bulkIn(maxLen: Int, timeoutMs: Int, cb: (String) -> Unit) {
        exec.execute { cb(doBulkIn(maxLen, timeoutMs)) }
    }

    /** 同步式（Native.js 直连用）：调用线程执行，返回 base64（空串 = 超时/无数据，短包语义） */
    @JvmStatic fun bulkInSync(maxLen: Int, timeoutMs: Int): String = doBulkIn(maxLen, timeoutMs)

    private fun doBulkIn(maxLen: Int, timeoutMs: Int): String {
        val conn = connection
        val ep = epIn
        if (conn == null || ep == null) return ""
        return try {
            val len = maxLen.coerceIn(1, MAX_CHUNK)
            val buf = ByteArray(len)
            var n = conn.bulkTransfer(ep, buf, len, timeoutMs)
            if (n < 0) {
                clearHalt(ep)
                n = conn.bulkTransfer(ep, buf, len, timeoutMs)
            }
            if (n > 0) Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP) else ""
        } catch (e: Exception) {
            lastErr = "bulkIn: " + e
            ""
        }
    }

    /** CLEAR_FEATURE(ENDPOINT_HALT)：bmRequestType=0x02（OUT|Standard|Endpoint），bRequest=0x01，wIndex=端点地址 */
    private fun clearHalt(ep: UsbEndpoint): Boolean {
        val conn = connection ?: return false
        return try {
            conn.controlTransfer(0x02, 0x01, 0, ep.address, null, 0, 3000) == 0
        } catch (e: Exception) { false }
    }

    /** 回调式（UTS 桥用） */
    @JvmStatic fun clearPipe(cb: (Boolean) -> Unit) {
        exec.execute { cb(doClearPipe()) }
    }

    /** 同步式（Native.js 直连用） */
    @JvmStatic fun clearPipeSync(): Boolean = doClearPipe()

    private fun doClearPipe(): Boolean {
        val a = epIn?.let { clearHalt(it) } ?: true
        val b = epOut?.let { clearHalt(it) } ?: true
        return a && b
    }

    // ---------- 中断端点常驻读（ObjectAdded 0x4002 事件通道） ----------

    /** 回调式消费者（UTS 桥：connect.vue setInterruptHandler -> evalJS 推页面） */
    @JvmStatic fun setInterruptHandler(cb: ((String) -> Unit)?) {
        interruptCb.set(cb)
    }

    /**
     * 同步式消费者（Native.js 轮询）：取走全部排队的中断事件，JSON 字符串数组
     * （["base64",...]，空数组 = 无事件）。中断循环同时入队与回调（回调存在时
     * 队列仍在写，pollInterrupts 取走即可，两消费者不会同 APK 并存）。
     */
    @JvmStatic fun pollInterrupts(): String {
        val sb = StringBuilder("[")
        var first = true
        while (true) {
            val b64 = intrQueue.poll() ?: break
            if (!first) sb.append(',')
            first = false
            sb.append('"').append(b64).append('"')
        }
        return sb.append(']').toString()
    }

    private fun startInterruptLoop() {
        val ep = epIntr ?: return // 无中断端点：协议层自动降级为仅 GetEvent 轮询（camera-ptp.js L542）
        intrRunning.set(true)
        intrQueue.clear()
        intrThread = Thread {
            val buf = ByteArray(512)
            while (intrRunning.get()) {
                val conn = connection ?: break
                try {
                    val n = conn.bulkTransfer(ep, buf, buf.size, 250)
                    if (n > 0) {
                        val b64 = Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP)
                        if (intrQueue.size >= INTR_QUEUE_MAX) intrQueue.poll()
                        intrQueue.offer(b64)
                        try { interruptCb.get()?.invoke(b64) } catch (e: Exception) { /* 回调异常不停读 */ }
                    }
                } catch (e: Exception) {
                    try { Thread.sleep(200) } catch (ignore: InterruptedException) { break }
                }
            }
        }
        intrThread?.start()
    }

    // ---------- 释放 ----------

    /** 回调式（UTS 桥用）：exec 线程释放 */
    @JvmStatic fun release() {
        exec.execute { closeQuiet() }
    }

    /** 同步式（Native.js 直连用）：调用线程释放（含中断线程 join，最多阻塞约 0.6s） */
    @JvmStatic fun releaseSync() {
        closeQuiet()
    }

    private fun closeQuiet() {
        intrRunning.set(false)
        try { intrThread?.join(600) } catch (e: Exception) {}
        intrThread = null
        intrQueue.clear()
        try { claimedItf?.let { connection?.releaseInterface(it) } } catch (e: Exception) {}
        claimedItf = null
        try { connection?.close() } catch (e: Exception) {}
        connection = null
        epIn = null
        epOut = null
        epIntr = null
    }

    @JvmStatic fun isConnected(): Boolean = connection != null

    @JvmStatic fun diag(): String =
        "{\"connected\":" + (connection != null) +
            ",\"err\":\"" + jsonEsc(lastErr) + "\",\"candidates\":" + candidatesJson + "}"
