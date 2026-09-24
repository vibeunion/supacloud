# 可复用业务组合、恢复与类型化客户端

本指南补全 Medusa 的模块组合、Restate 的恢复语义和 tRPC 的类型反馈方向，
不引入三者的运行时依赖，不新增通用工作流引擎，也不替换现有 HTTP、
GraphQL、Worker、CLI 或普通 CRUD。

## 业务组合只装配一次

可执行示例：[fulfillment.ts](../packages/elysia/src/examples/fulfillment.ts)。
它接收四个已绑定的命令，以普通 TypeScript 组合：

```text
HTTP / 事件 Worker / 定时 Worker / 可信 CLI
                    |
               fulfillment.execute
                    |
inventory.reserve -> payments.charge -> orders.confirm
                            |
                    确认业务拒绝
                            |
                    inventory.release
```

模块拥有自己的业务操作和权限。应用组合层只决定步骤顺序及分支；
入口负责验证输入和取得可信身份，然后调用同一个组合。
普通查询和 CRUD 不需要经过这个组合层。

每个步骤使用现有 `bindCompiledCommand` 装配其编译模块、Command 类名、
治理适配器、处理器和结果解码器。授权、幂等、事务、审计、静态 AOP
仍由现有执行路径负责。不要同时在入口路由绑定相同 Command 并在处理器里
再次直接执行它，避免重复治理。

模块切面和命令切面就是显式扩展点，不再增加一套组合层拦截器。
同一步骤可供多个应用组合调用，绑定本身不持有请求身份或请求级服务。
长期任务的身份与恢复权限由可信宿主构造，不能直接信任消息里的用户字段。

### 持久化与操作标识

- 示例的 `FulfillmentSteps` 是类型化的绑定端口，不是持久化实现。
  各步骤必须返回经校验的 `DurableCommandReceipt`，包括审计状态。
- 同一次业务操作跨入口保持同一操作键、租户和原始主体；每个命令以自己的
  命令名隔离回执。不同业务操作使用不同键，不能复用某次请求的随机追踪 ID。
- 交互式执行必须重新授权，包括读取既有成功回执的情况。独立后台恢复走
  `authorizeRecovery`，不能伪造原始用户身份以绕过检查。
- 数据库内业务变化、回执与审计使用 `createTransactionalCommand` 和现有
  Postgres store；外部调用用 `createExternalCommand` 先持久化 intent。
- 外部结果未知时，重复调用 `execute` 不会重新发送。已有恢复处理器负责
  查询、确认结果与补齐审计；其后显式重新进入组合，前序步骤从回执恢复。
- 应用 outbox / Workflow / pgflow 负责持久调度与再次进入组合。
  这个普通函数不自动入队、不存第二本日志、不自己创建租约或后台循环。
  请求断开不会自动撤销已经提交的步骤。

### 补偿不是回滚

| 当前事实 | 组合行为 |
| --- | --- |
| 支付已确认成功且审计完成 | 进入订单确认 |
| 支付已确认业务拒绝且审计完成 | 调用独立授权、幂等的库存释放命令 |
| 支付 pending / unknown / 审计未完成 | 返回 pending，不确认订单、不补偿、不重发 |
| 步骤抛出异常 | 保留失败，不猜测外部是否已执行 |
| 补偿失败或补偿结果未知 | 保留失败或 pending，不能报告已回滚 |
| 权限被撤销 | 拒绝该步骤，不能凭旧回执绕过当前权限 |

确认支付失败并不能普遍推出所有业务都应该释放库存；这是本示例明确选择的
领域策略。生产应用仍需根据实际订单状态、并发和外部凭据匹配确认其策略。

## 恢复决策可观测，不改变执行机制

`createExecutionPolicy` 增加可选 `observer`：

```ts
const policy = createExecutionPolicy({
  kind: "read",
  retry: {
    maxAttempts: 3,
    delayMs: 100,
    classify: classifyReadFailure,
  },
  observer: event => metrics.record("inventory.lookup", event),
});
```

事件包含 `kind`、`attempt`、`phase` 和可选固定 `reason`。
`started/succeeded/failed` 描述实际尝试；`retry` 表示已决定重试，
不保证下一次尝试已经发生；`rejected` 表示取消或熔断阻止了尝试。
调用前拒绝的 `attempt` 为 0。宿主在 observer 闭包绑定操作名和追踪标识，
并限制标签基数。

原有安全边界不变：

- 读取仅在显式分类允许时重试。
- 命令仅在驱动已确认事务回滚时重试。
- 写入结果未知、超时或外部发送失败不能自动重试。
- 取消是协作式请求，不是回滚证明；不与尚未结束的写入竞争返回成功。

`createCommandRecoveryHandler` 同样接受可选 `observer`，事件包含
`command`、`commandId`、`stepId`、`attempt`、`stage`、`phase` 和可选
固定 `reason`。阶段为 `recover/complete/retry/fail`。

`recover.succeeded` 只表示完成了一次合法回执查询，结果仍可能未知；
只有 `complete.succeeded` 表示恢复处理器取得完整回执并成功确认此消息。
确认失败记录 `complete.failed` 并传播原始失败；消息再次投递时仅恢复回执，
不调用业务发送。`retry.succeeded` 表示重试请求已被接收，不是业务已成功。

这些事件不包含输入、结果、原始异常或凭据。事件对象冻结；
observer 的同步抛错或 Promise 拒绝被隔离，不影响业务、重试或消息确认。
观察器不是审计持久化，也不被等待；进程退出可能丢失观测事件。
可信宿主仍需配置日志访问权限，标识符也不应包含敏感数据。

## 前后端只维护一份公开契约

继续使用路由的 TypeBox `body/params/query/responses` 作为生成客户端的
类型来源。共享契约模块不能导入服务端连接、凭据或控制器实现。
调用者不需要再写一份请求和返回接口：

```ts
import { createApiClient, ApiClientError } from "./generated/client";

const api = createApiClient({ baseUrl: "/api" });
try {
  const result = await api.orders.create({ body: { total: 10 } });
  // result 的类型来自该路由的 responses 契约。
} catch (error) {
  if (error instanceof ApiClientError) {
    reportFailure(error.code, error.status, error.requestId);
  }
  throw error;
}
```

生成客户端新增 `ApiClientError`，仍是标准 `Error`：

| code | 含义 |
| --- | --- |
| `API_HTTP_ERROR` | HTTP 非成功状态没有匹配的公开响应 Schema |
| `API_RESPONSE_INVALID` | JSON 无法解析，或响应不符合声明的 Schema |
| `API_RESPONSE_UNDECLARED` | 响应状态没有匹配 Schema，也不符合既有原始二进制/流回退 |

`method/path/status/requestId` 可供程序判断。生成路由的 `path` 是模板，
不会包含展开后的路径参数、查询或服务地址。手动调用底层 `request` 时，
不要把秘密放在其 path 参数中。

未声明的 HTTP 错误不再把原始服务端正文拼进 `message`。需要明确检查正文时，
使用 `error.response` 读取原始 `Response`；这个属性不参与 JSON 序列化，
但仍可能含敏感内容，不能直接记录到日志。响应体由检查者负责消费或取消。
声明过的错误响应继续作为经过校验的联合类型返回，不会全部改成异常。
应用自定义 decoder 和网络传输抛出的错误仍保持原样。

错误码描述传输或契约事实，不证明写入失败或事务已回滚。该改动不添加自动
重试；涉及外部副作用时仍使用回执查询。自定义 fetch/interceptor 的重试
行为由宿主负责，不能用本客户端测试宣称任意拦截器都不会重复发送。

路由契约变化需要重新生成并运行消费者 typecheck。测试覆盖共享 Schema
变更后旧调用失败、修正调用通过，以及浏览器构建不依赖 Elysia/commands。
REST、GraphQL、原始请求、响应 decoder、二进制和流能力继续保留。

## 验证

从仓库根目录运行：

```sh
bun test --timeout 60000 packages/elysia/src/fulfillment.test.ts packages/elysia/src/command-binding.test.ts
bun test packages/commands/src/observation.test.ts packages/commands/src/recovery.test.ts packages/commands/src/execution-policy.test.ts
bun test --timeout 60000 packages/compiler/src/client-errors.test.ts packages/compiler/src/client-runtime.test.ts packages/compiler/src/client-types.test.ts
```

组合测试的内存回执只证明调用顺序、隔离和恢复分支，不证明真实数据库事务、
跨进程持久化或外部提供商 exactly-once。既有数据库/Worker 验收仍然适用。
相关验收项和证据边界见 [Task Contract](framework-composition-acceptance.md)。
