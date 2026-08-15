/**
 * 相机互联：局域网相机真实检测（SSDP M-SEARCH 扫描）
 *
 * 2026-08-15 去模拟化：相机互联不再"假装连接 Sony A7M4"，检测走真实扫描。
 * 实现：向 SSDP 多播地址 239.255.255.250:1900 发 M-SEARCH，收集 2.5s 内响应，
 * 按 ST/USN/Server 头中的厂商关键字（sony/canon/nikon/fujifilm/panasonic/olympus/ricoh/gopro）
 * 识别相机设备（WiFi 相机普遍实现 SSDP 被发现，如 Sony Camera Remote、Canon EOS WiFi）。
 *
 * 诚实边界（为什么这样设计）：
 * - 后端部署在云上（Sealos），能扫到的只是云网络内的设备——用户局域网内的相机
 *   需由**被控手机端原生能力**扫描（浏览器无 UDP/裸 TCP，App 原生插件可做，二期）；
 *   本服务在云端执行时返回空列表是**真实结果**（云端确实没有相机），同时返回
 *   capability=cloud 让前端明确"检测发生在云端、非手机端"
 * - 后续原生插件二期：手机端扫描结果上报本接口或由手机端直连相机（PTP/IP、Sony/Canon HTTP API）
 */
import dgram from 'node:dgram';

/** SSDP 多播地址与端口 */
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
/** 扫描收集窗口：2.5 秒 */
const SCAN_TIMEOUT_MS = 2500;
/** 相机厂商识别关键字（SSDP 响应头中出现的品牌标识） */
const CAMERA_VENDOR_KEYWORDS = ['sony', 'canon', 'nikon', 'fujifilm', 'fuji', 'panasonic', 'olympus', 'ricoh', 'gopro', 'eos', 'alpha', 'cybershot'];

/**
 * 发起一次局域网 SSDP 扫描
 * @returns {Promise<Array<{id:string, model:string, vendor:string, ip:string, port:number, status:string}>>}
 */
export function scanCameras() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map(); // ip -> 设备信息（按 IP 去重）

    // M-SEARCH 报文（UPnP 标准发现请求，相机厂商广泛支持）
    const searchMsg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 2\r\n' +
      'ST: ssdp:all\r\n' +
      '\r\n'
    );

    const finish = () => {
      clearTimeout(timer);
      try { socket.close(); } catch (e) {}
      resolve(Array.from(found.values()));
    };

    const timer = setTimeout(finish, SCAN_TIMEOUT_MS);

    socket.on('error', () => finish());

    socket.on('message', (msg, rinfo) => {
      try {
        const text = msg.toString('utf8');
        if (!/^HTTP\/1\.[01] 200/i.test(text.trimStart())) return; // 仅接受 SSDP 200 响应
        const header = {};
        text.split('\r\n').forEach((line) => {
          const idx = line.indexOf(':');
          if (idx > 0) header[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        });
        const usn = (header.usn || header.st || '').toLowerCase();
        const server = (header.server || '').toLowerCase();
        // 命中相机品牌关键字才收录（普通路由器/打印机不误报）
        const vendor = CAMERA_VENDOR_KEYWORDS.find((k) => usn.indexOf(k) > -1 || server.indexOf(k) > -1);
        if (!vendor) return;
        const ip = rinfo.address;
        if (found.has(ip)) return;
        const loc = header.location || '';
        const port = (loc.match(/:(\d+)/) || [])[1] ? Number(loc.match(/:(\d+)/)[1]) : 15740; // PTP/IP 默认端口
        found.set(ip, {
          id: 'cam_' + ip.replace(/\./g, '_'),
          model: header.server || usn.split(':')[0] || 'WiFi Camera',
          vendor,
          ip,
          port,
          status: 'available',
        });
      } catch (e) { /* 单条响应解析失败不影响整体 */ }
    });

    // 绑定后广播；无绑定错误则开始监听
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(searchMsg, 0, searchMsg.length, SSDP_PORT, SSDP_ADDR);
    });
  });
}
