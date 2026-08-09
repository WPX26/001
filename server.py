"""
静态文件服务器 + 地理编码代理
用法: python server.py
访问: http://localhost:8080/memo-home.html

天地图地理编码（2026-08-09 实测通过的接口格式）：
  正向（地址→坐标）: /geocoder?ds=<URL编码JSON:{"keyWord":"青岛五四广场"}>&tk=KEY
  反向（坐标→地址）: /geocoder?postStr=<URL编码JSON:{"lon":120.38,"lat":36.06,"ver":1}>&type=geocode&tk=KEY
  统一返回: {"status":"0","results":[{"title","lng","lat","address"}]}

获取天地图 Key（含地理编码权限）：
  1. 注册 https://console.tianditu.gov.cn/
  2. 创建应用 → 选择"浏览器端" → 勾选"地名搜索"服务
  3. 将 Key 替换下方的 TDT_KEY
"""
import http.server
import urllib.request
import urllib.parse
import json
import os
import hashlib

PORT = 8080
# 2026-08-09 更新为新申请 Key（已实测开通"地名搜索"权限）
# 免费注册: https://console.tianditu.gov.cn/
TDT_KEY = 'ee36c38eb7777006970a6e5597f7bae9'
# 安全密钥（SK 签名仅备用；主路径使用 tk 直连，见下方 tdt_geocode）
TDT_SK = 'e9555c782a160e4bb130aec9b73488af'


def tdt_sign(params):
    """天地图 SK 签名（备用方案，旧版 /geocoding?address= 已失效，仅保留作签名参考）：
    参数排序拼接 + SK → MD5
    """
    raw = '&'.join(f'{k}={v}' for k, v in sorted(params.items()))
    raw += f'&sk={TDT_SK}'
    return hashlib.md5(raw.encode('utf-8')).hexdigest()


def _tdt_request(query, timeout=10):
    """公共请求封装：拼 tk 参数 + UA，返回解析后的 JSON（失败抛异常由调用方处理）"""
    url = f'https://api.tianditu.gov.cn/geocoder?{query}&tk={urllib.parse.quote(TDT_KEY)}'
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'Mozilla/5.0')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def tdt_geocode(keyword):
    """天地图正向地理编码（地址/关键词 → 坐标）
    实测格式: /geocoder?ds={"keyWord":"青岛五四广场"}&tk=KEY
    响应: {"status":"0","location":{"lon":"120.37136","lat":"36.06074","keyWord":"...","level":"..."}}
    """
    ds = json.dumps({'keyWord': keyword}, ensure_ascii=False)
    data = _tdt_request('ds=' + urllib.parse.quote(ds))
    loc = data.get('location') if data.get('status') == '0' else None
    if not loc:
        return []
    return [{
        'title': loc.get('keyWord') or loc.get('level') or keyword,
        'lng': float(loc['lon']),
        'lat': float(loc['lat']),
        'address': loc.get('keyWord') or keyword,
    }]


def tdt_reverse_geocode(lng, lat):
    """天地图逆地理编码（坐标 → 地址）
    实测格式: /geocoder?postStr={"lon":120.3826,"lat":36.0671,"ver":1}&type=geocode&tk=KEY
    响应: {"status":"0","result":{"formatted_address":"...","addressComponent":{"poi":"..."},...}}
    """
    post_str = json.dumps({'lon': float(lng), 'lat': float(lat), 'ver': 1})
    data = _tdt_request(
        'postStr=' + urllib.parse.quote(post_str) + '&type=geocode'
    )
    result = data.get('result') if data.get('status') == '0' else None
    if not result:
        return []
    formatted = result.get('formatted_address') or ''
    # 名称优先取 POI（addressComponent.poi），无 POI 时用精简后的 formatted_address
    poi = (result.get('addressComponent') or {}).get('poi') or ''
    title = poi or formatted or f'{lng},{lat}'
    return [{
        'title': title,
        'lng': float(result.get('location', {}).get('lon') or lng),
        'lat': float(result.get('location', {}).get('lat') or lat),
        'address': formatted,
    }]


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/geocode':
            params = urllib.parse.parse_qs(parsed.query)
            address = params.get('address', [''])[0]
            lng = params.get('lng', [''])[0]
            lat = params.get('lat', [''])[0]

            # 两种模式：?address= 正向；?lng=&lat= 反向
            if not address and (not lng or not lat):
                self._send_json({'error': 'missing address (正向) or lng+lat (反向)'}, 400)
                return

            results = []
            error = None
            try:
                if address:
                    results = tdt_geocode(address)
                    print(f'  [geocode] 正向 "{address}" → {len(results)} results')
                else:
                    results = tdt_reverse_geocode(lng, lat)
                    print(f'  [geocode] 反向 ({lng},{lat}) → {len(results)} results')
            except Exception as e:
                error = str(e)
                print(f'  [geocode] → FAIL: {error}')

            self._send_json({
                'status': '0' if results else '1',
                'results': results,
                'error': error,
                'fallback_url': (
                    'https://map.tianditu.gov.cn/#/search?key='
                    + urllib.parse.quote(address or f'{lng},{lat}')
                )
            })
            return

        # 静态文件
        return super().do_GET()

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        if '/api/geocode' in str(args):
            pass  # 已在 do_GET 中打印
        elif '200' not in str(args[1]):
            print(format % args)


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'  ✓ http://localhost:{PORT}/memo-home.html')
    print(f'  ✓ /api/geocode?address=地名 （正向）')
    print(f'  ✓ /api/geocode?lng=120.38&lat=36.06 （反向）')
    print(f'  ⚠ 请替换 TDT_KEY 为含地理编码权限的 Key')
    http.server.HTTPServer(('0.0.0.0', PORT), ProxyHandler).serve_forever()
