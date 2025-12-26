# 使用自定义协议 (MQTT, gRPC, TCP, UDP)

SupaCloud 采用开放式架构，除了标准的 HTTP/WebSocket (API, Studio) 流量外，还为每个项目预留了一个 **通用的扩展端口 (EXT_PORT)**。

你可以在你的项目代码（`bun-auth` 或其他服务）中使用这个端口来实现任何基于 TCP 或 UDP 的自定义协议，例如 MQTT（用于物联网）、gRPC（用于微服务）、KCP（用于游戏）等。

## 环境变量

在项目的 `.env` 文件中，你会看到以下变量：

```bash
# Custom Protocol Port (MQTT/TCP/UDP)
EXT_PORT=9010
```

这个端口已经映射到了你的运行环境中。

---

## 示例 1: 集成 MQTT Broker (Aedes)

如果你需要处理物联网设备的连接，可以直接在你的 Bun 服务中嵌入一个高性能的 MQTT Broker。

### 1. 安装依赖

在你的项目目录下 (例如 `packages/bun-auth`)：

```bash
bun add aedes aedes-server-factory
```

### 2. 在代码中启动 Broker

修改 `index.ts`：

```typescript
import Aedes from "aedes";
import { createServer } from "aedes-server-factory";
import { serve } from "bun";

// ... 其他 HTTP 服务代码 ...

// 启动 MQTT Broker
const startMqtt = () => {
  const port = parseInt(process.env.EXT_PORT || "9000");
  const aedes = new Aedes();
  
  // 认证钩子 (可选: 使用 Supabase Auth)
  aedes.authenticate = (client, username, password, callback) => {
    // 示例: 允许所有连接
    // 实际项目中请调用 supabase.auth.getUser(token) 验证 password
    console.log(`MQTT Client connected: ${client.id}`);
    callback(null, true);
  };

  const server = createServer(aedes);
  
  server.listen(port, () => {
    console.log(`🔌 MQTT Broker running on port ${port}`);
  });
};

startMqtt();

// ... 其他代码 ...
```

---

## 示例 2: 纯 TCP 服务

如果你需要一个简单的 TCP 服务（例如处理硬件原始 Socket 数据）：

```typescript
const port = parseInt(process.env.EXT_PORT || "9000");

Bun.listen({
  hostname: "0.0.0.0",
  port: port,
  socket: {
    data(socket, data) {
      console.log(`Received ${data.length} bytes`);
      socket.write("Echo: " + data);
    },
    open(socket) {
      console.log("TCP connection opened");
    },
    close(socket) {
      console.log("TCP connection closed");
    },
  },
});

console.log(`📡 TCP Server listening on ${port}`);
```

## 注意事项

- **端口唯一性**: SupaCloud Manager 会自动为每个项目分配不同的 `EXT_PORT` (9010, 9020, 9030...)，因此你可以在同一台服务器上运行多个项目而不会发生端口冲突。
- **防火墙**: 确保你的服务器防火墙放行了 `9000-10000` 范围的端口。

---

## 架构决策：集成 vs 微服务

你可能会问：*“我应该把 MQTT 写在 `bun-auth` 里，还是单独起一个容器？”*

### 方案 A：集成模式 (推荐默认)
利用 SupaCloud 提供的 `EXT_PORT`，将 MQTT/TCP 服务直接运行在现有的 Bun 实例中。
- **优点**: 零运维成本，无需修改 `docker-compose.yml`，共享内存和数据库连接，性能极高（Bun 单进程并发能力极强）。
- **适用**: 绝大多数物联网、实时游戏、简单的 TCP 代理场景。

### 方案 B：独立微服务模式 (进阶)
如果你的 MQTT 服务非常复杂，或者需要使用非 JS 语言（如 Rust/Go）编写专用服务：
1. 在项目目录下创建新目录 (e.g. `packages/rust-mqtt`).
2. 手动修改项目的 `docker-compose.yml`，添加新的 Service。
3. 这种方式提供了更好的隔离性，但牺牲了 SupaCloud 的部分自动化管理的便利性。
