# @supacloud/compiler

Generated HTTP clients export `ApiClientError` with `code`, `method`, route
`path`, `status` and a bounded `requestId`. Undeclared HTTP errors no longer
embed raw response bodies in their message; explicit inspection remains
available through the non-enumerable `response` property. Declared non-2xx
response unions, caller decoders, binary/stream routes and GraphQL stay intact.
These errors do not prove write rollback and do not add automatic retries.
See [typed clients and recovery](../../docs/framework-composition.md).

## Unified Database Contracts

`supacloud-compiler database-contracts database-contracts.json` generates a shared
type entry point while preserving PostgREST, Drizzle and GraphQL native types:

```json
{
  "rootDir": ".",
  "outDir": "generated",
  "postgrestTypes": "database.types.ts",
  "drizzleSchema": "db/schema.ts",
  "role": "authenticated",
  "graphql": {
    "schema": "graphql/schema.graphql",
    "documents": ["src/**/*.graphql"]
  },
  "migrations": ["migrations/001.sql"]
}
```

Configuration paths are relative to the configuration directory; GraphQL document
patterns are resolved under `rootDir`. Supply the official PostgREST `Database`
snapshot and a role-scoped `pg_graphql` schema snapshot. The generated barrel
exports `Database`, `QueryData`, Drizzle schema types and GraphQL contracts.
Consumers need `@supabase/supabase-js` and their Drizzle dependencies.

`--check` detects drift in supplied snapshots, local Drizzle imports, migration
content/order and generated artifacts without writing. This is an offline check,
not proof of live database parity or authorization. Refresh snapshots from the
intended database and role before running it. Keep runtime decoders at untrusted
boundaries; protocol result shapes are not interchangeable.

Compiled DI requires constructor injection and generated scope factories.
Property `inject()` and runtime injection-context APIs fail with `SC2012`.
Production SQL scanning reports non-`unknown` Drizzle `sql<T>` as `SC6007` and
dynamic `sql.raw` as `SC6008`. Prefer parameters and explicit result decoders.
These rules do not replace PostgreSQL constraints, RLS or migration review.

## Local Delivery

`supacloud-compiler plan --json` previews workload targets, dependency closures,
route ownership, and required runtime capabilities without writing or deploying.
`supacloud-compiler build-delivery --json` creates independent local factory bundles
and an atomic inspection manifest, reusing unchanged artifacts without deployment.
See [local delivery](./DELIVERY.md) for validated configuration, AI-facing
contracts, and the distinction between a topology preview and release evidence.

## Persistent Execution Policy

Set `commandCapabilities.requirePersistentAdapters: true` to require named adapters
with explicit `database`/`external` boundaries, permission, audit and idempotency.
Database commands require transactional capability and `transaction: "required"`.
External adapters cannot satisfy a required database transaction: use durable
intent and read-only reconciliation instead.

`command-persistence-required` and `command-external-transaction` diagnostics include
recovery suggestions and participate in JSON output and the existing no-write-on-error
gate. These checks validate declared policy, not the implementation of a custom
adapter. See [configuration and migration](../../docs/command-migration.md).

## Source Migrations

The compiler includes deterministic, versioned source migrations for breaking
framework changes. The command is preview-only unless `--write` is explicit:

```bash
# Preview files, replacements, and manual conflicts
bunx supacloud-compiler migrate --root . --json

# Apply only after reviewing the preview
bunx supacloud-compiler migrate --root . --write
```

Migrations operate on TypeScript ASTs and skip `node_modules`, `dist`, and
`generated`. Route options are resolved through local constants,
`defineRouteContract(...)`, namespace properties, named imports, and the
project's `tsconfig` path/module settings, so a shared contract declaration is
changed once even when several controllers import it. If the contract is outside
the selected root/include set, or any file has an ambiguous transformation, the
command exits non-zero and writes no file. A successful write uses a
same-directory temporary file followed by replacement for each changed file; it
is not a version-control rollback mechanism. Review the diff, then run `compile`,
`check`, and focused tests with the same compiler version. Use version control to
revert a migration.

The current route-contract migration is `route-response-to-responses` (`0.11.0`
to `0.12.0`): it changes `response: Schema` into
`responses: { 200: Schema }`. It refuses to guess when `responses` is already
present. See the [route contract migration guide](../../docs/route-contract-migration.md)
for the complete upgrade and release sequence.

FA-derived direct-command RPC ownership, contract inspection and POST command
protocol migration are documented in `docs/fa-consumer-governance.md` in the
repository. `context <module> --json` reports `routeContracts` and standalone
command execution plans; these are declarations and obligations, not runtime proof.

## Migration Assessment

`migration-assess` creates a local, read-only compatibility report from the
installed tested tuple, generated contract manifest, compiler drift checks and
an optional OpenAPI baseline/current pair:

```bash
bunx supacloud-compiler migration-assess --json \
  --baseline-openapi artifacts/openapi-baseline.json \
  --current-openapi artifacts/openapi-current.json
```

The report distinguishes compatible changes, review items, breaking changes and
evidence that is not yet proven. It records artifact hashes and never writes
files, databases or remote environments. Rendering is explicitly independent:
CSR/SPA, SvelteKit, Nuxt, SSR, edge and trusted-server arrangements are valid;
SSR is never a migration prerequisite.

SupaCloud 应用静态编译器：读取 `@supacloud/app` 装饰器元数据的原生 TypeScript AST，构建 ApplicationGraph，做静态校验，并生成**无反射、无容器**的工厂代码与 manifest。

本包不依赖 `@supacloud/app`：AST 只按装饰器名匹配（`Module`/`Injectable`/`Inject`/`Command`/`Query`/`Controller`/`Get`/`Post`/`Put`/`Patch`/`Delete`/`defineModule`/`InjectionToken`），不校验 import 来源。

## Recommended GraphQL Query Contracts

**Database First is the only server-schema model.** Drizzle and SQL declarations
are migrated to PostgreSQL; `pg_graphql` reflects the actual database, and
`graphql-schema` exports the intended role's snapshot. Author queries/fragments,
not GraphQL resolver classes or a separate server SDL. `graphql.schema` accepts
only local `.graphql`, `.gql` or `.json` snapshots; executable sources, URLs and
schema-authoring options such as `autoSchemaFile`, `typePaths`, `resolvers` or
`mode` are rejected. Snapshot formats and TypedDocumentNode output are not
alternative authoring modes.

Do not edit exported snapshots. Change database declarations, apply migrations,
export again and compile. Offline compilation cannot attest a snapshot's origin;
`graphql-schema --check` against the intended database detects local/remote drift.
The starter's synthetic SDL is solely an offline test fixture, not a deployed
schema. Replace it with a database export before integration.

New `supacloud app init` projects preconfigure GraphQL query contracts and include
an offline example. Existing REST, Command-only and background-task projects
remain unchanged: general App/CLI configuration and `compileProject(options)`
only enable this pipeline when `graphql` is explicitly configured. Enabled
contracts always reject invalid queries and missing schemas, even with
`strict: false` or `--no-strict`. Choosing `graphql: false` (or `--no-graphql` for
one compiler run) disables adoption, not just validation of individual queries.
The platform extension is still opt-in; compilation changes no database grants,
extensions or production introspection settings.

```ts
export default defineSupacloudConfig({
  root: "src",
  graphql: { schema: "graphql/schema.graphql" },
});
```

The schema path is configuration-relative, query globs are source-root-relative.
Normal `compile`, `check`, `dev` and `context` handle the local snapshot and
queries offline. Invalid fields/variables, unnamed operations, mutations and
subscriptions produce structured diagnostics; failures preserve working output.
GraphQL.js and GraphQL Code Generator own parsing, validation and operation types.
Unknown custom scalars stay `unknown` unless explicitly mapped via `graphql.scalars`.

```sh
supacloud-compiler graphql-schema --url https://your-project.example \
  --key-env SUPACLOUD_PUBLISHABLE_KEY --token-env APP_USER_ACCESS_TOKEN
supacloud-compiler compile
supacloud-compiler check --json
```

Export is explicit and requires introspection already enabled in the selected
development project. Flags name environment variables, not secrets. Use the
intended caller role, never a privileged service-role schema for browser queries.
After migrations, use the same export command with `--check --json` to detect
remote schema drift without overwriting the local snapshot (exit 1 on drift).
Refresh intentionally, then run compile/check and the application's typecheck
and role/RLS tests. This remote gate requires development introspection; offline
compilation does not require production introspection.

Set `graphql.typedDocuments: true` to additionally generate
`graphql.documents.ts` using the standard TypedDocumentNode Codegen plugin.
Consumers of that optional file must install `@graphql-typed-document-node/core`;
it provides `ResultOf` and `VariablesOf` for operation-level inference. The default
fetch client still needs no GraphQL runtime dependency.

Both outputs use the operation plugin as the single owner of referenced enums
and input objects. Regenerate both files after upgrading the compiler; do not
deduplicate declarations by editing generated files. Scalar mappings are applied
directly to operation/input fields, and types unused by queries are not emitted.

Consumer acceptance tests cover both SDK and TypedDocumentNode output:

```gherkin
Scenario: Shared enum types
  Given multiple queries share an enum in variables and selected fields
  When the compiler generates the client artifacts
  Then each artifact declares the enum once and passes strict TypeScript checks

Scenario: Nested input objects
  Given recursive input objects contain enum lists, defaults and custom scalars
  When the compiler generates the client artifacts
  Then input declarations are unique and valid variables retain their types

Scenario: Invalid consumer code
  Given generated query contracts
  When a consumer supplies invalid variables or reads an unselected field
  Then TypeScript rejects the consumer code

Scenario: Release package acceptance
  Given an installed compiler package
  When its CLI runs the same consumer acceptance suite
  Then both artifact formats pass without editing generated files
```

Run `bun test src/graphql-package.test.ts` from this package. To test an installed
tarball or registry release with the same suite, set
`SUPACLOUD_COMPILER_TEST_CLI` to its absolute `dist/cli.js` path.
`bun run test:package` checks the built CLI and runs automatically after the build
in `prepublishOnly`, blocking publication when generated consumer types fail.

```ts
import { createGraphqlClient } from "./generated/graphql";
const queries = createGraphqlClient({
  url: projectUrl,
  publishableKey,
  getAccessToken: readCurrentUserToken,
});
const result = await queries.ReviewList({ first: 20 });
```

Method names and types come from named operations. The generated client is
dependency-free and refreshes identity per request; `getSdk(requester)` integrates
an existing transport returning `Promise<unknown>`. It rejects HTTP errors,
GraphQL errors, malformed response envelopes and invalid selected field values.
Both clients run generated operation parsers before returning typed data. No
customer TypeScript-to-TypeBox postprocessor or extra runtime dependency is needed.
The same module exports `parseReviewListQuery(value: unknown)` and
`isReviewListQuery(value: unknown)` for other integration boundaries (names follow
your operations). Validation follows the generated selected JSON shape, including
aliases, fragments, enums, lists, nullability and optional conditional fields.
Unmapped scalars remain `unknown`; scalar domain formats and authorization still
need business validation. Non-JSON scalar mappings such as `Date` fail compilation;
map the wire value to `string` and convert it after validation instead.
Generic application adapters can use `GraphqlQueryResults[Name]`,
`parseGraphqlResult(name, value)` and `isGraphqlResult(name, value)` instead of
maintaining their own result-type registry. Registry keys are operation names
such as `"ReviewList"`, without the `Query` type suffix.
`graphql.manifest.json` records query locations and the schema hash; context packs
include colocated queries. RLS/grants, real database acceptance and query resource
limits remain deployment responsibilities. Business writes stay in Commands.

Use project configuration instead of a custom compile wrapper for shared rules:

```ts
export default defineSupacloudConfig({
  root: "src",
  graphql: { schema: "graphql/schema.graphql" },
  moduleBoundaries: [{
    sourceTag: "type:feature",
    bannedDependenciesWithTags: ["type:feature"],
  }],
  typeSafety: { scanProductionSource: true, noAnyInGenerated: true },
  allowRouteCommandBindings: false,
});
```

`compile`, `check` and `dev` apply these options through the same compiler pipeline.
`check` also compares generated validators without temporary directories or writes.
`allowRouteCommandBindings: false` prevents duplicate governance when an application
executes Commands inside its own service boundary. `disallowControllerDirectDb`
and `detectOrphanModules` expose the existing optional architecture checks too.
Keep application-specific governance and business queries in the application.
See `docs/compiler-consumer-simplification.md` in the repository for the ownership
checklist and migration boundaries.

## 安装

```bash
bun add @supacloud/compiler
```

## 零配置项目

需要完整运行入口时，使用 `supacloud-cli app init --root ./orders --name orders`。
模板将本包放在 `devDependencies`，预置状态规格、治理能力、类型检查和本地测试。
编译产物的 HTTP method / scope 保留字面量联合类型，可直接传给 Elysia 适配器；
跨运行时依赖字典使用构造器/工厂参数类型连接，局部依赖保留类型推断和错误检查。

在项目根目录执行：

```bash
bunx supacloud-compiler compile
bunx supacloud-compiler dev
```

默认约定如下：

| 配置 | 默认值 |
| --- | --- |
| 源码目录 | `src` |
| 生成目录 | `generated` |
| 文件发现 | `**/*.module.ts`、`**/*.ts` |
| strict 类型安全门 | 开启 |
| typed client | 开启 |
| OpenAPI 3.1 module | 开启 |
| permissions manifest | 开启 |
| module boundary preset | `modular-monolith` |
| provider tree-shaking | 开启 |

需要覆盖默认值时，在项目根目录添加 `supacloud.config.ts`：

```ts
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  root: "src",
  outDir: "generated",
  strict: true,
  generateClient: true,
  generateOpenApi: true,
  openApi: {
    title: "Orders API",
    version: "1.0.0",
  },
  generatePermissions: true,
  moduleBoundaryPreset: "modular-monolith",
  commandCapabilities: {
    permission: true,
    audit: true,
    idempotency: true,
    transaction: true,
  },
});
```

命令行参数优先级高于配置文件。`--no-strict`、`--no-client` 和
`--no-permissions` 只建议用于本地迁移或调试；生产 CI 应保留默认 strict。
`commandCapabilities` 用于声明运行时实际支持的命令治理能力；命令声明了
`permission`、`audit` 或 `idempotency` 时，若对应能力关闭，编译器会失败。

## OpenAPI 与 Client Generator

编译器从同一份 `ApplicationGraph` 生成 `client.ts` 和 `openapi.ts`，不引入
反射或第二套路由注册。路由装饰器中显式声明的 TypeBox `body`、`params`、
`query`、`response` schema 会被静态导入；没有 schema 的字段保持为
`unknown`，不会从 TypeScript 类型推断出未经验证的运行时协议。

`client.ts` 提供路由方法、路径参数检查、请求类型和 `API_ROUTES`。已声明
响应 schema 的方法不传 decoder 也会按 HTTP status 自动选择并校验内置 schema；
传入 `ResponseDecoder<T>` 时，decoder 接收已经通过 schema 校验/规范化的值，
可安全做日期、金额等业务转换。没有响应 schema 的方法仍返回原始 `unknown`，
除非调用方显式提供 decoder。

`openapi.ts` 导出 `OPENAPI_DOCUMENT`、`OPENAPI_JSON` 和
`createOpenApiDocument()`。它包含 OpenAPI 3.1 路径、参数、请求体、响应、
错误协议、默认 bearer security scheme，以及 `x-supacloud` 中的模块、命令、
权限和静态 contract 元数据。文档只描述编译器发现的 HTTP routes；文件和
流式响应仍由宿主运行时负责传输。

```bash
# 导出可提交或交给文档工具的 JSON
bunx supacloud-compiler openapi-export generated/openapi.ts openapi.json

# 在 CI 中阻止破坏性 contract 变更
bunx supacloud-compiler openapi-diff openapi-baseline.json openapi.json --json
```

`openapi-diff` 会检查路径/操作、参数必填性、请求体、响应状态和 schema 的
枚举、属性与 required 变化；命令失败时返回非零退出码。基线文件由应用
负责版本管理，生成的 `openapi.ts` 则由普通 `compile`/`check` 漂移检查维护。

## API

```ts
import { analyzeProject, compileProject, validateGraph, watchProject } from "@supacloud/compiler";

// 完整流程：分析 → 校验 → 写出 application.ts 与 app.manifest.json
const result = await compileProject({
  rootDir: "/path/to/app",            // 项目根（含 tsconfig）
  include: ["**/*.ts"],               // 可选，默认 ['**/*.module.ts', '**/*.ts']
  outDir: "/path/to/app/generated",   // 生成目录
  strict: true,                       // 同时启用类型安全门，并将 warn 升级为 error
  typeSafety: {
    noAnyInGenerated: true,           // 生成的 TS 产物禁止 any
    scanProductionSource: true,       // 扫描生产源码的 any/断言/隐式宽化
    exclude: ["src/legacy/**"],       // 额外排除的相对 glob
  },
});
result.diagnostics; // Diagnostic[]
result.graph;       // ApplicationGraph
result.written;     // 写出的绝对路径

// 开发模式：监听源码，防抖重编译；错误时保留最后一次成功产物
const handle = watchProject({
  rootDir: "/path/to/app",
  outDir: "/path/to/app/generated",
  onEvent: (event) => console.log(event.type, event.durationMs),
});
await handle.ready;
// ...开发服务器运行...
await handle.close();

// 只做分析 / 只做校验
const graph = await analyzeProject("/path/to/app");
const diagnostics = validateGraph(graph, /* strict */ false);
```

### ApplicationGraph

```ts
interface ApplicationGraph {
  modules: ModuleNode[];     // 模块：providers/controllers/commands/jobs/queries/aspects/exports/imports/featureSpec
  externalTokens: string[];  // 被依赖但无任何模块提供的 token（平台注入，如 DB_CLIENT、REQUEST_CONTEXT）
}
```

### Feature Spec 与垂直切片

`defineFeatureSlice` 是显式的 colocated feature 入口；它仍然编译成普通
`ApplicationGraph` 模块，不绕过 provider、route、command 或 module-boundary
治理。`spec` 用状态机描述业务允许的迁移：

```ts
import { defineFeatureSlice, defineFeatureSpec } from "@supacloud/app";

const caseSpec = defineFeatureSpec({
  name: "case",
  states: ["draft", "accepted", "rejected"],
  transitions: {
    accept: {
      from: "draft",
      to: "accepted",
      permission: "case.accept",
      command: "AcceptCaseCommand",
    },
  },
});

export const CaseFeature = defineFeatureSlice({
  name: "case",
  tags: ["type:feature", "scope:case"],
  spec: caseSpec,
  providers: [AcceptCaseCommand],
  controllers: [CaseController],
});
```

编译器会拒绝重复状态/迁移、未知状态、找不到 command/route，以及
permission、transaction、idempotency、audit 与 command 元数据不一致。
`generateFeatureSource(spec)` 只生成带显式失败占位的可编辑 command slice；
它不会伪造持久化实现。`app.manifest.json` 保留 `featureSpec`，便于 CI、
IDE 和 AI agent 做状态机漂移检查。

详见 `src/types.ts`。provider 的 scope 解析顺序：provider 对象显式 `scope` > `@Injectable({ scope })` > InjectionToken 定义处的 `{ scope }` 选项 > `application`。deps 解析顺序：对象 provider 的 `deps` 数组 > `@Injectable({ deps })` > 构造函数 `@Inject(token)` 参数装饰器 > 构造函数参数类型名（仅当引用已知 token/类，否则 warn `missing-deps`）。

## 生成产物

`<outDir>/application.ts`（头注释 `// GENERATED BY @supacloud/compiler — do not edit`）：

- 文件顶部本地声明 `CompiledRoute` / `CompiledController` / `CompiledModule` 接口，不 import 任何外部包。
- `createCompiledModules()` 按 imports 拓扑序返回模块描述：`{ name, createServices, createRequestScope?, createJobScope?, controllers, commands }`。平台依赖统一由 `createApplication({ deps })` 传入生成工厂。
- `makeEnvironmentProviders`、`provideToken`、`provideAppInitializer`、`provideEnvironmentInitializer`、`provideRouter` 和 `provideHttpClient` 的可静态展开部分会在 AST 分析阶段展开为普通 provider；不支持静态安全展开的动态参数会产生诊断，不会被静默丢弃。
- 每个模块一个 `create<Name>Services(deps, imported)`：实例化 application 级 provider；dep 解析顺序为本模块 services > imports 模块导出的 services（`imported.<module>.<key>`）> 平台注入（`deps.<camelName>`）。
- 含 request 级 provider/controller 的模块额外生成 `create<Name>RequestScope(services, ctx)`：依赖 `REQUEST_CONTEXT`（或 token name `supacloud.request-context`）的参数传 `ctx`，其余经 `services` 解析（运行期负责把 imports 模块导出的 application 服务合并进 `services`）；job 级同理生成 `create<Name>JobScope`。
- 含 request/job 级 provider 或 controller 的模块同时生成异步静态 `create<Name>RequestScope` / `create<Name>JobScope` 与 `destroy<Name>RequestScope(scope)` / `destroy<Name>JobScope(scope)`；factory 在构造中途失败时按编译期确定的逆创建顺序回滚已知 `onDestroy` 方法，不会运行时扫描或解析 Token。
- `@Host()` 在 EnvironmentInjector 作用域中保留元数据但不改变解析，因为 SupaCloud 没有 Angular 元素注入器树；`@Self()` / `@SkipSelf()` 由静态 factory 按当前 scope 与模块可见性执行。
- AOP 只支持静态边界：`ModuleOptions.aspects`、`RouteOptions.aspects`、`CommandOptions.aspects` 和 `JobOptions.aspects` 必须是显式数组字面量，元素必须是可解析的函数标识符。生成器会直接 import aspect 并生成固定顺序的 onion chain，不使用 Proxy、Reflect 扫描、动态 pointcut 或运行时注册。
- 执行顺序为 `commandGovernance -> module -> route -> command -> handler`，授权拒绝不会运行业务切面；Job 使用 `module -> job -> executor -> run/execute`，并在 finally 中销毁 job scope。
- services 对象的 key 为 token 名的 camelCase：`CaseService → caseService`、`CASE_REPOSITORY → caseRepository`、`LOGGER → logger`。
- controller 描述静态给出：`{ path, serviceKey, scope, routes: [{ method, path, handler, body?, params?, query?, headers?, cookie?, response?, responses? }] }`，schema 直接引用 import 进来的对象。
- `client.ts` 在启用 `generateClient` 时生成：包含 `API_ROUTES`、`API_SCHEMAS`、类型化请求选项和显式响应 decoder 入口。
- `openapi.ts` 在启用 `generateOpenApi` 时生成：包含 OpenAPI 3.1 文档模块和可序列化 JSON；`check` 会将它纳入生成物漂移检查。
- 严格生成模式会对 `application.ts`、可选的 `client.ts` 和 `permissions.ts` 做 AST 扫描，禁止生成 `any`。

`<outDir>/client.ts` 提供按 Controller 分组的 Fetch client。路径参数会从
controller 和 route 的完整路径合并推导；声明了 `response` 或 `responses` 的
route 会自动按 HTTP status 执行内置 response decoder，并返回 schema 推导的
类型。显式 decoder 仍可用于覆盖自定义转换；没有响应 schema 的 route 返回
`unknown`。`headers`、`cookie` 和多状态 `responses` 会同步进入客户端和
OpenAPI。`buildRouteUrl` 和 `createApiClient` 可直接复用，也支持动态 headers
和请求拦截器。

### Migration from manual decoders

旧版本要求调用方为每个有响应 schema 的 route 传入 decoder。升级后删除该
decoder 即可；需要保留自定义转换时，将它作为第二个参数传入。旧的单一
`response: Schema` 当前作为迁移桥接仍可编译，但新代码必须迁移到
`responses: { 200: Schema }` 或实际的状态映射；该桥接字段不保证在下一次破坏性
版本继续保留。Management API 的契约注册表
由实际 Elysia `app.routes` 投影生成，不应再维护平行的路由清单。

完整的破坏性升级步骤（包括 headers、cookie、客户端 decoder、OpenAPI 和生成物
刷新）见 [route contract migration guide](../../docs/route-contract-migration.md)。

`<outDir>/openapi.ts` 是无额外运行时依赖的 OpenAPI 3.1 module，导出
`OPENAPI_DOCUMENT`、`OPENAPI_JSON`、`createOpenApiDocument` 和
`serializeOpenApiDocument`。它在运行时读取同一组 TypeBox schema，生成 paths、
parameters、requestBody、responses、securitySchemes 以及 `x-supacloud` 路由元数据，
因此不会维护第二份 API contract。默认包含 bearer JWT scheme；项目可在
`openApi` 配置中补充文档信息、servers 和其他显式 security schemes。

`OPENAPI_JSON` 是运行时快照；需要提交独立 `openapi.json` 时，在应用已经能加载
生成模块的运行时调用 `exportGeneratedOpenApiJson()` 或直接写出该字符串。编译器
不会为了生成 JSON 执行应用 schema。`readOpenApiJson()` 和
`diffOpenApiDocuments()` 可用于构建发布门禁：

```ts
import {
  exportGeneratedOpenApiJson,
  diffOpenApiDocuments,
  readOpenApiJson,
} from "@supacloud/compiler";

await exportGeneratedOpenApiJson({
  modulePath: "./generated/openapi.ts",
  outputPath: "./generated/openapi.json",
});

const diff = diffOpenApiDocuments(
  await readOpenApiJson("./contracts/openapi.base.json"),
  await readOpenApiJson("./generated/openapi.json"),
);
if (!diff.ok) throw new Error("OpenAPI breaking change");
```

也可以直接在 CI 中运行：

```bash
supacloud-compiler openapi-export ./generated/openapi.ts ./generated/openapi.json
supacloud-compiler openapi-diff ./contracts/openapi.base.json ./generated/openapi.json --json
```

`openapi-export` 在运行时加载生成的 `openapi.ts` 并原子地写出独立 JSON；它不会在
编译阶段执行应用 schema。可用 `--space 0` 到 `--space 10` 控制缩进，重复执行不会
改写内容不变的文件。当前只承诺 JSON 输出，YAML 转换由发布流水线按需处理。

diff 默认阻止路径/操作/参数/响应删除、请求约束收紧、响应字段收窄或安全要求新增；
新增可选参数、路径、响应和组件会标记为 non-breaking。它是保守的合同门禁，不替代
应用端的业务兼容性测试。

```ts
export default defineSupacloudConfig({
  generateClient: true,
  generateOpenApi: true,
  openApi: { title: "Orders API", version: "1.0.0" },
});
```

用 `--no-client` 或 `--no-openapi` 关闭对应产物；`compile` 和 `check` 会同时检查
已生成的 `client.ts`、`openapi.ts` 是否与当前 ApplicationGraph 漂移。

`<outDir>/app.manifest.json`：`{ version: 1, modules, externalTokens }`，供 CLI graph/explain 使用。

## 诊断码

| code | 级别 | 含义 |
| --- | --- | --- |
| `circular-dependency` | error | provider 级循环依赖（message 含环路径） |
| `scope-violation` | error | application provider 依赖 request/job provider（controller 不受限） |
| `module-boundary` | error | 依赖的 token 由未 import 的模块提供 |
| `unresolved-token` | error | 依赖的 token 无法解析且不属于平台注入 |
| `duplicate-token` | error | 同一 token 在同模块重复注册 |
| `duplicate-module` | error | 应用中存在重复模块名 |
| `duplicate-command` | error | 应用中存在重复业务 command 名 |
| `duplicate-route` | error | 规范化后 HTTP method + path 冲突 |
| `route-command-unresolved` | error | 路由绑定了本模块未声明的 command 类 |
| `command-missing-permission` | error | `@Command` 未声明 permission |
| `invalid-job-scope` | error | `@Job` 使用了不支持的 `request` scope |
| `provider-type-mismatch` | error | Provider 的 useClass/useValue/useFactory/useExisting 不满足 InjectionToken 的静态类型契约 |
| `unsupported-provider-helper` | warn（strict 时 error） | functional provider 的动态参数无法安全展开为静态 factory |
| `dynamic-aspect-reference` | error | aspects 不是显式数组字面量，或包含 spread/表达式/字符串 pointcut |
| `invalid-aspect-reference` | error | aspect 不是可静态解析的函数声明、箭头函数或函数表达式 |
| `invalid-command-mode` | error | transaction/idempotency 必须显式为 `"required"` 或 `"none"`，不允许拼写错误或动态值悄悄关闭治理（SC4012） |
| `missing-deps` | warn（strict 时 error） | 构造/工厂依赖无法静态解析 |
| `generated-any` | warn（strict 时 error） | 生成的 TypeScript 产物包含 `any` |
| `source-any` | warn（strict 时 error） | 未被排除的生产源码包含显式 `any` |
| `source-type-assertion` | warn（strict 时 error） | 生产源码使用 `as T` 或 `<T>value` 类型断言 |
| `source-non-null-assertion` | warn（strict 时 error） | 生产源码使用非空断言 `value!` |
| `source-implicit-widening` | warn（strict 时 error） | 可静态判定的字面量类型隐式宽化 |
| `invalid-feature-transition` / `feature-governance-drift` | error | Feature 状态、command、权限或事务契约发生漂移 |

依赖的 token 全图都无 provider 时不报错，记入 `externalTokens`（平台注入）。

## 类型安全扫描

`strict: true` 默认开启两道类型安全门；也可以单独配置 `typeSafety`。生产源码扫描默认排除测试、fixture、声明文件、`generated` 和 `dist`，并支持 `typeSafety.exclude` 增加项目自定义排除规则。

```bash
supacloud-compiler check --root ./app --out ./app/generated --strict
```

程序化调用可直接使用 `scanGeneratedArtifacts()` 和 `scanProductionSource()` 获取结构化诊断。

## 开发模式

```bash
supacloud-compiler dev --root . --out ./generated
```

开发模式默认对源码变化做 100ms 防抖，监听 TypeScript 文件；启用 GraphQL 后，还监听查询文件和配置的 Schema 快照。编译器会复用进程内的源码快照：相同输入直接命中缓存；只改动普通实现文件时复用既有依赖图和生成物；只有 SupaCloud 元数据、模块声明或依赖相关文件变化时才重建图。编译失败时不会覆盖最后一次成功的 `application.ts` 和 `app.manifest.json`；修复错误后会自动生成新产物。`--debounce <ms>` 可调整防抖时间。

## 图谱与诊断

```bash
supacloud-compiler graph ./app
supacloud-compiler explain CaseService ./app
supacloud-compiler doctor ./app
```

`graph` 输出模块拓扑和平台注入 token；`explain` 解释模块、provider 或 external token 的来源与依赖；`doctor` 检查项目结构、模块发现、生成物漂移和编译诊断。加 `--json` 可供 IDE、脚本和 CI 消费结构化结果。

AI Agent 可以只读取目标模块的上下文包，而不需要扫描整个项目：

```bash
supacloud-compiler context case --root ./app --json
```

Context targets also accept a module class, provider token/class, controller,
command, job, or query name/class. They resolve to the owning module and return
the same version-1 neighborhood pack (`subject` remains the module name).
Exact module names keep precedence; an ambiguous symbol is rejected with the
candidate module names instead of selecting an arbitrary owner.

上下文包包含目标模块、直接和间接上下游模块、相关源码文件、路由/Command/provider
图谱以及实际引用的平台 token。`compile --json` 和 `check --json` 会返回稳定的
`ok`、`diagnostics`、`written`/`mismatches` 字段；可修复的诊断还会包含机器可消费的
`fix`，例如 `add_module_import`、`add_command_permission` 和
`add_route_parameter_binding`。这些 fix 描述语义操作，不是脆弱的文本偏移。
可执行 fix 使用 `applyDiagnosticFix(fix, { dryRun: true })` 预览，或通过
`supacloud-compiler fix ./fix.json --dry-run` 调用；CLI 默认预览，需显式
使用 `--write` 才写盘。写盘前会重新解析 AST，
前置条件不满足时拒绝修改，并通过临时文件原子替换。
CLI 修复的 `targetFile` 相对于配置的源码根目录解析，也可以用 `--root` 显式指定；
JSON 修复文件本身仍相对于当前工作目录读取。

`createDiagnosticRepairPlan(diagnostics)` classifies existing semantic fixes as
`preview`, `input-required`, or `manual`, and retains each complete `fix` payload.
It never infers a permission or a transaction/idempotency policy. `preview`
means the executor supports the suggestion and its policy inputs are present,
not that its AST preconditions have passed or that a write has been authorized.
Unsupported fix types remain manual suggestions. Planning does not write files.

上下游分别沿单一方向遍历，不会经过共享基础模块再扩散到无关兄弟业务。
上下文包还包含准确的切面源文件、校验诊断和 `executionPlans`；`explain <module>`
也展示静态执行计划。计划描述标准命令治理；自定义 executor 的内部实现和短路行为
仍需运行时追踪验证。成功审计在 handler 返回后执行，而非 handler 之前。

例如 `@Command({ transaction: "requried" })` 会报告 `invalid-command-mode`，
并输出 `set_command_mode` 修复建议。必须显式给 fix 的 `value` 选择 `"required"`
或 `"none"` 才能预览或写入；不会推断较弱权限。若诊断后的源表达式变化，修复拒绝写盘。

`compileProject()` 现在默认在存在 error 时保留已有产物。仅诊断/迁移工具可以显式
设置 `writeOnError: true` 导出错误版本；这些产物不应被部署或视为可执行成功产物。

## 编译基准

使用 `bun run benchmark` 运行固定 fixture 基准，输出 cold compile、增量
compile、依赖失效耗时、重用/重析模块和生成产物字节数。`generation` 额外报告
同进程中旧双渲染路径与复用已校验渲染结果的对照：每组 25 次、7 组取中位数，
交替测试顺序并共用预热产物缓存。编译入口复用一次渲染结果，公共
`generateApplication(graph, options)` 调用方式不变。

基准是本地证据，不是跨机器性能承诺，也不证明整次编译按相同比例加速。
测试不以机器耗时比例作为通过条件。具体数据及限制见
[本地验收记录](../../docs/vibecoding-acceptance.md#performance-evidence)。

## 开发

```bash
bun install
bun run typecheck
bun run typecheck:test
bun test
bun run build
```

## Route Contract Policy

Project configuration defaults to `requireRouteContracts: true`. Low-level
`CompileOptions` callers can set it explicitly to report `route-contract-required` errors in both compile and
check (including JSON diagnostics). Changing this option invalidates incremental
results. Combine it with `writeOnError: false` when programmatic compilation must
not emit files on errors.

`inspectRouteContracts(graph)` lists each route and its missing body, params,
query, and response declarations. Required inputs are detected from handler
bindings and controller/route path parameters. Responses always require an
explicit declaration, including intentional void contracts.

This checks declaration coverage and rejects known opaque schemas, not full schema quality, handler/schema type
equivalence, or database authorization. It deliberately does not auto-fix missing
schemas with `unknown` placeholders. Consumers must define the actual contracts
and test decoding separately. Native output must be classified; delegated
validation and native transports require a `contract.evidence` test reference.
The report still sets `verified: false`, since a reference does not prove execution.

The source type gate now includes TypeScript syntactic/semantic diagnostics and
rejects production `@ts-ignore`, `@ts-nocheck` and `@ts-expect-error`. A source-directory root resolves
the enclosing tsconfig. When this gate is enabled, incremental compilation
rechecks types instead of returning an unchecked cached result.

Generated route calls require all path parameters and a decoder for typed
responses. See [type safety and migration](../../docs/type-safety.md).

## License

MIT
