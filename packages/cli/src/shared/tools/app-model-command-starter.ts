import { COMMAND_RECEIPT_SQL } from "./command-receipts";
import metadata from "./starter-metadata.json" with { type: "json" };
import { baseTemplateFiles, type StarterSdkDependencies } from "./app-starter-templates";

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

const MODEL = `datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
plugin policy {
  provider = "@zenstackhq/plugin-policy"
}
type Principal {
  id String
  tenantId String
  canCreate Boolean
  canApprove Boolean
  @@auth()
}
enum OrderState {
  draft
  approved
}
model Order {
  tenantId String @map("tenant_id") @deny("update", true)
  id String @deny("update", true)
  ownerId String @map("owner_id") @deny("update", true)
  title String
  state OrderState @default(draft)
  version Int @default(1)
  @@id([tenantId, id])
  @@map("model_orders")
  @@allow("read", auth() != null && tenantId == auth().tenantId && (ownerId == auth().id || auth().canApprove))
  @@allow("create", auth() != null && auth().canCreate && tenantId == auth().tenantId && ownerId == auth().id && state == "draft" && version == 1)
  @@allow("update", auth() != null && auth().canApprove && tenantId == auth().tenantId)
}
`;

const CONTRACTS = `import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

const Id = Type.String({ minLength: 1, maxLength: 100 });
export const CreateInput = Type.Object({ id: Id, title: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const ApproveInput = Type.Object({ id: Id, expectedVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const ApproveBody = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const Params = Type.Object({ id: Id }, { additionalProperties: false });
export const KeyHeaders = Type.Object({ "idempotency-key": Id });
export const OrderResult = Type.Object({ id: Id, title: Type.String(), state: Type.Union([Type.Literal("draft"), Type.Literal("approved")]), version: Type.Integer() }, { additionalProperties: false });
export const Decision = Type.Union([
  Type.Object({ outcome: Type.Literal("applied"), order: OrderResult }, { additionalProperties: false }),
  Type.Object({ outcome: Type.Literal("conflict"), order: Type.Null() }, { additionalProperties: false }),
]);
export const ReceiptResult = Type.Object({ tenantId: Type.String(), actorId: Type.String(), command: Type.String(), operationId: Type.String(), dispatchKey: Type.String(), status: Type.Literal("confirmed"), audit: Type.Literal("complete"), result: Decision }, { additionalProperties: false });
export const ReadResult = Type.Object({ order: Type.Union([OrderResult, Type.Null()]) }, { additionalProperties: false });
export type CreateInput = Static<typeof CreateInput>;
export type ApproveInput = Static<typeof ApproveInput>;
export type Decision = Static<typeof Decision>;
export type OrderResult = Static<typeof OrderResult>;
export type Principal = { readonly id: string; readonly tenantId: string; readonly canCreate: boolean; readonly canApprove: boolean };
export type OrderReceipt = Static<typeof ReceiptResult>;

export function decoder<S extends TSchema>(schema: S): (value: unknown) => Static<S> {
  const compiled = Compile(schema);
  return value => { if (!compiled.Check(value)) throw new TypeError("Invalid order contract"); return value; };
}
export const decodeCreate = decoder(CreateInput);
export const decodeApprove = decoder(ApproveInput);
export const decodeDecision = decoder(Decision);
export const decodeOrder = decoder(OrderResult);
export const decodeReceipt = decoder(ReceiptResult);
export interface OrderPort {
  create(context: unknown, key: string, input: CreateInput): Promise<OrderReceipt>;
  approve(context: unknown, key: string, input: ApproveInput): Promise<OrderReceipt>;
  read(context: unknown, id: string): Promise<{ order: OrderResult | null }>;
}

export type OrderFailure = { readonly _tag: "OrderDenied" } | { readonly _tag: "OrderInvalid" }
  | { readonly _tag: "OrderReplayConflict" } | { readonly _tag: "OrderUnavailable" };
export function publicFailure(error: unknown): OrderFailure {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "COMMAND_REJECTED") return { _tag: "OrderDenied" };
  if (code === "COMMAND_INPUT_INVALID") return { _tag: "OrderInvalid" };
  if (code === "COMMAND_IDEMPOTENCY_CONFLICT") return { _tag: "OrderReplayConflict" };
  return { _tag: "OrderUnavailable" };
}
`;

const COMMANDS = `import { Command, defineOperationAspect, type Aspect } from "@supacloud/app/core";
import { createTypeBoxTransactionalCommand } from "@supacloud/commands/typebox";
import { plaintextCommandInput } from "@supacloud/commands";
import { CommandError, type CommandIdentity, type CommandStore } from "@supacloud/contracts";
import type { CallFunctionOptions, JsonArgument, ReadFunctionArg, ReadFunctionRow } from "@supacloud/db/model-contract";
import { Type } from "typebox";
import { CreateInput, ApproveInput, Decision, decodeApprove, decodeDecision, decodeOrder, decoder, type Principal } from "./contracts";

type OrderRow = { readonly id: string; readonly title: string; readonly state: string; readonly version: number };
type OrderDb = {
  readonly order: {
    createMany(args: { readonly data: readonly Record<string, unknown>[]; readonly skipDuplicates?: boolean }): Promise<{ readonly count: number }>;
    findUniqueOrThrow(args: { readonly where: { readonly tenantId_id: { readonly tenantId: string; readonly id: string } }; readonly select: Record<keyof OrderRow, true> }): Promise<OrderRow>;
    updateMany(args: { readonly where: Record<string, unknown>; readonly data: Record<string, unknown> }): Promise<{ readonly count: number }>;
  };
};
type Tx = {
  readonly db: OrderDb;
  readonly lock: (keys: readonly string[]) => Promise<void>;
  readonly readFunction: (name: string, args?: readonly ReadFunctionArg[]) => Promise<unknown>;
  readonly readFunctionByRow: (name: string, row: ReadFunctionRow) => Promise<unknown>;
  readonly callFunction: (name: string, args?: readonly JsonArgument[], options?: CallFunctionOptions) => Promise<unknown>;
};
type Store = CommandStore<unknown>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function isTx(value: unknown): value is Tx {
  const root = isRecord(value) ? value : undefined;
  const db = root && isRecord(root["db"]) ? root["db"] : undefined;
  const order = db && isRecord(db["order"]) ? db["order"] : undefined;
  const methods = ["lock", "readFunction", "readFunctionByRow", "callFunction"];
  return !!root && !!db && !!order && methods.every(name => typeof root[name] === "function")
    && ["createMany", "findUniqueOrThrow", "updateMany"].every(name => typeof order[name] === "function");
}
function decodeTx(value: unknown): Tx {
  if (!isTx(value)) throw new TypeError("Invalid model command transaction");
  return value;
}
const decodeCapabilities = decoder(Type.Object({ canApprove: Type.Boolean() }, { additionalProperties: false }));
export const approvalAspect = defineOperationAspect({
  kind: "command", name: "orders.approve", input: decodeApprove, result: decodeDecision,
  capabilities: context => decodeCapabilities(context.services?.["approval"]),
}, async ({ capabilities }, next) => {
  if (!capabilities.canApprove) throw new CommandError("COMMAND_REJECTED");
  return await next();
});

function sameActor(identity: CommandIdentity, principal: Principal): boolean {
  return identity.actorId === principal.id && identity.tenantId === principal.tenantId;
}

@Command({ name: "orders.create", permission: "orders:create", rpc: "modelOrders", transaction: "required", idempotency: "required", audit: "orders.create.decided" })
export class CreateOrder {
  private readonly executor;
  constructor(store: Store, principal: Principal) {
    this.executor = createTypeBoxTransactionalCommand({
      name: "orders.create", store, schemas: { input: CreateInput, result: Decision },
      // This sample contains no secret inputs. Use an authenticated codec for sensitive data.
      inputCodec: plaintextCommandInput,
      authorize: identity => sameActor(identity, principal) && principal.canCreate ? "allow" : "deny",
      audit: { event: "orders.create.decided", details: (input, result) => ({ id: input.id, outcome: result.outcome }) },
      execute: async (rawTx, input): Promise<Decision> => {
        const tx = decodeTx(rawTx);
        const created: { count: number } = await tx.db.order.createMany({ data: [{ ...input, tenantId: principal.tenantId, ownerId: principal.id, state: "draft", version: 1 }], skipDuplicates: true });
        if (created.count !== 1) return { outcome: "conflict", order: null };
        const row: { id: string; title: string; state: string; version: number } = await tx.db.order.findUniqueOrThrow({ where: { tenantId_id: { tenantId: principal.tenantId, id: input.id } }, select: { id: true, title: true, state: true, version: true } });
        return { outcome: "applied", order: decodeOrder(row) };
      },
    });
  }
  execute(identity: CommandIdentity, key: string, input: CreateInput, signal?: AbortSignal) {
    return this.executor.execute(identity, key, input, signal);
  }
}

@Command({ name: "orders.approve", permission: "orders:approve", rpc: "modelOrders", transaction: "required", idempotency: "required", audit: "orders.approval.decided", aspects: [approvalAspect] })
export class ApproveOrder {
  private readonly executor;
  constructor(store: Store, principal: Principal, pipeline: Aspect) {
    this.executor = createTypeBoxTransactionalCommand({
      name: "orders.approve", store, schemas: { input: ApproveInput, result: Decision }, inputCodec: plaintextCommandInput,
      authorize: identity => sameActor(identity, principal) && principal.canApprove ? "allow" : "deny",
      audit: { event: "orders.approval.decided", details: (input, result) => ({ id: input.id, outcome: result.outcome }) },
      execute: async (rawTx, input) => {
        const tx = decodeTx(rawTx);
        return decodeDecision(await pipeline({
        kind: "command", name: "orders.approve", input,
        services: { approval: { canApprove: principal.canApprove } },
      }, async (): Promise<Decision> => {
        const changed: { count: number } = await tx.db.order.updateMany({
          where: { tenantId: principal.tenantId, id: input.id, state: "draft", version: input.expectedVersion },
          data: { state: "approved", version: { increment: 1 } },
        });
        if (changed.count !== 1) return { outcome: "conflict", order: null };
        const row: { id: string; title: string; state: string; version: number } = await tx.db.order.findUniqueOrThrow({ where: { tenantId_id: { tenantId: principal.tenantId, id: input.id } }, select: { id: true, title: true, state: true, version: true } });
        return { outcome: "applied", order: decodeOrder(row) };
      }));
      },
    });
  }
  execute(identity: CommandIdentity, key: string, input: ApproveInput, signal?: AbortSignal) {
    return this.executor.execute(identity, key, input, signal);
  }
}
`;

const HTTP = `import { Effect } from "effect";
import { Body, Controller, Get, Headers, Inject, Injectable, InjectionToken, Module, Param, Post, REQUEST_CONTEXT } from "@supacloud/app/core";
import { ApproveOrder, CreateOrder } from "./commands";
import { CreateInput, ApproveBody, Params, KeyHeaders, ReadResult, ReceiptResult, publicFailure, type OrderFailure, type OrderPort, type OrderReceipt } from "./contracts";

export const ORDERS = new InjectionToken<OrderPort>("orders");
const errors = [
  { tag: "OrderDenied", status: 403, code: "ORDER_DENIED" },
  { tag: "OrderInvalid", status: 400, code: "ORDER_INVALID" },
  { tag: "OrderReplayConflict", status: 409, code: "ORDER_REPLAY_CONFLICT" },
  { tag: "OrderUnavailable", status: 503, code: "ORDER_UNAVAILABLE" },
] as const;

@Injectable({ scope: "request" })
@Controller("/orders")
export class OrdersController {
  constructor(@Inject(ORDERS) private readonly orders: OrderPort, @Inject(REQUEST_CONTEXT) private readonly context: unknown) {}
  @Post("/", { body: CreateInput, headers: KeyHeaders, idempotency: "required", responses: { 200: ReceiptResult }, effect: { required: true, dependencies: [], errors: errors, retry: "none" } })
  create(@Body() input: CreateInput, @Headers("idempotency-key") key: string): Effect.Effect<OrderReceipt, OrderFailure, never> {
    return Effect.tryPromise({ try: () => this.orders.create(this.context, key, input), catch: publicFailure });
  }
  @Post("/:id/approve", { params: Params, body: ApproveBody, headers: KeyHeaders, idempotency: "required", responses: { 200: ReceiptResult }, effect: { required: true, dependencies: [], errors: errors, retry: "none" } })
  approve(@Param("id") id: string, @Body() input: { expectedVersion: number }, @Headers("idempotency-key") key: string): Effect.Effect<OrderReceipt, OrderFailure, never> {
    return Effect.tryPromise({ try: () => this.orders.approve(this.context, key, { id, expectedVersion: input.expectedVersion }), catch: publicFailure });
  }
  @Get("/:id", { params: Params, responses: { 200: ReadResult }, effect: false })
  read(@Param("id") id: string): Promise<Awaited<ReturnType<OrderPort["read"]>>> {
    return this.orders.read(this.context, id);
  }
}

@Module({ name: "orders", tags: ["type:feature"], controllers: [OrdersController], commands: [CreateOrder, ApproveOrder] })
export class OrdersModule {}
`;

const HOST = `import type { SQL } from "bun";
import { createApplication, ApplicationError, type CompiledModule } from "@supacloud/elysia";
import { createZenStackDatabase } from "@supacloud/db/zenstack";
import { CommandError, type CommandStore } from "@supacloud/contracts";
import { schema } from "../../zenstack/generated/schema";
import { createCompiledModules } from "../../generated/application";
import { CreateOrder, ApproveOrder } from "../features/orders/commands";
import { decodeApprove, decodeCreate, decodeOrder, decodeReceipt, type ApproveInput, type Principal, type OrderPort } from "../features/orders/contracts";

export interface ActorBinding { readonly id: string; readonly tenantId: string }
export interface VerifiedClaim { readonly actor: ActorBinding; readonly operationId: string; readonly input: ApproveInput }
export interface IdentityAuthority {
  verifyHttp(request: Request): Promise<ActorBinding>;
  // Verify a claimed job's issuer/project/actor and original operation key; do not trust its JSON fields.
  verifyWorker(claim: unknown): Promise<VerifiedClaim>;
  // Resolve current access for every HTTP or worker invocation, including receipt replay.
  resolve(actor: ActorBinding): Promise<Principal | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function isCommandStore(value: unknown): value is CommandStore<unknown> {
  return isRecord(value) && typeof value["transaction"] === "function";
}
function requireCommandStore(value: unknown): CommandStore<unknown> {
  if (!isCommandStore(value)) throw new CommandError("COMMAND_UNAVAILABLE");
  return value;
}
interface ScopedDatabase {
  readonly commandStore: unknown;
  readonly models: { readonly order: { findUnique(args: unknown): Promise<unknown> } };
}
interface DatabaseFacade {
  forIdentity(identity: Principal): ScopedDatabase;
  dispose(): Promise<void>;
}
function isDatabaseFacade(value: unknown): value is DatabaseFacade {
  if (!isRecord(value) || typeof value["forIdentity"] !== "function" || typeof value["dispose"] !== "function") return false;
  const scoped = value["forIdentity"];
  return typeof scoped === "function";
}
function requireDatabase(value: unknown): DatabaseFacade {
  if (!isDatabaseFacade(value)) throw new CommandError("COMMAND_UNAVAILABLE");
  return value;
}

export async function createModelOrderHost(pool: SQL, authority: IdentityAuthority) {
  const roles = await pool<unknown[]>\`SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'model_orders_app', 'USAGE') AS allowed,
    EXISTS (SELECT FROM pg_class WHERE oid IN ('public.model_orders'::regclass, 'supacloud_commands.execution_receipts'::regclass, 'supacloud_commands.execution_audit'::regclass)
      AND pg_has_role(current_user, relowner, 'MEMBER')) AS owns_data
    FROM pg_roles WHERE rolname=current_user\`;
  const role: unknown = roles[0];
  if (!role || typeof role !== "object" || !("rolsuper" in role) || role.rolsuper !== false
    || !("rolbypassrls" in role) || role.rolbypassrls !== false || !("allowed" in role) || role.allowed !== true
    || !("owns_data" in role) || role.owns_data !== false) {
    throw new Error("Use a non-owner application login with model_orders_app membership");
  }
  const database = requireDatabase(createZenStackDatabase(schema, pool, {}));
  const modules: CompiledModule[] = createCompiledModules();
  const ordersModule = modules.find(module => module.name === "orders");
  const approval = ordersModule?.commands?.find(command => command.name === "orders.approve")?.aspectPipeline;
  if (!approval) { await database.dispose(); throw new Error("Compile the orders command and its aspect first"); }
  const bindings = new WeakMap<object, { actor: ActorBinding; signal: AbortSignal | undefined }>();
  const issue = (actor: ActorBinding, signal?: AbortSignal): object => {
    if (!actor || typeof actor.id !== "string" || !actor.id || typeof actor.tenantId !== "string" || !actor.tenantId) {
      throw new ApplicationError("Verified actor required", { status: 401, code: "IDENTITY_REQUIRED" });
    }
    const context = Object.freeze({ requestId: crypto.randomUUID() });
    bindings.set(context, { actor: Object.freeze({ id: actor.id, tenantId: actor.tenantId }), signal });
    return context;
  };
  const bind = async (context: unknown) => {
    const issued = context !== null && typeof context === "object" ? bindings.get(context) : undefined;
    if (!issued) throw new CommandError("COMMAND_REJECTED");
    const resolved = await authority.resolve(issued.actor);
    if (!resolved || resolved.id !== issued.actor.id || resolved.tenantId !== issued.actor.tenantId
      || typeof resolved.canCreate !== "boolean" || typeof resolved.canApprove !== "boolean") throw new CommandError("COMMAND_REJECTED");
    const principal = Object.freeze({ id: resolved.id, tenantId: resolved.tenantId, canCreate: resolved.canCreate, canApprove: resolved.canApprove });
    return { principal, signal: issued.signal, identity: { tenantId: principal.tenantId, actorId: principal.id }, scoped: database.forIdentity(principal) };
  };
  const port: OrderPort = {
    create: async (context, key, input) => {
      const bound = await bind(context);
      return decodeReceipt(await new CreateOrder(requireCommandStore(bound.scoped.commandStore), bound.principal).execute(bound.identity, key, decodeCreate(input), bound.signal));
    },
    approve: async (context, key, input) => {
      const bound = await bind(context);
      return decodeReceipt(await new ApproveOrder(requireCommandStore(bound.scoped.commandStore), bound.principal, approval).execute(bound.identity, key, decodeApprove(input), bound.signal));
    },
    read: async (context, id) => {
      const bound = await bind(context);
      const row = await bound.scoped.models.order.findUnique({ where: { tenantId_id: { tenantId: bound.principal.tenantId, id } }, select: { id: true, title: true, state: true, version: true } });
      return { order: row ? decodeOrder(row) : null };
    },
  };
  const app = createApplication({
    name: "model-orders", modules, deps: { orders: port },
    requestContext: async (request, _context, signal) => issue(await authority.verifyHttp(request), signal),
    // These handlers enter the durable facade themselves. Accidental route-level
    // command binding must fail, rather than adding a second governance boundary.
    commandExecutor: () => { throw new ApplicationError("Use the identity-bound order facade", { code: "COMMAND_BOUNDARY_HANDLER_OWNED" }); },
  });
  return {
    app,
    worker: async (claim: unknown, signal?: AbortSignal) => {
      const verified = await authority.verifyWorker(claim);
      return port.approve(issue(verified.actor, signal), verified.operationId, decodeApprove(verified.input));
    },
    // The host owns pool.close(); stop HTTP/worker intake and drain it before disposal.
    dispose: () => database.dispose(),
  };
}
`;

const MIGRATION = `CREATE TYPE "OrderState" AS ENUM ('draft', 'approved');
CREATE TABLE public.model_orders (
  tenant_id text NOT NULL, id text NOT NULL, owner_id text NOT NULL, title text NOT NULL,
  state "OrderState" NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, id)
);
DO $role$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='model_orders_app') THEN CREATE ROLE model_orders_app NOLOGIN; END IF;
END $role$;
REVOKE ALL ON public.model_orders FROM PUBLIC;
ALTER TABLE public.model_orders ENABLE ROW LEVEL SECURITY;
-- The host role is a trusted command connection. It does not set request.jwt.claims,
-- so this bypass is not the model row projection. Do not grant it to PostgREST.
CREATE POLICY model_orders_host ON public.model_orders TO model_orders_app USING (true) WITH CHECK (true);
-- Authenticated RLS is projected from zenstack/schema.zmodel @@allow rules.
-- Grants stay reviewed; these policies do not by themselves grant table access.
DO $supacloud_policy_rls$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE "authenticated" NOLOGIN; END IF; END $supacloud_policy_rls$;
ALTER TABLE "public"."model_orders" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "model_orders_select" ON "public"."model_orders";
CREATE POLICY "model_orders_select" ON "public"."model_orders" FOR SELECT TO "authenticated" USING ((((auth.jwt() IS NOT NULL) AND ("tenant_id" = (auth.jwt() ->> 'tenantId'))) AND (("owner_id" = (auth.jwt() ->> 'id')) OR ((auth.jwt() ->> 'canApprove') = 'true'))));
DROP POLICY IF EXISTS "model_orders_insert" ON "public"."model_orders";
CREATE POLICY "model_orders_insert" ON "public"."model_orders" FOR INSERT TO "authenticated" WITH CHECK (((((((auth.jwt() IS NOT NULL) AND ((auth.jwt() ->> 'canCreate') = 'true')) AND ("tenant_id" = (auth.jwt() ->> 'tenantId'))) AND ("owner_id" = (auth.jwt() ->> 'id'))) AND ("state" = 'draft')) AND ("version" = 1)));
DROP POLICY IF EXISTS "model_orders_update" ON "public"."model_orders";
CREATE POLICY "model_orders_update" ON "public"."model_orders" FOR UPDATE TO "authenticated" USING ((((auth.jwt() IS NOT NULL) AND ((auth.jwt() ->> 'canApprove') = 'true')) AND ("tenant_id" = (auth.jwt() ->> 'tenantId')))) WITH CHECK ((((auth.jwt() IS NOT NULL) AND ((auth.jwt() ->> 'canApprove') = 'true')) AND ("tenant_id" = (auth.jwt() ->> 'tenantId'))));
GRANT USAGE ON SCHEMA public, supacloud_commands TO model_orders_app;
GRANT SELECT, INSERT, UPDATE ON public.model_orders TO model_orders_app;
GRANT SELECT, INSERT, UPDATE ON supacloud_commands.execution_receipts TO model_orders_app;
GRANT SELECT, INSERT ON supacloud_commands.execution_audit TO model_orders_app;
`;

/** Complete model-backed business recipe; the complex native-SQL command recipe stays separate. */
export function modelCommandTemplateFiles(name: string, sdk: StarterSdkDependencies): Record<string, string> {
  const { app, compiler, elysia, commands, contracts, db, dbZenstack, modelTooling } = metadata.packages;
  const files = baseTemplateFiles(name, sdk);
  delete files["scripts/dev.ts"];
  delete files["scripts/serve.ts"];
  const receiptFunctions: Record<string, string> = {};
  for (const match of COMMAND_RECEIPT_SQL.matchAll(/CREATE OR REPLACE FUNCTION (supacloud_commands\.(\w+))\(\)[\s\S]+?\n\$(\w+)\$;/g)) {
    receiptFunctions[`db/functions/${match[2]}.sql`] = match[0] + "\n";
  }
  if (Object.keys(receiptFunctions).length !== 2) throw new Error("Receipt function sources changed; update the model starter");
  return {
    ...files,
    ...receiptFunctions,
    "package.json": json({
      name, version: "0.0.0", private: true, type: "module", engines: { bun: ">=1.4.4" },
      scripts: {
        "db:generate": "supacloud-model generate && supacloud-db generate", "db:check": "supacloud-model check && supacloud-db check",
        "db:diff": "supacloud db plan --dir migrations", "db:plan": "supacloud db plan --dir migrations", "db:apply": "supacloud db apply --dir migrations", "db:pull": "supacloud-model pull",
        compile: "supacloud-compiler compile", "check:generated": "supacloud-compiler check", typecheck: "tsc --noEmit",
        check: "bun run db:check && bun run check:generated && bun run typecheck", test: "bun test",
        build: "bun run db:check && bun run compile && bun run typecheck && bun build src/application.ts --target bun --outdir output/supacloud",
        dev: "bun --no-env-file scripts/environment.ts development bun scripts/serve-model.ts",
      },
      dependencies: { "@supacloud/app": "^" + app.version, "@supacloud/elysia": "^" + elysia.version,
        "@supacloud/commands": "^" + commands.version, "@supacloud/contracts": "^" + contracts.version,
        "@supacloud/db": "^" + db.version, "@supacloud/db-zenstack": "^" + dbZenstack.version,
        ...db.dependencies, ...dbZenstack.dependencies, typebox: "1.4.3", effect: "4.0.5", elysia: "2.0.0-rc.4", ...sdk },
      devDependencies: { "@supacloud/compiler": "^" + compiler.version, "@supacloud/model-tooling": "^" + modelTooling.version, "@types/bun": "^1.4.4", typescript: "7.1.0-beta" },
    }),
    "supacloud.config.ts": `import { defineSupacloudConfig } from "@supacloud/compiler";
export default defineSupacloudConfig({
  databaseGovernance: { mode: "check" },
  commandCapabilities: { requirePersistentAdapters: true, permission: true, audit: true, idempotency: true, transaction: true,
    rpc: { modelOrders: { boundary: "database", transaction: true, audit: true, idempotency: true } } },
});
`,
    "database.sources.json": json({ version: 1, schema: ["zenstack/schema.zmodel", "zenstack/generated/schema.ts"], functions: "db/functions", migrations: "migrations", contracts: "db/contracts", audit: "output/database-audit", consumers: ["src", "scripts", "tests"], auditConsumers: [], trustedHosts: ["src/host", "src/application.ts"], role: "model_orders_app" }),
    "zenstack/schema.zmodel": MODEL,
    "migrations/001-command-receipts.sql": COMMAND_RECEIPT_SQL,
    "migrations/002-model-orders.sql": MIGRATION,
    "db/functions/README.md": "Maintain additional PostgreSQL functions and explicit ACL here. No RPC is required for this model recipe.\n",
    "db/modules.ts": `import { defineDatabaseModule } from "@supacloud/db";
export default defineDatabaseModule({ name: "orders", tables: ["public.model_orders"], policies: [
  { name: "model_orders_host", table: "public.model_orders", operation: "all", roles: ["model_orders_app"], source: "migrations/002-model-orders.sql", tests: ["tests/database-governance.sql"] },
  { name: "model_orders_select", table: "public.model_orders", operation: "select", roles: ["authenticated"], source: "migrations/002-model-orders.sql", tests: ["tests/database-governance.sql"] },
  { name: "model_orders_insert", table: "public.model_orders", operation: "insert", roles: ["authenticated"], source: "migrations/002-model-orders.sql", tests: ["tests/database-governance.sql"] },
  { name: "model_orders_update", table: "public.model_orders", operation: "update", roles: ["authenticated"], source: "migrations/002-model-orders.sql", tests: ["tests/database-governance.sql"] },
] });
`,
    "tests/database-governance.sql": `BEGIN READ ONLY;
DO $check$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.model_orders'::regclass) THEN
    RAISE EXCEPTION 'model_orders RLS is required';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='model_orders'
    AND policyname='model_orders_host' AND roles=ARRAY['model_orders_app']::name[] AND cmd='ALL') THEN
    RAISE EXCEPTION 'model_orders trusted host policy is required';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='model_orders'
    AND policyname IN ('model_orders_select','model_orders_insert','model_orders_update')
    AND 'authenticated'=ANY(roles)) <> 3 THEN
    RAISE EXCEPTION 'model_orders authenticated policies must match the model row projection';
  END IF;
END $check$;
ROLLBACK;
`,
    "src/features/orders/contracts.ts": CONTRACTS,
    "src/features/orders/commands.ts": COMMANDS,
    "src/features/orders/orders.ts": HTTP,
    "src/app.module.ts": `import { Module } from "@supacloud/app/core";
import { OrdersModule } from "./features/orders/orders";
@Module({ name: "app", tags: ["type:root"], imports: [OrdersModule] })
export class AppModule {}
`,
    "src/host/model-orders.ts": HOST,
    "src/application.ts": 'export { createModelOrderHost } from "./host/model-orders";\nexport type { IdentityAuthority, ActorBinding, VerifiedClaim } from "./host/model-orders";\n',
    "scripts/serve-model.ts": `import { SQL } from "bun";
import { createModelOrderHost, type IdentityAuthority } from "../src/application";
// Local bootstrap accepts an explicitly supplied identity authority, never a built-in production login.
if (process.env["APP_ENV"] !== "development") throw new Error("Development entry only");
const raw = process.env["SUPACLOUD_MODEL_DATABASE_URL"];
const authorityModule = process.env["MODEL_IDENTITY_MODULE"];
if (!raw || !authorityModule) throw new Error("Set a local SUPACLOUD_MODEL_DATABASE_URL and MODEL_IDENTITY_MODULE exporting authority");
const url = new URL(raw);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash) throw new Error("Explicit loopback database required");
const loaded: unknown = await import(authorityModule);
if (!loaded || typeof loaded !== "object" || !("authority" in loaded) || !loaded.authority || typeof loaded.authority !== "object") throw new Error("Missing identity authority");
const authority = loaded.authority;
for (const key of ["verifyHttp", "verifyWorker", "resolve"] as const) {
  if (!(key in authority) || typeof Reflect.get(authority, key) !== "function") throw new Error("Incomplete identity authority");
}
const pool = new SQL(raw);
const host = await createModelOrderHost(pool, authority as IdentityAuthority);
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env["PORT"] ?? "3000"), fetch: request => host.app.handle(request) });
const stop = async () => { await server.stop(); await host.dispose(); await pool.close(); };
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
console.log("Model orders: " + server.url);
`,
    "AGENTS.md": "# Model command development\n\nMaintain ZModel and TypeBox contracts. Regenerate and commit model/source/compiled artifacts together. Business writes use transaction.db inside the durable command. HTTP and worker use the same facade and original operation key. Bind trusted identity at src/host; resolve current access on every call. The dedicated database role is private to this host, never a browser/PostgREST role. Keep the compiled approval aspect inside the command transaction. Do not fake capabilities, replace results, retry writes in aspects, or add another receipt/audit store. Daily changes run one related test file and git diff --check.\n",
    "README.md": `# ${name}

Model-backed order creation and approval use ZenStack + Bun SQL. HTTP and the worker handler share the same durable Command, compiled approval aspect, identity policy, receipt and transaction.

1. Install matching published package versions: bun install.
2. Run bun run db:generate, bun run compile, then bun run check. Commit generated artifacts.
3. Review migrations/ and apply through the existing SupaCloud db plan/apply flow to an explicitly selected local/shadow database. Startup never migrates. Provision a non-owner login with model_orders_app membership separately.
4. Supply IdentityAuthority.verifyHttp (trusted token verification), verifyWorker (claimed job verification including actor/project and original operation key), and resolve (current access). createModelOrderHost rejects privileged database roles and has no default anonymous or memory identity.
5. For local serving, set SUPACLOUD_MODEL_DATABASE_URL and MODEL_IDENTITY_MODULE (exports authority), then bun run dev. The script binds loopback only. For deployment, import createModelOrderHost with the platform's pool and identity authority.

POST /orders accepts { id, title }. POST /orders/:id/approve accepts { expectedVersion }. Both require Idempotency-Key and return a durable receipt; result.outcome is applied or conflict. A stale version is a persisted conflict decision; use a new operation key only for a genuinely new, reviewed attempt. GET /orders/:id returns a policy-filtered order or null. Tenant and owner are never accepted from request bodies.

Connect the existing queue consumer to host.worker(claim, signal). Acknowledge only a confirmed receipt with complete audit. Redelivery with the same verified actor/tenant/key replays the receipt without rerunning the write. Failed verification, revoked access and unknown outcomes must remain failures. The handler adds no claim loop, scheduler, implicit impersonation or external dispatch. Full queue infrastructure acceptance is separate from testing this handler.

The receipt migration uses the same supacloud_commands ledger as the platform. It supports local transactional commands; external commands and durable recovery still require the existing Commands/Workflow runtime. Never apply a second migration history.

The model_orders_app role is a trusted-server capability and does not set request.jwt.claims. Its SQL policy is a host bypass, not the model row projection; do not grant that role to PostgREST. Authenticated SELECT, INSERT and UPDATE policies are emitted from the ZModel @@allow rules and must stay in the migration. They do not grant privileges; add a reviewed GRANT before exposing the table through PostgREST.

To change the schema: bun run db:generate, bun run db:check, then bun run db:plan. Review the Management API's remote plan and run bun run db:apply -- --approved_digest <digest> after approval. The CLI does not receive a database URL. Stop intake and drain HTTP/worker work before host.dispose(), then close the caller-owned pool.
`,
  };
}
