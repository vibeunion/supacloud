# SupaCloud Studio 自编译构建

启用云平台模式，支持多项目、组织管理等企业功能。

## 为什么需要自编译？

`NEXT_PUBLIC_*` 环境变量在 Next.js 构建时嵌入到 JavaScript 代码中，运行时注入无效。官方 Docker 镜像使用 `IS_PLATFORM=false` 构建，只支持单项目模式。

## 构建方式

### 方式一：本地构建（推荐）

```powershell
# 1. 克隆 Supabase 源码
git clone --depth 1 https://github.com/supabase/supabase.git supabase-studio

# 2. 运行构建脚本
cd supacloud/deploy/studio
.\build.ps1

# 3. 输出目录
# dist/standalone - 可直接运行
```

### 方式二：Docker 构建

```powershell
# 构建 Docker 镜像
.\build.ps1 -Docker

# 推送到镜像仓库
.\build.ps1 -Docker -Push -Tag your-registry/supacloud-studio:latest
```

## 部署

### 服务器部署

```bash
# 1. 上传构建产物
scp -r dist/* root@server:/opt/supacloud/studio/

# 2. 启动服务
cd /opt/supacloud/studio
node server.js
```

### Docker 部署

```bash
# 使用 docker-compose
docker-compose up -d
```

## 配置说明

| 变量 | 值 | 说明 |
|------|-----|------|
| `NEXT_PUBLIC_IS_PLATFORM` | `true` | 启用云平台模式 |
| `NEXT_PUBLIC_API_URL` | `/api` | API 路径（由 Angie 代理） |
| `NEXT_PUBLIC_SITE_URL` | `https://studio.esgfarm.cn` | 站点 URL |

## 功能对比

| 功能 | 官方镜像 | 自编译镜像 |
|------|---------|-----------|
| 多项目支持 | ❌ | ✅ |
| 组织管理 | ❌ | ✅ |
| 团队协作 | ❌ | ✅ |
| 计费集成 | ❌ | 🟡 需配置 |
| 权限管理 | ❌ | ✅ |

## 注意事项

1. 构建需要约 4GB 内存
2. 首次构建约需 10-15 分钟
3. 构建产物约 200MB
