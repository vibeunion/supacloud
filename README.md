# SupaCloud

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## 🇬🇧 English

**SupaCloud** is a next-generation, ultra-lightweight PaaS specifically designed for self-hosting Supabase. It reimagines the multi-project architecture using **Bun.js**, **RustFS**, and **Global Postgres**.

Unlike traditional deployments that waste GBs of RAM per project, SupaCloud enables you to run **dozens of isolated Supabase projects** on a single $5 VPS.

### 🌟 Key Features

*   **Web Dashboard**: Built-in beautiful, dark-themed management UI powered by **Hono** & **Alpine.js**. Access at `http://localhost:8888`.
*   **Auto Upgrade**: Keep your SupaCloud up-to-date with a single command `supacloud upgrade`.
*   **Extreme Efficiency**: Uses a **Shared Resource Architecture**. 10 projects consume only ~1 Postgres & ~1 RustFS instance.
*   **Project Isolation**: Each project has its own database, JWT keys, and S3 bucket - fully isolated at the logical level.
*   **Instant Provisioning**: One-click to spin up a full stack (Kong, GoTrue, Studio, API) in seconds.
*   **Fully Automated**:
    *   **Auto DB**: Automatically creates isolated logical databases.
    *   **Auto S3**: Automatically provisions S3 Buckets & Keys.
    *   **Auto Networking**: Manages internal ports and routing automatically.
*   **China Ready**: Built-in `bun-auth` service for each project, supporting **WeChat MiniApp** login out-of-the-box.
*   **Dual Runtime Cloud Functions**: Supports both **Bun.js** and **Deno** for project-level functions. Switch runtimes instantly via CLI.
*   **Flexible Analytics**: Supports **Postgres-based** lightweight logging or standard ClickHouse. Can be fully disabled for low-resource environments.
*   **Modern Stack**: Powered by Bun 1.2+ Native SQL & HTTP. Zero legacy dependencies.

### 🚀 Quick Start

#### 1. Installation

**Linux & macOS**
```bash
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud
# Edit configuration if needed
vim config.env
# Install dependencies and setup environment
sudo ./install.sh
```

**Windows (WSL2 Recommended)**
Please use WSL2 to run the Linux installation steps above.

#### 2. Initialize & Start
After installation, you can initialize a workspace anywhere.

```bash
mkdir my-cloud && cd my-cloud
supacloud init
supacloud start
```

#### 3. Create Project
```bash
supacloud create shop
```
*   **Studio**: `http://shop.studio.localhost`
*   **API**: `http://shop.localhost`

> **Project Naming Rules**: 3-32 characters, must start with a lowercase letter, can contain lowercase letters, numbers, and hyphens, must end with a letter or number. Reserved names like `postgres`, `admin`, `supabase` are not allowed.

#### 4. Commands
*   `supacloud status` - Check platform status and logs.
*   `supacloud runtime <name> <bun|deno>` - Switch project runtime (Bun/Deno).
*   `supacloud help` - Show all commands.

### 📂 Architecture

*   `install.sh`: One-click installation script.
*   `config.env`: Environment configuration.
*   `manager/`: The Brain (Bun Orchestrator & Web Dashboard).
*   `packages/`: Shared Components (MCP, bun-auth, bun-functions).
*   `templates/base/`: Core Infrastructure (Global Postgres, RustFS S3, Caddy Gateway).
*   `instances/`: Running Projects (Tenant configs & functions).

---

<a name="chinese"></a>
## 🇨🇳 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级 PaaS 平台。它基于 **Bun.js**、**RustFS** 和 **Global Postgres** 重构了多项目架构。

打破传统部署"一个项目一套重型架构"的资源浪费，SupaCloud 让你可以**在一台 5美元的 VPS 上流畅运行数十个隔离的 Supabase 项目**。

### 🌟 核心特性

*   **Web 控制台**：内置精美的暗黑风格管理界面，基于 **Hono** & **Alpine.js** 构建。访问地址：`http://localhost:8888`。
*   **自动升级**：通过指令 `supacloud upgrade` 一键在线升级到最新版本。
*   **极致轻量**：采用**资源共享架构**。10 个项目仅占用 1 个 Postgres 和 1 个 RustFS 实例。
*   **项目隔离**：每个项目拥有独立的数据库、JWT 密钥和 S3 存储桶，逻辑层面完全隔离。
*   **秒级交付**：一键拉起全套服务 (Kong, GoTrue, Studio, API)，无需等待。
*   **全自动化**：
    *   **自动建库**：自动创建逻辑隔离的数据库。
    *   **自动 S3**：自动分配 S3 Bucket 和 Access Key。
    *   **自动网络**：自动管理内部端口映射。
*   **中国特供**：每个项目内置 `bun-auth` 服务，开箱即支持**微信小程序**一键登录。
*   **双运行时云函数**：支持 **Bun.js** 和 **Deno** 双模式。通过 CLI 一键切换项目运行时，灵活适配。
*   **灵活分析**：支持 **Postgres** 轻量级日志存储，或标准 ClickHouse 模式。低配机器可完全禁用以节省内存。
*   **现代技术**：基于 Bun 1.2+ 原生 SQL 构建。零历史包袱。

### 💻 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB (自动开启 Swap) | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | Rocky/AlmaLinux 8/9, Ubuntu 22/24, Debian 12 | Rocky Linux 9 |

### 🚀 快速开始

#### 1. 安装与配置

```bash
# 1. 下载代码
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. 编辑配置 (可选)
# 默认配置已适用于大多数场景，如需修改端口或域名请编辑 config.env
vim config.env

# 3. 运行安装脚本
sudo ./install.sh
```

**`config.env` 关键配置项说明：**

| 参数 | 说明 | 必填 |
|------|------|------|
| `INTERNAL_IP` | 服务器内网 IP (脚本会自动检测) | ✅ |
| `SUPABASE_DOMAIN` | 对外访问域名 (如 `supa.example.com`) | ✅ |
| `DASHBOARD_PASSWORD` | Studio 登录密码 | ✅ |
| `JWT_SECRET` | JWT 密钥 (生产环境建议修改) | ⚠️ |
| `S3_STORAGE_TYPE` | S3 存储类型 (minio/rustfs/external) | |

#### 2. 启动平台

安装完成后，Manager 和基础服务将自动准备就绪。

```bash
# 进入 Manager 目录启动 (开发模式)
cd manager
bun install
bun run start
```
或者如果已构建二进制文件：
```bash
supacloud start
```

#### 3. 创建项目

```bash
supacloud create shop
```
*   **Studio**: `http://shop.studio.localhost`
*   **API**: `http://shop.localhost`

> **项目命名规则**：3-32 个字符，必须以小写字母开头，可包含小写字母、数字和连字符，必须以字母或数字结尾。

### 🔧 高级配置与运维

#### DNS 配置
将域名的 A 记录指向服务器公网 IP：
```
supa.yourdomain.com  →  服务器公网IP
```

#### 运行时切换
使用根目录下的 `switch.sh` 脚本切换 Edge Functions 运行时或 S3 存储类型：

```bash
# 切换到 Bun 运行时 (高性能)
sudo ./switch.sh runtime bun

# 切换到 Deno 运行时 (官方默认)
sudo ./switch.sh runtime deno

# 切换 S3 存储后端 (minio / rustfs / external)
sudo ./switch.sh storage rustfs
```

#### 故障排查

**服务无法启动**
```bash
# 检查日志
podman logs supabase-analytics --tail 50

# 检查数据库连接
podman exec -it supabase-analytics env | grep POSTGRES
```

**Docker Compose 问题**
如果遇到 Docker Compose 版本问题，脚本会自动尝试安装最新版本。你也可以手动更新：
```bash
curl -L "https://github.com/docker/compose/releases/download/v2.32.3/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
```

### 📂 架构设计

*   `install.sh`: 一键部署脚本 (环境初始化)。
*   `config.env`: 全局配置文件。
*   `switch.sh`: 运行时/存储切换工具。
*   `manager/`: 核心管控服务 (Bun 编排器 & Web 控制台)。
*   `packages/`: 共享组件库 (MCP、bun-auth、bun-functions)。
*   `templates/base/`: 基础设施模板 (Global Postgres、RustFS S3、Caddy 网关)。
*   `instances/`: 租户实例数据。

### 参考文档

- [Pigsty 官方文档](https://pigsty.cc/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
