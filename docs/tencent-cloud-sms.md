# 腾讯云 SMS OTP

SupaCloud 的项目级 Auth 配置支持通过平台托管的腾讯云 SMS 适配器发送手机号 OTP。

在 Web Console 的 `Authentication → 短信 OTP` 页面配置：

- 腾讯云地域，例如 `ap-guangzhou`
- `SmsSdkAppId`
- 已审核的短信签名
- 只包含一个验证码参数的模板 ID
- 腾讯云 `SecretId` 和 `SecretKey`

凭据保存于项目级加密控制密钥，不会写入公开的 Auth 配置。保存腾讯云配置后，平台会为该租户启用 GoTrue `send_sms_hook`，并将 Hook 指向 Management API 的平台适配器。停用 Provider 会关闭租户的手机号 OTP，但保留已保存的凭据，方便重新启用。

平台适配器使用腾讯云 SMS `SendSms` API 的 TC3-HMAC-SHA256 签名。GoTrue Hook 请求必须通过 Standard Webhooks v1 签名校验；验证码从结构化 `otp`/`code` 字段读取，兼容只提供渲染短信内容的 GoTrue 版本。手机号必须是 E.164 格式，例如 `+8613800138000`。

控制台的测试发送使用验证码 `123456`，只用于验证腾讯云账号、签名和模板配置。生产 OTP 的发送频率和重放保护仍由 GoTrue 与平台 Hook 校验负责。
