package uni_modules.ftp_receiver.utssdk.app_android

/**
 * FtpProtocolBridge.kt —— 原生协议循环 ↔ UTS 状态机的桥（设计文档 5.5，M7/M8 落地）
 *
 * 背景：状态机纯函数位于 interface/ftp-protocol.uts，由 FtpServer.kt 的会话循环调用。
 * UTS 编译产物类名由编译器生成、不可控，原生层直接引用 UTS 类型不可靠；
 * 故用「静态 Lambda 槽」反向注册（UTS → Kotlin 赋值是官方支持的调用方向）：
 *
 *  - UTS 层在 startServer 时注册 resetImpl / commandImpl / eventImpl 三个实现
 *    （内部持有 FtpMachine 实例，凭据/IP/对端 IP 在 reset 时注入）；
 *  - FtpServer.kt 每收到一行控制指令 / 一个内部事件，调用对应槽位，
 *    结果以 JSON 字符串返回（{responses, effects, fatal}），由原生层执行。
 *
 * resultJson 格式（effects 元素按 kind 携带不同字段）：
 *   { "responses": ["331 ..."], "effects": [
 *       { "kind": "openDataListen" },
 *       { "kind": "connectData", "host": "...", "port": 51201 },
 *       { "kind": "receiveFile", "temp": "...", "target": "...", "expected": 0 },
 *       { "kind": "discardTemp", "temp": "..." },
 *       { "kind": "closeData" },
 *       { "kind": "closeControl" },
 *       { "kind": "emitFileReceived", "meta": { "path": "...", "name": "...", "size": 123 } },
 *       { "kind": "emitTransferring", "name": "...", "size": 0 },
 *       { "kind": "emitError", "code": 1008, "message": "..." }
 *   ], "fatal": false }
 */
object FtpProtocolBridge {

    /**
     * 会话建立时重置状态机（新连接新机器）。
     * @param configJson {"user": "...", "pass": "...", "ip": "...", "peerIp": "..."}
     */
    var resetImpl: ((String) -> Unit)? = null

    /** 控制行 → resultJson。@param line 原始控制行（已去除 CRLF） */
    var commandImpl: ((String) -> String)? = null

    /** 内部事件 → resultJson。@param kind 事件名（dataListening/dataAccepted/...），@param payloadJson 事件载荷 */
    var eventImpl: ((String, String) -> String)? = null
}
