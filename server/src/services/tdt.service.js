/**
 * 天地图地理编码服务（代理外部地名搜索，KEY 从 .env 的 TDT_KEY 读取）
 *
 * 接口格式（2026-08-09 实测通过）：
 * - 正向编码: GET /geocoder?ds=<URL编码JSON:{"keyWord":"青岛五四广场"}>&tk=KEY
 *   → {"status":"0","location":{"lon":"120.37136","lat":"36.06074","keyWord":"...","level":"..."}}
 * - 逆编码:   GET /geocoder?postStr=<URL编码JSON:{"lon":120.3826,"lat":36.0671,"ver":1}>&type=geocode&tk=KEY
 *   → {"status":"0","result":{"formatted_address":"...","addressComponent":{"poi":"..."},...}}
 *
 * 降级策略：任何失败（网络/超时/状态非 0/未配置 Key）都返回空结果或 null，
 * 由调用方以空列表兜底，绝不向客户端抛 500。
 */
import env from '../config/env.js';

const TDT_BASE = 'https://api.tianditu.gov.cn/geocoder';
// 必须用浏览器 UA：Key 权限类型为"浏览器端"，天地图按 UA 鉴权，非浏览器 UA 会返回 403 权限类型错误
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 8000;

/** 公共请求封装：status 非 0 或异常时返回 null */
async function fetchTdt(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.status === '0' ? data : null;
  } catch (err) {
    // 网络/超时/解析失败统一降级（不抛异常，避免接口 500）
    console.warn(`[TDT] 请求失败已降级: ${err.message}`);
    return null;
  }
}

/**
 * 正向地理编码：地址/关键词 → 地标列表
 * @param {string} keyword 搜索关键词
 * @returns {Promise<Array<{name:string,lng:number,lat:number,address:string}>>}
 */
export async function tdtGeocode(keyword) {
  if (!env.TDT_KEY || !keyword) return [];
  const ds = encodeURIComponent(JSON.stringify({ keyWord: keyword }));
  const data = await fetchTdt(`${TDT_BASE}?ds=${ds}&tk=${encodeURIComponent(env.TDT_KEY)}`);
  const loc = data?.location;
  if (!loc) return [];
  return [
    {
      name: loc.keyWord || keyword,
      lng: Number(loc.lon),
      lat: Number(loc.lat),
      address: loc.keyWord || '',
    },
  ];
}

/**
 * 逆地理编码：坐标 → 地点名称 + 完整地址
 * @param {number} lng 经度
 * @param {number} lat 纬度
 * @returns {Promise<{name:string,address:string,lng:number,lat:number}|null>}
 *   name 优先取 POI 名称，无 POI 时取精简后的 formatted_address
 */
export async function tdtReverse(lng, lat) {
  if (!env.TDT_KEY || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const postStr = encodeURIComponent(JSON.stringify({ lon: lng, lat, ver: 1 }));
  const url = `${TDT_BASE}?postStr=${postStr}&type=geocode&tk=${encodeURIComponent(env.TDT_KEY)}`;
  const data = await fetchTdt(url);
  const result = data?.result;
  if (!result) return null;

  const formatted = result.formatted_address || '';
  const poi = result.addressComponent?.poi || '';
  return {
    // 名称优先取 POI（如"新贵都一期东门(人行门)"），无 POI 时退回完整地址
    name: poi || formatted,
    address: formatted,
    lng: Number(result.location?.lon) || lng,
    lat: Number(result.location?.lat) || lat,
  };
}
