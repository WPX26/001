# -*- coding: utf-8 -*-
"""
script/diag-shoot-5d2.py — 5D2 完整拍摄链路验证（0x9128 快门 → 0xC181 事件 → 取图）

验证：路径 B 快门后相机是否真出片，0xC181 事件解析、SDRAM(StorageID=0) 分块取图、
JPEG 完整性——与 camera-ptp.js 实现的语义逐项对照。
"""
import sys, time, struct
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import usb.core, usb.util, usb.backend.libusb1
import libusb_package

VID, PID = 0x04A9, 0x3199
EP_IN, EP_OUT = 0x81, 0x02

def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def cmd_pkt(code, tid, params=()):
    return u32(12 + 4 * len(params)) + u16(1) + u16(code) + u32(tid) + b''.join(u32(p) for p in params)
def parse_hdr(d): return struct.unpack('<IHHI', d[:12])

def read_exact(dev, size, timeout=20000):
    buf = b''
    while len(buf) < size:
        try:
            chunk = bytes(dev.read(EP_IN, min(size - len(buf), 4096), timeout=timeout))
        except usb.core.USBError as e:
            if e.errno == 110: break
            raise
        if not chunk: break
        buf += chunk
    return buf

def read_packet(dev, bufsize=512, timeout=20000):
    first = read_exact(dev, 12, timeout)
    if len(first) < 12: return ('short', first)
    length, typ, code, tid = parse_hdr(first)
    body = first[12:]
    while len(body) < length - 12:
        need = length - 12 - len(body)
        chunk = read_exact(dev, min(need, bufsize), timeout)
        if not chunk: break
        body += chunk
    return (typ, code, tid, body[:length - 12])

def params_of(body):
    if len(body) < 4: return []
    return list(struct.unpack('<%dI' % (len(body) // 4), body[: (len(body) // 4) * 4]))

backend = usb.backend.libusb1.get_backend(find_library=libusb_package.find_library)
dev = usb.core.find(idVendor=VID, idProduct=PID, backend=backend)
if dev is None: print('未找到 5D2'); sys.exit(1)
dev.set_configuration(1)
usb.util.claim_interface(dev, 0)

tid_counter = [0]
def next_tid():
    tid_counter[0] += 1
    return tid_counter[0]

def transaction(code, params=(), bufsize=512, label='', data_payload=None, timeout=20000):
    tid = 0 if code == 0x1002 else next_tid()
    dev.write(EP_OUT, cmd_pkt(code, tid, params), timeout=4000)
    if data_payload is not None:
        dev.write(EP_OUT, u32(12 + len(data_payload)) + u16(2) + u16(code) + u32(tid) + data_payload, timeout=4000)
    pkt = read_packet(dev, bufsize, timeout)
    typ, rc, ptid, body = pkt
    if typ == 2:
        data = body
        pkt2 = read_packet(dev, bufsize, timeout)
        typ2, rc, ptid2, body2 = pkt2
        print('   %s: data=%dB → 响应 0x%04x params=%s' % (label, len(data), rc, params_of(body2)))
        return True, rc, data
    print('   %s: → 响应 0x%04x params=%s' % (label, rc, params_of(body)))
    return False, rc, body

print('=== 5D2 完整拍摄链路验证 ===')
print('① 打开会话 + 远程模式')
transaction(0x1002, [1], label='OpenSession')
transaction(0x1001, label='GetDeviceInfo')
transaction(0x9114, [1], label='SetRemoteMode')
transaction(0x9115, [1], label='SetEventMode')
for i in range(3):
    has_data, rc, body = transaction(0x9116, label='DrainEvent#%d' % i)
    if not has_data or len(body) <= 8: break

print('\n② 快门（0x9128 路径：半按→全按→全释放）')
transaction(0x9128, [1, 0], label='PressHalf')
time.sleep(1.5)
r = transaction(0x9128, [2, 0], label='PressFull')
time.sleep(0.3)
transaction(0x9129, [3], label='ReleaseAll')

print('\n③ 轮询 GetEvent 找 0xC181（最多 12 次，500ms 间隔）')
found = None
for i in range(12):
    has_data, rc, body = transaction(0x9116, label='Poll#%d' % i)
    if has_data:
        pos = 0
        while pos + 8 <= len(body):
            size, code = struct.unpack_from('<II', body, pos)
            if size == 8 and code == 0: break
            if size < 8 or pos + size > len(body): break
            if code == 0xC181:
                rec = body[pos + 8:pos + size]
                handle, storage = struct.unpack_from('<II', rec, 0)
                ofc = struct.unpack_from('<H', rec, 8)[0]
                print('   ✅ 0xC181: handle=%d storageId=0x%08x OFC=0x%04x' % (handle, storage, ofc))
                found = (handle, storage)
                break
            pos += size
    if found: break
    time.sleep(0.5)
if not found:
    print('   ❌ 未等到 0xC181 事件'); usb.util.release_interface(dev, 0); sys.exit(1)

handle, storage = found
print('\n④ 取图（%s 路径）' % ('SDRAM 分块 0x9107' if storage == 0 else '卡上 0x9104'))
jpeg = b''
if storage == 0:
    CHUNK = 0x100000
    offset = 0
    while True:
        has_data, rc, body = transaction(0x9107, [handle, offset, CHUNK], label='GetPartial@%d' % offset)
        if not has_data: break
        jpeg += body
        print('   已读 %d 字节' % len(jpeg))
        if len(body) < CHUNK: break
        offset += CHUNK
    transaction(0x9117, [handle], label='TransferComplete')
else:
    has_data, rc, body = transaction(0x9104, [handle], label='GetObject')
    jpeg = body

print('\n⑤ JPEG 校验')
print('   总字节: %d' % len(jpeg))
print('   文件头: %s（期望 FFD8）' % jpeg[:2].hex())
print('   文件尾: %s（期望 FFD9）' % jpeg[-2:].hex() if len(jpeg) >= 2 else '  （过短）')
with open('C:/Users/lenovo/AppData/Local/Temp/5d2_shot.jpg', 'wb') as f:
    f.write(jpeg)
print('   已保存: Temp/5d2_shot.jpg')

usb.util.release_interface(dev, 0)
print('\n=== 拍摄链路验证完成 ===')
