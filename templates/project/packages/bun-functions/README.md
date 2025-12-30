# Bun Edge Functions

高性能 Bun.js Edge Functions 运行时，完全兼容 `supabase.functions.invoke()` API。

## 特性

- 🚀 **高性能** - 基于 Bun.js，比 Deno 更快的冷启动
- ✅ **完全兼容** - 与 Supabase Functions API 兼容
- 🔐 **JWT 验证** - 内置 JWT 和 API Key 验证
- 📁 **热加载** - 函数文件自动重载
- 🐳 **Docker 容器** - 与 Supabase 架构一致

## 目录结构

```
bun-functions/
├── Dockerfile          # Docker 构建文件
├── index.ts            # 主服务入口
├── package.json        # 依赖配置
└── functions/          # 函数目录
    └── hello/          # 示例函数
        └── index.ts
```

## 创建函数

在 `functions` 目录下创建新文件夹，并添加 `index.ts`：

```typescript
// functions/my-function/index.ts
import type { FunctionContext } from "../hello/index";

export default async function handler(ctx: FunctionContext) {
  const { body, query, env } = ctx;
  
  // 访问 Supabase
  // const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!);
  
  return {
    success: true,
    data: body,
  };
}
```

## 调用方式

```typescript
// 使用 Supabase JS 客户端
const { data, error } = await supabase.functions.invoke('my-function', {
  body: { key: 'value' }
});

// 直接 HTTP 调用
const response = await fetch('http://localhost:9001/my-function', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'apikey': 'your-anon-key'
  },
  body: JSON.stringify({ key: 'value' })
});
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口（默认 9001） |
| `JWT_SECRET` | JWT 密钥 |
| `ANON_KEY` | Supabase 匿名密钥 |
| `SERVICE_ROLE_KEY` | Supabase 服务角色密钥 |
| `SUPABASE_URL` | Supabase API URL |

## Docker 运行

```bash
# 构建
docker build -t supabase-bun-functions .

# 运行
docker run -d \
  --name supabase-bun-functions \
  -p 9001:9001 \
  -e JWT_SECRET="your-secret" \
  -e ANON_KEY="your-anon-key" \
  -v ./functions:/app/functions:ro \
  supabase-bun-functions
```

## 本地开发

```bash
# 安装依赖
bun install

# 开发模式（热重载）
bun run dev

# 生产模式
bun run start
```
