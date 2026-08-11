/**
 * 地理工具：坐标网格键（用于地图聚合）
 * 基础粒度 0.01°（约 1.1km），更粗粒度由聚合时的 gridSize 决定
 */

/** 计算坐标的 0.01° 网格键，如 "3606_12038" */
export function gridKeyOf(lng, lat, cell = 0.01) {
  return `${Math.floor(lat / cell)}_${Math.floor(lng / cell)}`;
}

/** 按指定网格大小生成聚合键表达式（用于 Mongo 聚合 $project/$group） */
export function gridKeyExpr(lngField = '$lng', latField = '$lat', grid = 0.05) {
  const g = grid * 100; // 转为 0.01° 网格单位
  return {
    $concat: [
      { $toString: { $floor: { $divide: [{ $multiply: [lngField, 100] }, g] } } },
      '_',
      { $toString: { $floor: { $divide: [{ $multiply: [latField, 100] }, g] } } },
    ],
  };
}

/** 地球半径（公里），用于 Haversine 距离计算 */
const EARTH_RADIUS_KM = 6371;

/**
 * 两点间球面距离（Haversine 公式，单位：公里）
 * @param {{lng:number,lat:number}} a
 * @param {{lng:number,lat:number}} b
 */
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

/** 转义正则特殊字符（用户输入用于 $regex 前必须转义） */
export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 1° 纬度对应的米数（估算，用于米 → 度换算） */
const METERS_PER_DEG = 111320;

/**
 * 搜索半径 → 经纬度偏移量（用于 bbox 索引预过滤，灵感/探索模式共用）
 * 约定：radius ≤ 180 视为度数（°），> 180 视为米（api.md 4.1 默认 5000 米）
 * 经度方向按纬度修正（cos(lat) 收缩），纬度方向恒定
 * @param {number} radius 米或度
 * @param {number} lat 中心纬度（用于经度修正）
 * @returns {{dLat:number, dLng:number}|null} 非法/非正数返回 null（表示不限范围）
 */
export function radiusDelta(radius, lat) {
  const r = Number(radius);
  if (!Number.isFinite(r) || r <= 0) return null;
  const degrees = r <= 180 ? r : r / METERS_PER_DEG;
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return { dLat: degrees, dLng: degrees / cos };
}

/** 半径对应的最大球面距离（公里），与 radiusDelta 同一约定（度数 × 111.32km/°） */
export function radiusMaxKm(radius) {
  const r = Number(radius);
  if (!Number.isFinite(r) || r <= 0) return null;
  return r <= 180 ? r * 111.32 : r / 1000;
}
