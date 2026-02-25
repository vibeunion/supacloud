# Podman 环境下 Edge Functions 外网 DNS 解析失败排查

## 问题现象

在 RHEL / OpenCloudOS / RockyLinux 等使用 **podman** 而非 Docker 的环境中，通过 `docker compose`（podman 的 docker 兼容层）启动 Supabase Stack 后，Edge Functions 容器（`supabase-edge-functions`）在加载含有远程 CDN 依赖的 Deno 函数时会失败：

```
worker boot error: failed to bootstrap runtime: could not find an appropriate entrypoint
```

或者在函数内部发起外网请求时报：

```json
{"message": "name resolution failed"}
```

## 根本原因

`docker compose`（通过 podman 兼容层）在创建 `supabase_default` 网络时会自动设置：

```json
"options": {
  "isolate": "true"
}
```

这个选项使 podman 的内置 DNS 服务（`aardvark-dns`）处于隔离模式，**只解析容器间的内部名称，不转发任何外网域名查询**（如 `deno.land`、`esm.sh` 等）。

因此 Edge Functions 容器在首次加载函数时，无法通过 CDN 下载 Deno 模块依赖，导致启动失败。

> **注意**：如果是在容器已有 Deno 模块缓存的情况下重启，不会触发该问题。每次 `docker rm` 后重建容器会暴露此问题。

## 修复步骤

> **适用系统**：RHEL 8/9、OpenCloudOS、RockyLinux、CentOS Stream 等使用 podman 的环境

### 1. 修改网络配置文件

```bash
python3 - <<'EOF'
import json

path = "/etc/containers/networks/supabase_default.json"
data = json.load(open(path))

# 移除 isolate 限制
data["options"].pop("isolate", None)

# 加入上游 DNS（使用宿主机实际可用的 DNS）
data["dns_servers"] = ["8.8.8.8", "114.114.114.114"]

json.dump(data, open(path, "w"), indent=5)
print("Done:", path)
EOF
```

> 如果你的宿主机使用了自定义 DNS（如 Pigsty 的 `10.6.0.7`），可将其加入 `dns_servers` 列表。

### 2. 重启 aardvark-dns 使配置生效

```bash
# kill 后 podman 会在下次网络操作时自动重启 aardvark-dns
kill $(pgrep aardvark-dns)
sleep 1
```

### 3. 重建 Edge Functions 容器

```bash
cd /path/to/supabase  # 你的 docker-compose.yml 所在目录
docker compose up -d --force-recreate functions
```

### 4. 验证修复

```bash
# 应返回 DNS 解析结果（而非 NXDOMAIN 或超时）
nslookup deno.land 10.89.0.1
```

## 后续维护

修改 `supabase_default.json` 是针对**已创建网络**的手动修复。  
如果在更换机器或全新部署时遇到同样问题，重复上述步骤即可。

如需永久生效，可在 `/etc/containers/containers.conf` 中配置全局 DNS：

```toml
[network]
dns_servers = ["8.8.8.8", "114.114.114.114"]
```

然后在**创建网络之前**写入此配置，新建的 podman 网络将自动继承该 DNS 设置。
