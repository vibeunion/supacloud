# SupaCloud

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## 🇬🇧 English

**SupaCloud** is a next-generation, ultra-lightweight PaaS specifically designed for self-hosting Supabase. It reimagines the multi-project architecture using **Bun.js**, **Garage S3**, and **Global Postgres**.

Unlike traditional deployments that waste GBs of RAM per project, SupaCloud enables you to run **dozens of isolated Supabase projects** on a single $5 VPS.

### 🌟 Key Features

*   **Extreme Efficiency**: Uses a **Shared Resource Architecture**. 10 projects consume only ~1 Postgres & ~1 Garage instance.
*   **Instant Provisioning**: One-click to spin up a full stack (Kong, GoTrue, Studio, API) in seconds.
*   **Fully Automated**:
    *   **Auto DB**: Automatically creates isolated logical databases.
    *   **Auto S3**: Automatically provisions Garage Buckets & Keys.
    *   **Auto Networking**: Manages internal ports and routing automatically.
*   **China Ready**: Built-in `bun-auth` service for each project, supporting **WeChat MiniApp** login out-of-the-box.
*   **Modern Stack**: Powered by Bun 1.2+ Native SQL & HTTP. Zero legacy dependencies.

### 🚀 Quick Start

#### 1. Initialize & Start
```bash
cd manager
bun install
bun run setup
# This generates all secrets and configs automatically.

cd ../base
docker compose up -d
# Wait for postgres and garage to be healthy

cd ../manager
bun run start
```
Dashboard: http://localhost:8888

#### 3. Create Project
1. Open Dashboard.
2. Enter project name (e.g., `shop`).
3. Click "Create".
   - **Done!** Access your Studio at the assigned port (e.g., `http://localhost:3010`).

### 📂 Architecture

*   `base/`: The Core (Global Postgres 15, Garage S3, Gateway).
*   `templates/`: The Cell (Lightweight Project Template).
*   `instances/`: Running Cells (Your Projects).
*   `manager/`: The Brain (Bun Orchestrator).

---

<a name="chinese"></a>
## 🇨🇳 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级 PaaS 平台。它基于 **Bun.js**、**Garage S3** 和 **Global Postgres** 重构了多租户架构。

打破传统部署“一个项目一套重型架构”的资源浪费，SupaCloud 让你可以**在一台 5美元的 VPS 上流畅运行数十个隔离的 Supabase 项目**。

### 🌟 核心特性

*   **极致轻量**：采用**资源共享架构**。10 个项目仅占用 1 个 Postgres 和 1 个 Garage 实例。
*   **秒级交付**：一键拉起全套服务 (Kong, GoTrue, Studio, API)，无需等待。
*   **全自动化**：
    *   **自动建库**：自动创建逻辑隔离的数据库。
    *   **自动 S3**：自动分配 Garage Bucket 和 Access Key。
    *   **自动网络**：自动管理内部端口映射。
*   **中国特供**：每个项目内置 `bun-auth` 服务，开箱即支持**微信小程序**一键登录。
*   **现代技术**：基于 Bun 1.2+ 原生 SQL 构建。零历史包袱。

### 🚀 快速开始

#### 1. 初始化与启动
```bash
cd manager
bun install
bun run setup
# 这一步会自动生成所有密钥并配置环境

cd ../base
docker compose up -d
# 等待 postgres 和 garage 进入健康状态

cd ../manager
bun run start
```
管理面板：http://localhost:8888

#### 3. 创建项目
1. 打开面板。
2. 输入项目名（例如 `shop`）。
3. 点击 "Create"。
   - **完成！** 访问分配的 Studio 端口 (例如 `http://localhost:3010`)。

### 📂 架构设计

*   `base/`: 核心基座 (Global Postgres 15, Garage S3, Gateway)。
*   `templates/`: 细胞模板 (轻量级项目单元)。
*   `instances/`: 运行中的细胞 (你的项目)。
*   `manager/`: 大脑 (Bun 编排器)。
