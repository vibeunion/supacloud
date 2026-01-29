# SupaCloud

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## 🇬🇧 English

**SupaCloud** is a next-generation, ultra-lightweight PaaS specifically designed for self-hosting Supabase. It reimagines the deployment architecture using **Pigsty**, **RustFS/MinIO**, and **Global Postgres**.

Unlike traditional deployments that waste GBs of RAM per project, SupaCloud enables you to run **fully managed, isolated Supabase projects** with extreme efficiency on your own infrastructure.

### 🌟 Key Features

*   **Pigsty Powered**: Leverages the power of Pigsty for robust PostgreSQL management and monitoring.
*   **One-Click Installation**: Fully automated setup via a single `install.sh` script.
*   **Extreme Efficiency**: Uses a shared resource architecture to minimize overhead.
*   **Project Isolation**: Each project is logically isolated with its own database and configuration.
*   **China Ready**: Built-in support for regional requirements, including optimized mirrors and WeChat login compatibility.
*   **Flexible Storage**: Supports multiple S3-compatible backends: RustFS (recommended), MinIO, Garage, or external S3.
*   **Dual Runtime Cloud Functions**: Supports both **Bun.js** and **Deno** for project-level functions. Switch runtimes instantly via `switch.sh`.
*   **Comprehensive Monitoring**: Built-in Grafana dashboards and Prometheus monitoring.

### 🚀 Quick Start

#### 1. Requirements

- **OS**: rocky/almalinux 8/9, Ubuntu 22/24, Debian 12
- **RAM**: 2GB minimum (4GB+ recommended)
- **Disk**: 40GB+ SSD

#### 2. Installation

```bash
# 1. Clone the repository
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. Configure environment (IMPORTANT)
# Edit config.env to set your domains and passwords
cp config.env.example config.env # if example exists, otherwise modify existing config.env
vim config.env

# 3. Run installation script
sudo bash install.sh
```

#### 3. Management

*   **Switch Runtime/Storage**: Use `./switch.sh` to change Edge Functions runtime (bun/deno) or storage backend.
*   **Check Status**: Use standard container tools (`podman` or `docker`) to check service status.

### 📂 Architecture

*   `install.sh`: One-click deployment script (environment initialization and service setup).
*   `config.env`: Global configuration file.
*   `switch.sh`: CLI tool for runtime and storage switching.
*   `packages/`: Shared components (MCP, bun-auth, etc.).

---

<a name="chinese"></a>
## 🇨🇳 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级 PaaS 平台。它基于 **Pigsty**、**RustFS/MinIO** 和 **Global Postgres** 重新构建了部署架构。

打破传统部署资源浪费，SupaCloud 让您可以**在自己的基础设施上高效、稳定地运行多个隔离的 Supabase 项目**。

### 🌟 核心特性

*   **Pigsty 驱动**：利用 Pigsty 强大的 PostgreSQL 管理、高可用及监控能力。
*   **一键部署**：通过 `install.sh` 脚本实现全自动化环境初始化与服务拉起。
*   **极致轻量**：采用资源共享架构，大幅降低多项目运行时的资源开销。
*   **项目隔离**：租户在逻辑层面完全隔离，拥有独立的数据库、JWT 密钥等。
*   **中国优化**：内置镜像加速，完美支持**微信小程序**登录等国内常用场景。
*   **多存储后端**：支持 RustFS (推荐)、MinIO、Garage 或 外部 S3 等多种存储方案。
*   **双运行时云函数**：支持 **Bun.js** 和 **Deno**。通过 `switch.sh` 一键切换，灵活适配。
*   **全方位监控**：内置 Grafana 仪表盘和 Prometheus 指标采集，运行状态一目了然。

### 💻 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | Rocky/AlmaLinux 8/9, Ubuntu 22/24, Debian 12 | Rocky Linux 9 |

### 🚀 快速开始

#### 1. 安装与配置

```bash
# 1. 下载代码
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. 编辑配置 (必须)
# 默认配置已适用于大多数场景，请务必设置 SUPABASE_PUBLIC_DOMAIN
vim config.env

# 3. 运行安装脚本
sudo bash install.sh
```

#### 2. 常用操作

*   **切换运行时/存储**：使用根目录下的 `switch.sh` 脚本切换 Edge Functions 运行时或 S3 存储类型。
*   **状态检查**：通过 `podman ps` 或 `docker ps` 查看服务运行状态。

### 📂 架构设计

*   `install.sh`: 一键部署脚本 (环境初始化与服务编排)。
*   `config.env`: 全局配置文件。
*   `switch.sh`: 运行时/存储切换工具。
*   `packages/`: 共享组件库 (MCP、bun-auth 等)。

### 参考文档

- [Pigsty 官方文档](https://pigsty.cc/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
