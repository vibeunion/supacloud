# SupaCloud Studio 自编译构建

启用云平台模式，支持多项目、组织管理等企业功能。

## 架构

```
浏览器 → Studio 前端 → NEXT_PUBLIC_API_URL → SupaCloud API
```

## 本地构建

```bash
docker build . -f Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:9090 -t studio
```

## GitHub Actions 手动触发

在 GitHub Actions 页面点击 "Run workflow" 按钮，手动输入参数：
- `api_url`: 你的 API 地址
- `site_url`: 你的站点地址

构建完成后，镜像会推送到 `ghcr.io/your-username/supacloud/studio:latest`。然后拉取镜像部署即可。

```bash
docker pull ghcr.io/your-username/supacloud/studio:latest
docker run -d --name supabase-studio \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=https://your-domain.com/api \
  -e NEXT_PUBLIC_SITE_URL=https://your-domain.com \
  -e NEXT_PUBLIC_IS_PLATFORM=true \
  -e SUPABASE_URL=http://kong:8000 \
  -e SUPABASE_PUBLIC_URL=https://your-domain.com \
  --memory=512m \
  supabase/studio:latest
```

---

**注意**:
1. `NEXT_PUBLIC_API_URL` 必须是完整 URL（包含 `/api` 路径）
2. 默认值 `http://localhost:9090` 仅用于本地测试
3. 实际部署时请替换为你自己的域名
