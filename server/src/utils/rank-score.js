/**
 * 排序体系公式库（王总 2026-09-02 定稿：三层排序）
 * - 第一梯队 置顶层：月卡层 > 周卡层；档内 PK = 热度 × (1 + min(0.5 × 覆盖率, 0.5))，同分后买靠前
 * - 第二梯队 免费层：同公式 × 新鲜系数 × 新人系数；每 6 席保底穿插 1 席 24h 内最新发表（不论赞数）
 * - 覆盖率 = 该作者占据的分散点数 / 聚合点内总点数（广度加成封顶 50%：铺满全簇最多 +50%，爆款不死）
 */
export const BREADTH_WEIGHT = 0.5;
export const BREADTH_CAP = 0.5;
export const FRESH_LADDER = [
  { ms: 24 * 86400e3, factor: 4 }, // 24 小时内 ×4
  { ms: 3 * 86400e3, factor: 3 }, // 3 天内 ×3
  { ms: 7 * 86400e3, factor: 2 }, // 7 天内 ×2
  { ms: 30 * 86400e3, factor: 1 }, // 30 天内 ×1
];
export const FRESH_OLD_FACTOR = 0.6; // 更久 ×0.6（旧作回落让位）
export const NEWCOMER_DAYS = 30; // 注册 ≤30 天视为新人
export const NEWCOMER_FACTOR = 1.3;
export const FRESH_SLOT_EVERY = 6; // 每 6 席一个保底穿插位
export const FRESH_SLOT_WINDOW_MS = 24 * 86400e3; // 保底位只收 24h 内最新

/** 广度加成：1 + min(权重 × 覆盖率, 封顶) */
export function breadthFactor(covered, total) {
  if (!total || total <= 0 || !(covered > 0)) return 1;
  return 1 + Math.min(BREADTH_WEIGHT * (covered / total), BREADTH_CAP);
}

/** 新鲜系数：发表时间分档衰减（发表越新乘数越大，老作品回落让位） */
export function freshnessFactor(dateLike, now = Date.now()) {
  const t = new Date(dateLike).getTime();
  if (!Number.isFinite(t)) return 1;
  const age = Math.max(0, now - t);
  for (const step of FRESH_LADDER) if (age < step.ms) return step.factor;
  return FRESH_OLD_FACTOR;
}

/** 新人系数：注册 ≤30 天 ×1.3（仅免费层使用） */
export function newcomerFactor(createdAt, now = Date.now()) {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 1;
  return now - t <= NEWCOMER_DAYS * 86400e3 ? NEWCOMER_FACTOR : 1;
}

/** 置顶档内公式分：热度 × 广度加成（覆盖率为簇内口径） */
export function boostScore({ likes, covered, total }) {
  return (likes || 0) * breadthFactor(covered, total);
}

/** 免费层公式分：热度 × 广度 × 新鲜 × 新人 */
export function freeScore({ likes, covered, total, publishedAt, authorCreatedAt, now = Date.now() }) {
  return (
    (likes || 0) *
    breadthFactor(covered, total) *
    freshnessFactor(publishedAt, now) *
    newcomerFactor(authorCreatedAt, now)
  );
}

/**
 * 保底穿插：主列表每 every 席后插入 1 席「24h 内最新发表」（纯按时间，不论赞数）。
 * - freshList 须已按发表时间倒序；元素须带 key 与 publishedAt
 * - 已在主列表的项不重复插入；窗口外的项不保底
 */
export function interleaveFreshSlots(list, freshList, now = Date.now(), every = FRESH_SLOT_EVERY) {
  const emitted = new Set();
  const fresh = (freshList || []).filter(
    (f) =>
      !emitted.has(f.key) &&
      Number.isFinite(new Date(f.publishedAt).getTime()) &&
      now - new Date(f.publishedAt).getTime() <= FRESH_SLOT_WINDOW_MS
  );
  const out = [];
  let fi = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (emitted.has(item.key)) continue; // 已借保底位提前露脸，主队列不再二刷
    emitted.add(item.key);
    out.push(item);
    if ((i + 1) % every === 0 && fi < fresh.length) {
      const f = fresh[fi++];
      emitted.add(f.key);
      out.push(f);
    }
  }
  while (fi < fresh.length) {
    const f = fresh[fi++];
    if (!emitted.has(f.key)) {
      emitted.add(f.key);
      out.push(f);
    }
  }
  return out;
}
