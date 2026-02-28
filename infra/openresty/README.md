# OpenResty + lua-resty-auto-ssl + PostgreSQL 存储

替代 Pigsty 默认 Nginx 的完整方案，解决 Rocky Linux 9 上 ACME 动态模块 ABI 不兼容导致的
Segmentation Fault 崩溃问题。证书数据以 PostgreSQL 为后端持久化，充分利用 Pigsty 已有的
高可用、备份和监控基础设施。

## 文件结构

```
infra/openresty/
├── storage_adapters/
│   └── postgres.lua          # lua-resty-auto-ssl PostgreSQL 适配器
├── migrations/
│   └── 001_autossl_schema.sql # 建表 SQL（autossl schema + 专用角色）
├── nginx.conf                 # OpenResty 配置模板
├── setup.sh                   # 一键安装脚本（Rocky Linux 9）
└── README.md                  # 本文件
```

## 前提条件

- Rocky Linux 9 / RHEL 9
- Pigsty 已部署且 PostgreSQL 运行正常
- 域名 DNS A 记录已指向服务器公网 IP（Let's Encrypt HTTP-01 验证必需）
- 服务器 80/443 端口可从公网访问（Cloudflare 已放行回源 IP）

## 安装步骤

```bash
# 1. 进入项目根目录
cd /path/to/supacloud

# 2. 执行一键安装脚本（需要 root）
sudo bash infra/openresty/setup.sh

# 3. 按提示修改 nginx.conf 中的域名和 PG 密码
sudo vim /usr/local/openresty/nginx/conf/nginx.conf

# 4. 在 pigsty.yml 中禁用 Pigsty 管理的 Nginx
#    nginx_enabled: false

# 5. 启动 OpenResty
sudo systemctl enable --now openresty

# 6. 验证证书申请（首次访问有 5-30 秒延迟）
curl -I https://your-domain.com
```

## Pigsty 配置

在 `pigsty.yml` 中添加以下配置，防止 Pigsty 重新安装或管理 Nginx：

```yaml
nginx_enabled: false
nginx_exporter_enabled: false
```

> **注意**：每次运行 Pigsty Ansible playbook 前确认此配置仍有效。

## 数据库说明

证书数据存储在 `autossl.certificates` 表中：

```sql
-- 查看已申请的证书
SELECT key, updated_at
FROM autossl.certificates
WHERE key LIKE '%:latest'
ORDER BY updated_at DESC;

-- 查看当前 ACME challenge token（正在申请时短暂存在）
SELECT key, expires_at
FROM autossl.certificates
WHERE key LIKE '%:challenge:%';
```

## 手动续期触发（测试用）

```bash
# 将证书标记为 25 天后过期（触发续期检查阈值 < 30 天）
psql -U postgres -c "
  UPDATE autossl.certificates
  SET expires_at = NOW() + INTERVAL '25 days'
  WHERE key LIKE '%:latest';
"
# 等待 renew_check_interval（默认 86400s）后会自动续期
# 测试时可在 nginx.conf 中临时设置为 60s
```

## 常见问题

**Q: 首次访问 HTTPS 很慢（20-30秒）？**
A: 正常现象。OpenResty 正在向 Let's Encrypt 申请证书，申请完成后会缓存，后续访问毫秒级响应。

**Q: Let's Encrypt 申请失败？**
A: 检查：① 域名 DNS 是否指向本机 ② 80 端口是否开放 ③ `allow_domain` 白名单是否包含该域名
查看日志：`tail -f /usr/local/openresty/logs/error.log | grep auto-ssl`

**Q: Pigsty 升级后 Nginx 被重新安装？**
A: 确认 `pigsty.yml` 中 `nginx_enabled: false` 已设置。如已被覆盖需手动停止 nginx 并重启 openresty：
`systemctl stop nginx && systemctl start openresty`

**Q: 如何迁移旧的文件存储证书到 PostgreSQL？**
A: 运行以下脚本（需在 Pigsty 服务器上执行）：
```bash
for f in /etc/resty-auto-ssl/storage/file/*; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")
  key=$(python3 -c "import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))" "$fname")
  value=$(cat "$f")
  psql -U autossl postgres -c \
    "INSERT INTO autossl.certificates(key,value) VALUES(\$1,\$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value" \
    -v v1="$key" -v v2="$value" 2>/dev/null
done
echo "Migration done."
```
