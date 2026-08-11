package uni_modules.ftp_receiver.utssdk.app_android

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * HotspotIp.kt —— 热点网段 IP 枚举（设计文档 5.4）
 *
 * 返回热点 AP 网卡地址（相机可直连的网关 IP），而非蜂窝数据地址。
 * 优先级：已知热点网段 → 兜底第一个非回环 IPv4。
 *
 * 已知热点网段：
 *  - 192.168.43.0/24（Android 默认热点）
 *  - 192.168.232.0/24（部分厂商）
 *  - 172.20.10.0/24（iPhone 热点——开发期用 iPhone 开热点时的场景）
 */
object HotspotIp {

    private val preferredPrefixes = listOf("192.168.43.", "192.168.232.", "172.20.10.")

    /** @return 热点 IPv4 地址；未找到返回 null（调用方按 L6 处理：绑定 0.0.0.0 + 警告事件） */
    fun findHotspotIp(): String? {
        var fallback: String? = null
        val interfaces = try {
            NetworkInterface.getNetworkInterfaces()
        } catch (e: Exception) {
            null // 无 INTERNET 权限或平台异常，按未找到处理
        } ?: return null

        for (iface in interfaces) {
            try {
                if (!iface.isUp || iface.isLoopback) continue
                val addrs = iface.inetAddresses
                while (addrs.hasMoreElements()) {
                    val a = addrs.nextElement()
                    if (a !is Inet4Address || a.isLoopbackAddress) continue
                    val ip = a.hostAddress ?: continue
                    if (fallback == null) fallback = ip
                    if (preferredPrefixes.any { ip.startsWith(it) }) return ip
                }
            } catch (_: Exception) {
                // 单接口枚举失败不致命，继续
            }
        }
        return fallback
    }
}
