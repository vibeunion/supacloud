# 升级到 Pigsty 4.1 及 Garage 兼容性指南

本指南旨在帮助现有 SupaCloud（基于 Pigsty 前期版本安装）的用户平滑升级到最新的 Pigsty v4.1，以获得最新的 PostgreSQL 支持、更好的性能以及系统安全提升。

## 注意事项

**在进行基础设施的全面更新前，请务必进行核心数据备份！**

Pigsty 提供了强大的自动化部署工具，但大版本跨越（特别是涉及 PostgreSQL 版本的核心调整时）可能伴随着配置变动。请在操作前仔细衡量风险时间窗。

## 升级方式一：使用一键升级脚本（推荐）

SupaCloud 提供了一个半自动化的升级辅助脚本，您可以直接在服务器终端中执行它：

```bash
cd /path/to/supacloud
bash scripts/upgrade_pigsty.sh
```

此脚本会自动：
1. 下载并在您的当前用户的主目录 (`$HOME/pigsty`) 中构建最新的 v4.1.0 发行版代码库。
2. 自动运行 `./configure`。
3. 执行 `ansible-playbook` 重新下发各项组件的更新，完成原地升级。

## 升级方式二：手动升级（遵循官方指南）

如果您维护有大量的自定义主机配置项，或希望分步执行以控制更新范围，建议直接按照 Pigsty 官方手册中的命令执行：

1. **下载并签出最新代码**：
   ```bash
   curl -fsSL https://repo.pigsty.io/get | bash -s v4.1.0
   cd ~/pigsty
   ```
2. **应用重新配置**：
   ```bash
   ./configure
   ```
3. **逐步剧本升级**：
   依据您需要更新的部分单独运行剧本。若想对整机系统进行全面应用：
   ```bash
   ansible-playbook -i pigsty.yml install.yml
   ```

## Garage S3 的重要变更兼容补充

最新版 SupaCloud `install.sh` 改变了自托管 Garage S3 的默认 Region（区域）设置，以增强其与 MinIO 和标准 S3 客户端（它们常使用诸如 `us-east-1` 等默认配置）的 API 兼容交互行为。

如果您的旧版本遇到了由于 Garage S3 的 Region 值（原被默认设为 `garage`）而导致的客户端 **AuthorizationHeaderMalformed** （鉴权签名头异常）报错问题，您可以通过以下方式手动对其进行校正兼容：

1. **修改配置文件**：编辑 `/etc/garage/garage.toml`，找到 `[s3_api]` 段落
   将其中的 `s3_region = "garage"` 修改为：
   ```toml
   s3_region = "us-east-1"
   ```
2. **修改凭据环境变量（若使用）**：
   编辑 `/etc/garage/s3-credentials.env` 以及您项目中对应的环境变量指向文件，将 `S3_REGION` 的值修正为 `us-east-1`。
3. **重新拉起引擎**：
   ```bash
   systemctl restart garage
   ```
