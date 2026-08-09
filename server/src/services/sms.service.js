/**
 * 短信适配层（阿里云短信 dysmsapi20170525 官方 SDK）
 *
 * 设计要点：
 * - 接口契约固定：sendCode(phone, scene, code)
 * - SDK 依赖已安装，调用代码按官方 SDK 标准写法实现
 * - 密钥（AccessKey/签名/模板）未配置时：不发送、返回明确错误码 1007，
 *   并在日志提示去 .env 配置 —— 密钥到位即自动生效，无需改代码
 * - 采用动态 import，避免模块加载期就依赖 SDK（密钥缺失时也不影响启动）
 */
import env from '../config/env.js';
import { ERR } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

/** 短信配置是否齐备 */
export function isConfigured() {
  const { accessKeyId, accessKeySecret, signName, templateCode } = env.ALIYUN_SMS;
  return Boolean(accessKeyId && accessKeySecret && signName && templateCode);
}

function configMissingError() {
  console.warn('[短信] 请在 .env 配置 ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET / ALIYUN_SMS_SIGN_NAME / ALIYUN_SMS_TEMPLATE_CODE');
  return new AppError(ERR.SERVICE_CONFIG, '短信服务未配置，请联系管理员配置短信密钥', 503);
}

/**
 * 发送短信验证码
 * @param {string} phone 手机号（11 位）
 * @param {string} scene login / register
 * @param {string} code 6 位验证码
 * @returns {Promise<{ requestId: string, bizId: string }>} 发送成功后返回阿里云响应信息
 */
export async function sendCode(phone, scene, code) {
  if (!isConfigured()) {
    throw configMissingError();
  }

  // 动态加载官方 SDK（@alicloud/dysmsapi20170525 + @alicloud/openapi-client）
  const DysmsapiModule = await import('@alicloud/dysmsapi20170525');
  const OpenApiModule = await import('@alicloud/openapi-client');
  const Dysmsapi = DysmsapiModule.default || DysmsapiModule;
  const OpenApi = OpenApiModule.default || OpenApiModule;

  const { accessKeyId, accessKeySecret, signName, templateCode } = env.ALIYUN_SMS;

  const client = new Dysmsapi(
    new OpenApi.Config({
      accessKeyId,
      accessKeySecret,
      endpoint: 'dysmsapi.aliyuncs.com',
    })
  );

  const SendSmsRequest = Dysmsapi.SendSmsRequest || (DysmsapiModule.Dysmsapi && DysmsapiModule.Dysmsapi.SendSmsRequest) || DysmsapiModule.SendSmsRequest;
  const request = new SendSmsRequest({
    phoneNumbers: phone,
    signName,
    templateCode,
    templateParam: JSON.stringify({ code }),
  });

  const resp = await client.sendSms(request);
  const body = resp?.body || resp;

  if (body?.code && body.code !== 'OK') {
    // 阿里云返回业务错误（如签名未通过、模板不匹配）
    throw new AppError(ERR.SERVER, `短信发送失败：${body.code} ${body.message || ''}`, 500);
  }

  return {
    requestId: body?.requestId || '',
    bizId: body?.bizId || '',
  };
}
