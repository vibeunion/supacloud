# Angie 网关 (Nginx 分叉版)

本目录包含 Supacloud 的网关层配置。我们选择 **Angie** 替代了原有的 OpenResty，旨在利用其更现代、更原生的特性。

## 核心特性
- **原生 ACME 支持**: 采用内置的 `http_acme` 模块，无需 Lua 脚本即可实现 SSL 证书自动申请与续期。
- **架构极简**: 彻底移除了 OpenResty 时代的 PostgreSQL 证书存储适配器和 OPM 依赖。
- **Nginx 兼容**: 100% 兼容所有现有 Nginx 配置指令。

## 快速部署
在 OpenCloudOS 9 / RHEL 9 环境下执行：

```bash
sudo bash setup.sh --studio-domain <您的域名> --api-domain <API域名>
```

## 证书管理
Angie 会自动与 Let's Encrypt 交互。证书申请成功后，将自动应用于 HTTPS 访问，并在到期前自动续期。
