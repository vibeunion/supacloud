# Route Contract Migration

本次框架升级把 HTTP 路由改为 schema-first：请求、响应、生成客户端和
OpenAPI 都从同一组 TypeBox schema 产生。Management API 也从已注册的
Elysia route table 投影契约，不再维护第二套路由清单。

## 变更摘要

- 路由支持 `body`、`params`、`query`、`headers`、`cookie` 和按状态码组织的
  `responses`。
- 编译器诊断编号按职责重新分区：类型安全扫描继续使用 `SC6001`--`SC6005`，
  Feature 状态机与治理诊断迁移到 `SC6101`--`SC6108`。如果 CI、IDE 或日志规则
  按 `errorCode` 匹配，请同步更新这些规则；诊断语义本身没有改变。
- `responses` 支持具体 HTTP 状态、`1XX` 到 `5XX` 状态族和 `default`。Elysia
  注册适配器会把状态族/default 展开为 100-599 的具体 validator，选择优先级为
  具体状态 > 状态族 > `default`；未知 selector 会在注册/编译阶段直接报错，
  不会静默跳过校验。
- `@Cookie()` 可把已解码的 cookie 对象或单个 cookie 注入 handler 参数。
- Elysia 在 handler 执行前完成请求校验与规范化；声明的响应由运行时按实际
  HTTP status 校验。
- 编译器生成的客户端会按响应 status 选择内置 decoder；没有响应 schema 时
  返回 `unknown`，自定义转换仍可显式传入 decoder。
- OpenAPI 的 header、cookie、request body 和多状态 responses 直接引用同一组
  schema。
- `MANAGEMENT_ROUTE_CONTRACTS` 是实际 `app.routes` 的只读投影，供诊断、文档
  和工具读取。

## 迁移步骤

### 1. 把 schema 集中到 contracts 模块

```ts
// contracts/item.ts
import { Type } from "@sinclair/typebox";

export const CreateItemBody = Type.Object({ name: Type.String() });
export const RequestHeaders = Type.Object({ authorization: Type.String() });
export const RequestCookie = Type.Object({ session: Type.String() });
export const ItemCreated = Type.Object({ id: Type.String() });
export const ItemConflict = Type.Object({ conflict: Type.Boolean() });
```

schema 必须是可被编译器解析的导出标识符。不要在 decorator 参数里直接调用
`Type.Object(...)`，也不要用 `Type.Any()` 或 `Type.Unknown()` 代替真实契约。

### 2. 用统一 route contract 绑定路由和 handler 类型

```ts
import {
  Controller,
  Post,
  type RouteHandlerInput,
  type RouteHandlerOutput,
  defineRouteContract,
} from "@supacloud/app";
import {
  CreateItemBody,
  RequestHeaders,
  RequestCookie,
  ItemCreated,
  ItemConflict,
} from "./contracts/item";

const createItemContract = defineRouteContract({
  body: CreateItemBody,
  headers: RequestHeaders,
  cookie: RequestCookie,
  responses: { 200: ItemCreated },
});

@Controller("/items")
export class ItemController {
  @Post("/", createItemContract)
  create(input: RouteHandlerInput<typeof createItemContract>): RouteHandlerOutput<typeof createItemContract> {
    const { body, headers, cookie } = input;
    return { id: `${headers.authorization}:${cookie.session}:${body.name}` };
  }
}
```

使用参数 decorator 的旧式 positional handler 也支持相同契约：

```ts
import type { Static } from "@sinclair/typebox";
import { Body, Cookie, Headers, Post } from "@supacloud/app";
import { status } from "elysia";

type CreateItemInput = Static<typeof CreateItemBody>;

@Post("/", {
  body: CreateItemBody,
  headers: RequestHeaders,
  cookie: RequestCookie,
  responses: { 201: ItemCreated, 409: ItemConflict },
})
create(
  @Body() body: CreateItemInput,
  @Headers() headers: Record<string, unknown>,
  @Cookie("session") session: string,
) {
  return body.name === "existing"
    ? status(409, { conflict: true })
    : status(201, { id: `${headers.authorization}:${session}:${body.name}` });
}
```

函数式 handler 可以直接让 callback 从 contract 推断，不再重复写
`RouteHandlerInput`/`RouteHandlerOutput`：

```ts
import { defineRouteHandler, defineTypedRoute } from "@supacloud/app";

const createItem = defineRouteHandler(createItemContract, ({ body, headers, cookie }) => ({
  id: `${headers.authorization}:${cookie.session}:${body.name}`,
}));

const routeBinding = defineTypedRoute(createItemContract, createItem);
```

`routeBinding` 适用于接收 `{ contract, handler }` 的函数式适配器。类方法仍需
显式标注 handler 输入/输出：TypeScript 原生 decorator 不会改写方法参数类型；
这不是运行时校验缺失，而是类型系统边界。升级时把旧的未标注 handler 改为上述
helper 或 `RouteHandler<typeof contract>`，让编译器和 IDE 对同一 schema 给出一致
的类型反馈。

编译器会检查绑定参数是否声明对应 schema。路径参数、query、headers 和 cookie
均不能在没有 schema 的情况下进入严格编译。

### 3. 将单响应字段迁移为状态映射

```diff
-@Get("/:id", { params: ItemParams, response: ItemResult })
+@Get("/:id", {
+  params: ItemParams,
+  responses: { 200: ItemResult },
+})
```

当前编译器仍接受 `response: Schema` 作为迁移桥接，并将其视为 `200` 响应；新
代码不要继续新增该字段。下一次破坏性版本可以移除该桥接，因此应在升级窗口内
完成全量替换。

状态映射可以使用精确状态码、`1XX` 到 `5XX` 状态族和 `default`。精确状态码
优先于状态族，状态族优先于 `default`。Elysia 运行时会把族和默认项展开为
精确校验器，客户端和 OpenAPI 也按同样的选择顺序处理。其他字符串 selector
会在编译/注册阶段报错，不再静默跳过响应校验。

如果 body schema 本身允许 `undefined`（例如根级 `Type.Optional(...)` 或包含
`Type.Undefined()` 的 union），生成的 OpenAPI 会将 `requestBody.required` 设为
`false`；普通 object schema 仍为必填。客户端请求类型是否允许省略 body 仍由
应用侧的 route contract 类型决定，不能仅凭 OpenAPI 文档推断。

### 4. 删除手写客户端 response decoder

生成客户端现在会自动按 status 解码：

```ts
const result = await api.item.create({
  body: { name: "demo" },
  headers: { authorization: "Bearer token" },
  cookie: { session: "s-1" },
});
```

需要日期、金额或其他业务转换时，保留显式 decoder 作为第二个参数。decoder
只负责转换已读取的响应值，不能把未声明的响应类型断言成业务类型。

### 5. 重新生成并检查产物

升级后重新运行项目的 compiler `compile`，提交新的 `application.ts`、
`client.ts` 和 `openapi.ts`（若项目生成这些文件），再运行 `check` 检查产物
漂移。不要手工编辑生成文件。

### 6. 切换 Management API 契约读取方式

```ts
import { MANAGEMENT_ROUTE_CONTRACTS } from "@supacloud/management-api";

for (const route of MANAGEMENT_ROUTE_CONTRACTS) {
  // route.schemas 是实际 Elysia hooks 的只读投影
  console.log(route.method, route.path, route.schemas.response);
}
```

删除维护平行 route registry 的代码。注册表只描述当前已经挂载到 Elysia 的
路由，不替代 route 定义，也不声称运行时验证已经被端到端验收。

## 发布顺序与回滚边界

1. 先升级 `@supacloud/app`、`@supacloud/compiler` 和 `@supacloud/elysia`，再
   重新生成应用产物。
2. 同时发布使用新 `client.ts` 的调用方；客户端和服务端的 schema/status map
   必须来自同一版本的 contracts 模块。
3. 检查 OpenAPI diff，确认状态码、headers、cookie 和响应字段变化均已评审。
4. 如果需要回滚，回滚应用源码和生成产物到同一版本；不要只回滚客户端或只
   回滚 Elysia runtime。`response` 迁移桥接不应成为长期混合版本策略。

这项升级改变的是源码和生成产物契约，不会自动修改数据库或现有数据。真实
HTTP 请求、认证、cookie 存储和业务域校验仍需由各应用自己的边界测试覆盖。
