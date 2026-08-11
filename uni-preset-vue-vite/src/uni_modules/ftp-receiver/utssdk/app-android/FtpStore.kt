package uni_modules.ftp_receiver.utssdk.app_android

import android.content.Context
import java.io.File

/**
 * FtpStore.kt —— 应用私有目录落盘（设计文档 5.3，D5：不做 DCIM 镜像）
 *
 * 职责：
 *  - dir 参数解析：相对路径基于 filesDir；绝对路径必须落在 filesDir 内（canonical 校验，防 ../ 穿越）
 *  - 目录自动创建
 *  - .part 临时文件 + 原子 rename（失败/中断路径由状态机 discardTemp 驱动清理）
 *  - 防御性文件名白名单（与状态机 validateStorName 一致，双保险）
 *  - FtpMachine 的 exists 注入：目标名是否已存在（命名冲突规约用）
 *
 * 全部路径在应用私有目录（filesDir）内，无需任何存储权限。
 */
class FtpStore(private val context: Context) {

    private val filesDir: File
        get() = context.filesDir

    @Volatile
    private var rootDir: File? = null

    /**
     * 解析 dir 参数并缓存根目录。
     * @return 规范化后的根目录；dir 越界（绝对路径不在 filesDir 内 / 相对路径穿越）返回 null（错误码 1003）
     */
    fun resolveRootDir(dirSpec: String): File? {
        val base = filesDir.canonicalFile
        val f = File(dirSpec)
        val canonical = if (f.isAbsolute) f.canonicalFile else File(base, dirSpec).canonicalFile
        if (!canonical.path.startsWith(base.path)) return null
        rootDir = canonical
        return canonical
    }

    /** 创建存储目录。@return 是否成功（失败 → 1005） */
    fun ensureDir(): Boolean {
        val root = rootDir ?: return false
        return root.isDirectory || root.mkdirs()
    }

    /** 打开 .part 临时文件（仅创建 File 对象，写入由 FtpDataChannel 执行） */
    fun openPart(tempName: String): File {
        return File(rootDir, tempName)
    }

    /** 原子 rename：.part → 最终名。防御性校验目标名合法，否则返回 null（不落盘） */
    fun finalize(part: File, targetName: String): File? {
        if (!validateName(targetName)) return null
        val target = File(rootDir, targetName)
        return if (part.exists() && part.renameTo(target)) target else null
    }

    /** 删除半成品（幂等） */
    fun discard(part: File) {
        try {
            if (part.exists()) part.delete()
        } catch (_: Exception) {
        }
    }

    /** 目标名是否已存在（FtpMachine.exists 注入） */
    fun exists(name: String): Boolean {
        return File(rootDir, name).exists()
    }

    /** 相对名 → 绝对路径（fileReceived.meta.path 用，保证事件与磁盘一致） */
    fun absPath(name: String): String {
        return File(rootDir, name).absolutePath
    }

    /** 防御性白名单（与状态机 validateStorName 同步；状态机已校验，此处双保险） */
    private fun validateName(name: String): Boolean {
        if (name.isEmpty() || name.length > 255) return false
        if (name.startsWith("/") || name.endsWith("/") || name.startsWith("\\") || name.endsWith("\\")) return false
        if (name.contains("/") || name.contains("\\") || name.contains("..")) return false
        for (c in name) {
            if (c.code < 32) return false
        }
        return true
    }
}
