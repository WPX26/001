/**
 * 通用分页解析（对齐 api.md 附录 C）
 * 请求：page（从 1 开始），pageSize（默认 20，最大 100）
 */
export function pagination(req, defaults = { pageSize: 20 }) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSizeRaw = parseInt(req.query.pageSize, 10) || defaults.pageSize;
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** 分页响应体（对齐附录 C：{ list, total, page, pageSize, hasMore }） */
export function paginated(list, total, page, pageSize) {
  return { list, total, page, pageSize, hasMore: (page - 1) * pageSize + list.length < total };
}
