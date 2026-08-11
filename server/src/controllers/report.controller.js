/**
 * 举报控制器（api.md 14.5，P1 接口）
 * - POST /report  举报照片/评论/用户（目标存在性校验、不能举报自己、重复举报 1005）
 *
 * 管理端审核（pending → handled）属 P2 范围，本批次仅落库 pending + 部分唯一索引去重
 * （P2 可沿用 reportSchema 的 {targetType, targetId} 索引做审核列表，处理完成置 handled）
 */
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User, Photo, Comment, Report } from '../models/index.js';

/** 14.5 举报内容（目标真实存在校验；同人同目标待处理举报 → 409/1005） */
export const createReport = asyncHandler(async (req, res) => {
  const { targetType, targetId, reason } = req.body;
  const meId = req.user._id;

  const reasonTrimmed = (reason || '').trim();
  if (!reasonTrimmed) throw new AppError(ERR.VALIDATE, '举报原因不能为空', 400);
  if (reasonTrimmed.length > 200) throw new AppError(ERR.VALIDATE, '举报原因不能超过 200 字', 400);

  // 目标存在性校验（照片/评论需未删除；软删目标视为不存在）
  if (targetType === 'user') {
    if (String(targetId) === String(meId)) {
      throw new AppError(ERR.VALIDATE, '不能举报自己', 400);
    }
    const target = await User.findById(targetId).select('_id').lean();
    if (!target) throw new AppError(ERR.NOT_FOUND, '用户不存在', 404);
  } else if (targetType === 'photo') {
    const target = await Photo.findOne({ _id: targetId, deletedAt: null }).select('_id').lean();
    if (!target) throw new AppError(ERR.NOT_FOUND, '照片不存在或已删除', 404);
  } else if (targetType === 'comment') {
    const target = await Comment.findOne({ _id: targetId, deletedAt: null }).select('_id').lean();
    if (!target) throw new AppError(ERR.NOT_FOUND, '评论不存在或已删除', 404);
  }

  // 重复举报：同一举报人对同一目标的待处理举报已存在 → 1005
  const dup = await Report.findOne({ reporterId: meId, targetType, targetId, status: 'pending' })
    .select('_id')
    .lean();
  if (dup) throw new AppError(ERR.DUPLICATE, '该内容已举报，请勿重复提交', 409);

  // 部分唯一索引 {reporterId, targetType, targetId}（status=pending）兜底并发重复
  const report = await Report.create({ reporterId: meId, targetType, targetId, reason: reasonTrimmed });

  ok(
    res,
    { id: String(report._id), status: report.status, createdAt: report.createdAt },
    '举报成功，我们会尽快处理'
  );
});
