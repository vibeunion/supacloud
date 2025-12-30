# Pigsty Supabase 一键部署

基于 [Pigsty](https://pigsty.cc/) 的 Supabase 自托管一键部署脚本。

## 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB (自动开启 Swap) | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | Rocky/AlmaLinux 8/9, Ubuntu 22/24, Debian 12 | Rocky Linux 9 |

## 快速开始

### 1. 下载部署文件

```bash
# 方式一：Git 克隆
git clone https://github.com/yourrepo/supacloud.git
cd supacloud/deploy

# 方式二：直接下载
curl -fsSL https://gh-proxy.net/https://raw.githubusercontent.com/yourrepo/supacloud/main/deploy/install.sh -o install.sh
curl -fsSL https://gh-proxy.net/https://raw.githubusercontent.com/yourrepo/supacloud/main/deploy/config.env -o config.env
```

### 2. 编辑配置文件

```bash
vim config.env
```

**必须修改的配置：**

```bash
# 服务器内网 IP（运行 hostname -I 获取）
INTERNAL_IP="10.0.0.1"

# Supabase 对外域名
SUPABASE_DOMAIN="supa.yourdomain.com"

# 登录密码
DASHBOARD_PASSWORD="your-strong-password"
```

### 3. 运行安装脚本

```bash
chmod +x install.sh
sudo ./install.sh
```

安装过程约 15-30 分钟，取决于网络速度。

### 4. 配置 DNS

将域名的 A 记录指向服务器公网 IP：

```
supa.yourdomain.com  →  服务器公网IP
```

### 5. 申请 HTTPS 证书（可选）

```bash
cd ~/pigsty
make cert
```

## 访问服务

| 服务 | 地址 | 默认凭据 |
|------|------|----------|
| Supabase Studio | http://IP:8000 | supabase / (你设置的密码) |
| Grafana | http://IP:3000 | admin / pigsty |
| PostgreSQL | IP:5432 | supabase_admin / DBUser.Supa |

## 常用命令

```bash
# 查看容器状态
podman ps  # 或 docker ps

# 查看服务日志
podman logs supabase-studio
podman logs supabase-analytics

# 重启所有服务
cd ~/pigsty/app/supabase
docker-compose restart

# 停止服务
docker-compose down

# 启动服务
docker-compose up -d
```

## 配置说明

### config.env 参数

| 参数 | 说明 | 必填 |
|------|------|------|
| `INTERNAL_IP` | 服务器内网 IP | ✅ |
| `SUPABASE_DOMAIN` | 对外访问域名 | ✅ |
| `DASHBOARD_USERNAME` | Studio 用户名 | |
| `DASHBOARD_PASSWORD` | Studio 密码 | ✅ |
| `POSTGRES_PASSWORD` | 数据库密码 | |
| `JWT_SECRET` | JWT 密钥 (生产必改) | ⚠️ |
| `SWAP_SIZE_GB` | Swap 大小 | |
| `S3_STORAGE_TYPE` | S3 存储类型 (minio/garage/rustfs/external) | |

### S3 存储选择

脚本支持多种 S3 兼容存储：

| 类型 | 说明 | 资源占用 |
|------|------|----------|
| `minio` | Pigsty 默认，开箱即用 | ~500MB |
| `garage` | 轻量级 Rust S3，适合小规模 | ~50MB |
| `rustfs` | 高性能 Rust S3，比 MinIO 快 2.3x | ~100MB |
| `external` | 使用外部 S3（阿里云 OSS、腾讯云 COS） | - |

**配置示例：**

```bash
# 使用 Garage（推荐低内存服务器）
S3_STORAGE_TYPE="garage"

# 使用 RustFS（推荐高性能场景）
S3_STORAGE_TYPE="rustfs"

# 使用外部 S3
S3_STORAGE_TYPE="external"
EXTERNAL_S3_ENDPOINT="https://oss-cn-beijing.aliyuncs.com"
EXTERNAL_S3_REGION="oss-cn-beijing"
EXTERNAL_S3_BUCKET="your-bucket"
EXTERNAL_S3_ACCESS_KEY="your-access-key"
EXTERNAL_S3_SECRET_KEY="your-secret-key"
```

### 生成 JWT 密钥

```bash
# 生成 JWT_SECRET
openssl rand -base64 32

# 使用 JWT_SECRET 生成 ANON_KEY 和 SERVICE_ROLE_KEY
# 参考: https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys
```

## 运行时切换

部署完成后，可以使用 `switch.sh` 脚本切换运行时和存储：

```bash
chmod +x switch.sh
```

### 查看当前状态

```bash
sudo ./switch.sh status
```

### 切换 Edge Functions 运行时

```bash
# 切换到 Bun（高性能）
sudo ./switch.sh runtime bun

# 切换回 Deno（官方默认）
sudo ./switch.sh runtime deno
```

### 切换 S3 存储

```bash
# 切换到 Garage（轻量级，推荐）
sudo ./switch.sh storage garage

# 切换到 RustFS（高性能）
sudo ./switch.sh storage rustfs

# 切换到 MinIO（Pigsty 默认）
sudo ./switch.sh storage minio

# 切换到外部 S3（阿里云 OSS / 腾讯云 COS）
sudo ./switch.sh storage external
# 会提示输入 S3 端点、密钥等信息
```

### 运行时对比

| 运行时 | 冷启动 | 性能 | 官方支持 | 生态 |
|--------|--------|------|----------|------|
| Deno | ~100ms | 良好 | ✅ | Deno 模块 |
| Bun | ~10ms | 极高 | ⚠️ 兼容 | npm 包 |

### S3 存储对比

| 存储 | 内存占用 | 性能 | 特点 |
|------|----------|------|------|
| MinIO | ~500MB | 良好 | Pigsty 默认 |
| Garage | ~50MB | 良好 | 轻量级，分布式 |
| RustFS | ~100MB | 极高 | 比 MinIO 快 2.3x |
| 外部 S3 | 0 | 取决于网络 | 阿里云/腾讯云等 |

## 故障排查

### 服务无法启动

```bash
# 检查日志
podman logs supabase-analytics --tail 50

# 检查数据库连接
podman exec -it supabase-analytics env | grep POSTGRES
```

### 内存不足

脚本会自动为 < 3.5GB 内存的服务器创建 Swap，如需手动创建：

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Docker Compose 问题

```bash
# 安装独立版 docker-compose
curl -L "https://github.com/docker/compose/releases/download/v2.32.3/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
```

## 架构说明

```
┌─────────────────────────────────────────────────────────────┐
│                        Nginx (端口 80/443)                   │
│                    (SSL 终止, 反向代理)                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Kong (端口 8000)                        │
│                    (API 网关, 路由)                          │
└─────────────────────────────────────────────────────────────┘
          │           │           │           │
          ▼           ▼           ▼           ▼
     ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
     │ Studio │  │  Auth  │  │  REST  │  │Realtime│
     │ (管理) │  │ (认证) │  │ (API)  │  │(实时)  │
     └────────┘  └────────┘  └────────┘  └────────┘
          │           │           │           │
          └───────────┴───────────┴───────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  PostgreSQL (端口 5432)                      │
│              (由 Pigsty 管理, 带监控和备份)                    │
└─────────────────────────────────────────────────────────────┘
```

## 参考文档

- [Pigsty 官方文档](https://pigsty.cc/)
- [Pigsty Supabase 教程](https://pigsty.cc/docs/app/supabase/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
