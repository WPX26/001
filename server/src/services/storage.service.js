/**
 * 存储适配层（OSS 直传）
 *
 * 两种模式（由 .env STORAGE_MODE 切换）：
 * - local：本地磁盘（server/uploads/），开发用；/upload/file 直传，/upload/token 返回空凭证
 * - oss：阿里云 OSS 直传，/upload/token 返回 STS 临时凭证 + 预签名上传 URL，
 *         /upload/callback 做回调签名验签后创建照片记录
 *
 * 密钥未配置时返回明确错误码 1007（对齐短信适配层风格），密钥到位即生效。
 */
import crypto from 'node:crypto';
import env from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';
import { Photo } from '../models/index.js';

/** OSS 配置是否齐备 */
export function isOSSConfigured() {
  const { region, bucket, roleArn, accessKeyId, accessKeySecret } = env.OSS;
  return Boolean(region && bucket && roleArn && accessKeyId && accessKeySecret);
}

function ossConfigMissingError() {
  console.warn('[OSS] 请在 .env 配置 OSS_REGION / OSS_BUCKET / OSS_ROLE_ARN / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（STORAGE_MODE=oss）');
  return new AppError(ERR.SERVICE_CONFIG, '存储服务未配置，请联系管理员配置 OSS 密钥', 503);
}

/** 场景 → 对象存储目录前缀 */
function scenePrefix(scene) {
  const now = new Date();
  const ym = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = { coord: 'photos', avatar: 'avatars', chat: 'chat' }[scene] || 'photos';
  return `${dir}/${ym}/`;
}

/** 生成一个随机对象键（文件名） */
function randomObjectKey(scene) {
  return `${scenePrefix(scene)}${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
}

/** OSS 文件的对外访问地址 */
export function objectUrl(key) {
  return `https://${env.OSS.bucket}.${env.OSS.region}.aliyuncs.com/${key}`;
}

/**
 * 获取上传凭证（api.md 7.1）
 * @param {string} scene coord / avatar / chat
 * @param {number} fileCount 上传文件数量
 * @returns {Promise<{ ossToken: object|null, uploadUrls: string[], storageMode: string }>}
 */
export async function getUploadToken(scene, fileCount) {
  if (env.STORAGE_MODE === 'local') {
    // 本地模式：无 OSS 凭证，前端走 POST /upload/file 直传
    return { ossToken: null, uploadUrls: [], storageMode: 'local' };
  }
  if (!isOSSConfigured()) {
    throw ossConfigMissingError();
  }

  // 动态加载阿里云 STS SDK（@alicloud/sts20150401）
  const StsModule = await import('@alicloud/sts20150401');
  const OpenApiModule = await import('@alicloud/openapi-client');
  const Sts = StsModule.default || StsModule;
  const OpenApi = OpenApiModule.default || OpenApiModule;
  const AssumeRoleRequest = Sts.AssumeRoleRequest || StsModule.AssumeRoleRequest;

  const client = new Sts(
    new OpenApi.Config({
      accessKeyId: env.OSS.accessKeyId,
      accessKeySecret: env.OSS.accessKeySecret,
      endpoint: 'sts.aliyuncs.com',
    })
  );

  // 申请 STS 临时凭证（有效期 1 小时）
  const resp = await client.assumeRole(
    new AssumeRoleRequest({
      roleArn: env.OSS.roleArn,
      roleSessionName: env.OSS.roleSessionName,
      durationSeconds: 3600,
    })
  );
  const creds = resp?.body?.credentials;
  if (!creds?.accessKeyId) {
    throw new AppError(ERR.SERVER, 'STS 临时凭证获取失败', 500);
  }

  // 用 STS 凭证预签名 PUT 直传 URL（ali-oss 官方 SDK）
  const OSSModule = await import('ali-oss');
  const OSS = OSSModule.default || OSSModule;
  const clientOss = new OSS({
    region: env.OSS.region,
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    stsToken: creds.securityToken,
    bucket: env.OSS.bucket,
  });

  const uploadUrls = [];
  for (let i = 0; i < Math.min(Math.max(fileCount, 1), 20); i++) {
    const key = randomObjectKey(scene);
    uploadUrls.push(clientOss.signatureUrl(key, { method: 'PUT', expires: 3600 }));
  }

  return {
    ossToken: {
      accessKeyId: creds.accessKeyId,
      accessKeySecret: creds.accessKeySecret,
      securityToken: creds.securityToken,
      expiration: creds.expiration,
      region: env.OSS.region,
      bucket: env.OSS.bucket,
      prefix: scenePrefix(scene),
    },
    uploadUrls,
    storageMode: 'oss',
  };
}

/**
 * OSS 回调签名校验（api.md 7.3）
 * Authorization: "OSS " + base64(hmac-sha1(secret, 原始请求体))
 * P1-3 修复：先比较长度，不等直接返回 false（timingSafeEqual 长度不同会抛 TypeError → 500）
 */
export function verifyCallbackSignature(rawBody, authorization) {
  if (!authorization || !authorization.startsWith('OSS ')) return false;
  const sign = authorization.slice(4).trim();
  const hmac = crypto
    .createHmac('sha1', env.OSS.accessKeySecret)
    .update(rawBody || '', 'utf8')
    .digest('base64');
  const signBuf = Buffer.from(sign);
  const hmacBuf = Buffer.from(hmac);
  if (signBuf.length !== hmacBuf.length) return false;
  return crypto.timingSafeEqual(signBuf, hmacBuf);
}

/**
 * 上传完成回调：为文件创建照片记录（api.md 7.3）
 * @param {Array<{key:string, hash?:string, size?:number}>} files 前端上报的文件列表
 * @param {import('mongoose').Types.ObjectId} userId 上传者
 * @returns {Promise<string[]>} photoIds（与 files 顺序一致）
 */
export async function createPhotosFromCallback(files, userId) {
  const photoIds = [];
  for (const file of files || []) {
    const key = file.key || '';
    const hash = file.hash || '';
    if (!key) throw new AppError(ERR.VALIDATE, '回调文件缺少 key', 400);

    // 幂等：同一文件（hash）重复回调不产生重复照片。
    // P1-4 修复：幂等键复合 userId + key/hash——旧实现全局唯一，两用户上传相同 hash 会冒领对方照片
    const clientPhotoId = `${String(userId)}:${hash || key}`;
    let photo = await Photo.findOne({ clientPhotoId });
    if (!photo) {
      const url = env.STORAGE_MODE === 'oss' ? objectUrl(key) : `${env.LOCAL_BASE_URL}/uploads/${key}`;
      photo = await Photo.create({
        clientPhotoId,
        authorId: userId,
        imageUrl: url,
        thumbnailUrl: url, // 缩略图服务（图片处理）P1 接入
        uploadTime: new Date(),
        size: file.size || 0,
        hash,
        gpsSource: 'none',
      });
    }
    photoIds.push(String(photo._id));
  }
  return photoIds;
}
