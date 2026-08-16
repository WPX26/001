# -*- coding: utf-8 -*-
"""
script/diag-usb-5d2.py — 5D2 真机 USB 直连诊断（Windows + libusb，对照实验）

目标：把「协议层正确性」与「手机 web-view 桥问题」分开验证：
  ① 枚举描述符（配置/接口/端点）
  ② OpenSession(0x1002, transid=0, sessionId=1) → 期望 0x2001 OK
  ③ GetDeviceInfo(0x1001) → 解析 data 块（厂商/型号/序列号）
  ④ 不同读 buffer（512/4096/16384/65536）对比——验证 Windows libusb 上大 buffer
     是否正常（若正常 → 手机端 n=null 是桥的转换问题，协议层没问题）
  ⑤ SetRemoteMode(0x9114,1) / SetEventMode(0x9115,1) / GetEvent(0x9116) 排空
  ⑥ 快门 0x910F 无参数单发（会真拍一张！）→ 响应 Param1 结果码
  ⑦ KeepDeviceOn(0x911D)

用法：python script/diag-usb-5d2.py [--no-shutter]
"""
import sys, os, time, struct
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import usb.core, usb.util, usb.backend.libusb1
import libusb_package

VID, PID = 0x04A9, 0x3199
EP_IN, EP_OUT = 0x81, 0x02
NO_SHUTTER = '--no-shutter' in sys.argv

# ---------- PTP 包工具（与 camera-ptp.js 同一套语义） ----------
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def cmd_pkt(code, tid, params=()):
    return u32(12 + 4 * len(params)) + u16(1) + u16(code) + u32(tid) + b''.join(u32(p) for p in params)
def parse_hdr(d):
    return struct.unpack('<IHHI', d[:12])  # length, type, code, tid

def read_exact(dev, size, timeout=8000):
    """libusb read 可能返回 < size，循环凑满（模拟 PacketStream 语义）"""
    buf = b''
    while len(buf) < size:
        try:
            chunk = bytes(dev.read(EP_IN, min(size - len(buf), 16384), timeout=timeout))
        except usb.core.USBError as e:
            if e.errno == 110:  # timeout
                break
            raise
        if not chunk:
            break
        buf += chunk
    return buf

def read_packet(dev, bufsize=512, timeout=8000):
    first = read_exact(dev, 12, timeout)
    if len(first) < 12:
        return ('short', first)
    length, typ, code, tid = parse_hdr(first)
    body = first[12:]
    while len(body) < length - 12:
        need = length - 12 - len(body)
        chunk = read_exact(dev, min(need, bufsize), timeout)
        if not chunk:
            break
        body += chunk
    return (typ, code, tid, body[:length - 12])

def params_of(body):
    if len(body) < 4:
        return []
    return list(struct.unpack('<%dI' % (len(body) // 4), body[: (len(body) // 4) * 4]))

def rd_str(buf, off):
    """PTP 字符串：u8 长度（含 null）+ 字节"""
    n = buf[off]
    s = buf[off + 1 : off + 1 + n]
    return s.rstrip(b'\x00').decode('latin1', 'replace'), off + 1 + n

def rd_u16(buf, off): return struct.unpack_from('<H', buf, off)[0], off + 2
def rd_u32(buf, off): return struct.unpack_from('<I', buf, off)[0], off + 4

# ---------- 主流程 ----------
print('=== 5D2 USB 真机诊断 ===')
backend = usb.backend.libusb1.get_backend(find_library=libusb_package.find_library)
dev = usb.core.find(idVendor=VID, idProduct=PID, backend=backend)
if dev is None:
    print('❌ 未找到 5D2，请确认 USB 已连接'); sys.exit(1)
print('✅ 找到 5D2: bus=%d addr=%d' % (dev.bus, dev.address))

# ① 描述符
cfg = dev.get_active_configuration()
print('\n① 配置描述符:')
print('   bConfigurationValue=%d, 接口数=%d' % (cfg.bConfigurationValue, cfg.bNumInterfaces))
for itf in cfg:
    print('   iface%d class=0x%02x alt=%d 端点:' % (itf.bInterfaceNumber, itf.bInterfaceClass, itf.bAlternateSetting))
    for ep in itf:
        print('     ep 0x%02x type=%d maxPkt=%d' % (ep.bEndpointAddress, ep.bmAttributes & 3, ep.wMaxPacketSize))

# 激活配置 + claim
try:
    dev.set_configuration(1)
    print('\n✅ set_configuration(1) 成功')
except usb.core.USBError as e:
    print('ℹ️  set_configuration: %s（可能已激活，继续）' % e)
try:
    usb.util.claim_interface(dev, 0)
    print('✅ claim_interface(0) 成功')
except usb.core.USBError as e:
    print('❌ claim_interface 失败: %s' % e)
    print('   （被 WPD/其他程序占用？尝试关闭相机导入，或 Zadig 换 WinUSB 驱动）')
    sys.exit(1)

tid_counter = [0]
def next_tid():
    tid_counter[0] += 1
    return tid_counter[0]

def transaction(code, params=(), bufsize=512, label='', data_payload=None):
    """发命令（可选 data 负载）→ 读响应 → 返回 (has_data, rc, tid, data_or_None)"""
    tid = 0 if code == 0x1002 else next_tid()
    dev.write(EP_OUT, cmd_pkt(code, tid, params), timeout=4000)
    if data_payload is not None:
        # data 包：12 字节头 + payload（与命令包同 tid）
        dev.write(EP_OUT, u32(12 + len(data_payload)) + u16(2) + u16(code) + u32(tid) + data_payload,
                  timeout=4000)
    pkt = read_packet(dev, bufsize)
    typ, rc, ptid, body = pkt
    if typ == 2:  # data 阶段 → 再读响应
        data = body
        pkt2 = read_packet(dev, bufsize)
        typ2, rc, ptid2, body2 = pkt2
        print('   %s: code=0x%04x data=%dB → 响应 0x%04x params=%s' % (
            label, code, len(data), rc, params_of(body2)))
        return True, rc, ptid2, data
    print('   %s: code=0x%04x → 响应 0x%04x params=%s' % (label, code, rc, params_of(body)))
    return False, rc, ptid, body

print('\n② OpenSession（0x1002, transid=0, sessionId=1）')
typ, rc, tid, body = transaction(0x1002, [1], label='OpenSession')
print('   ✅ OK' if rc == 0x2001 else '   ❌ 期望 0x2001，实际 0x%04x' % rc)

print('\n③ GetDeviceInfo（0x1001）')
has_data, rc, tid, data = transaction(0x1001, label='GetDeviceInfo')
if has_data and data:
    off = 0
    stdver, off = rd_u16(data, off)
    vender_id, off = rd_u32(data, off)
    vendver, off = rd_u16(data, off)
    desc, off = rd_str(data, off)
    fmode, off = rd_u16(data, off)
    nops, off = rd_u32(data, off); off += nops * 2
    nevts, off = rd_u32(data, off); off += nevts * 2
    nprops, off = rd_u32(data, off); off += nprops * 2
    ncap, off = rd_u32(data, off); off += ncap * 2
    nimg, off = rd_u32(data, off); off += nimg * 2
    manu, off = rd_str(data, off)
    model, off = rd_str(data, off)
    ver, off = rd_str(data, off)
    serial, off = rd_str(data, off)
    print('   厂商: %s' % manu)
    print('   型号: %s' % model)
    print('   固件: %s' % ver)
    print('   序列号: %s' % serial)
else:
    print('   ❌ GetDeviceInfo 未拿到 data 块')

print('\n④ 读 buffer 大小对比实验（验证手机桥 n=null 是否桥问题）')
for bs in (512, 4096, 16384, 65536):
    has_data, rc, tid, data = transaction(0x1001, bufsize=bs, label='GetDeviceInfo@%d' % bs)
    ok = '✅ 正常（data=%dB, 响应 0x%04x）' % (len(data), rc) if has_data else '❌ 0x%04x' % rc
    print('   buffer=%6dB → %s' % (bs, ok))

print('\n⑤ 远程/事件模式 + 排空')
transaction(0x9114, [1], label='SetRemoteMode')
transaction(0x9115, [1], label='SetEventMode')
# CaptureDestination = 1（CF 卡；gphoto2 默认 SDRAM=4）：0x1016 SetDevicePropValue + 属性 0xD11C
transaction(0x1016, [0xD11C], data_payload=struct.pack('<H', 1), label='SetCaptureDest(CF卡)')
for i in range(3):
    has_data, rc, tid, body = transaction(0x9116, label='GetEvent#%d' % (i + 1))
    if not has_data or len(body) == 0:
        print('   ✅ 事件队列已空')
        break
    print('   事件数据 %d 字节: %s' % (len(body), body[:48].hex()))

def shot_result(rc, p, label):
    if rc == 0x2001:
        result = p[0] if p else -1
        names = {0: '成功', 1: '对焦失败', 3: '反光板抬起失败', 7: '卡满/无内存', 8: '卡只读'}
        print('   ✅ %s 快门被接受，结果码=%d（%s）' % (label, result, names.get(result, '未知')))
        return result
    print('   ❌ %s 响应 0x%04x params=%s' % (label, rc, p))
    return -1

print('\n⑥ 快门：路径 A（0x910F 无参单发）连拍 2 次')
if NO_SHUTTER:
    print('   （跳过，--no-shutter）')
else:
    for shot in (1, 2):
        print('   ⚠️  第 %d 次真实拍摄…' % shot)
        has_data, rc, tid, body = transaction(0x910F, label='RemoteRelease#%d' % shot)
        shot_result(rc, params_of(body), '0x910F#%d' % shot)
        time.sleep(1)

    print('\n  路径 B（0x9128/0x9129 RemoteReleaseOn，gphoto2 5Dm2 验证过的现代主路径）')
    print('   ⚠️  半按对焦 → 全按释放 → 全释放')
    has_data, rc, tid, body = transaction(0x9128, [1, 0], label='PressHalf(对焦)')
    time.sleep(1.5)  # 等对焦（gphoto2：最长可阻塞 8s）
    has_data, rc, tid, body = transaction(0x9128, [2, 0], label='PressFull(快门)')
    time.sleep(0.5)
    has_data, rc, tid, body = transaction(0x9129, [3], label='ReleaseAll')
    shot_result(rc, params_of(body), '0x9128路径')

print('\n⑦ 保活 0x911D')
transaction(0x911D, label='KeepDeviceOn')

try:
    usb.util.release_interface(dev, 0)
except Exception:
    pass
print('\n=== 诊断完成 ===')
