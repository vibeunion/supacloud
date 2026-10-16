import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { t } from "elysia";
import { plaintextCommandInput } from "@supacloud/commands";
import { CommandError, decodeCommandIdentity } from "@supacloud/contracts";
import { COMMAND_PERSISTENCE_SQL, createPostgresCommandStore, type CommandDatabase } from "@supacloud/db";
import { startStarterPostgres, type StarterPostgres } from "../../../scripts/lib/starter-postgres";
import { PGMQ_SQL } from "../../supacloud-lite/src/runtime/db/emulated";
import { appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import {
  ApplicationError, createCommandExecutor, createSchemaDecoder, createTransactionalCommandGovernance,
  executeCompiledCommand, type CommandGovernance, type CommandInvocation, type CompiledCommand, type CompiledModule,
  type SupAuthContextOptions, type SupAuthRequestContext,
} from "./index";

const bin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
if (!bin && process.env["SUPACLOUD_REQUIRE_RUNTIME_SAFETY"] === "1") {
  throw new Error("SUPACLOUD_STARTER_POSTGRES_BIN is required for native command acceptance");
}
const native = bin ? describe : describe.skip;
const input = createSchemaDecoder(t.Object({
  id: t.String(), expectedVersion: t.Integer({ minimum: 1 }),
}, { additionalProperties: false }), { normalize: false });
const result = createSchemaDecoder(t.Object({
  state: t.Literal("approved"), version: t.Integer({ minimum: 2 }),
}, { additionalProperties: false }), { normalize: false });
const descriptor: CompiledCommand = {
  className: "Approve", name: "review.approve", permission: "review.approve",
  transaction: "required", idempotency: "required", audit: "review.approved",
};
const module: Pick<CompiledModule, "name" | "commands"> = { name: "review", commands: [descriptor] };
const identity = { tenantId: "project-a", actorId: "actor-a" };

native("transactional governance on isolated native PostgreSQL", () => {
  let database: StarterPostgres;
  beforeAll(async () => {
    database = await startStarterPostgres(bin!);
    await database.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    // Match the starter's native profile: real PostgreSQL, Lite SQL queue compatibility.
    await database.exec(PGMQ_SQL);
    for (const name of ["workflows-public", "commands-public"]) {
      await database.exec(await readFile(new URL(
        `../../management-api/src/db/sql-modules/${name}.sql`, import.meta.url), "utf8"));
    }
    await database.exec(COMMAND_PERSISTENCE_SQL);
    await database.exec(`CREATE TABLE public.binding_reviews (
      id text PRIMARY KEY, tenant_id text NOT NULL, owner_id text NOT NULL,
      allowed boolean NOT NULL DEFAULT true, state text NOT NULL DEFAULT 'draft',
      version integer NOT NULL DEFAULT 1
    )`);
  }, 30_000);
  afterAll(async () => { await database?.close(); }, 30_000);

  async function rows(text: string, parameters: readonly string[] = []) {
    const value = await database.transaction(tx => tx.query(text, parameters));
    if (!Array.isArray(value)) throw new Error("Invalid test rows");
    return value as unknown[];
  }
  async function fixture() {
    const id = crypto.randomUUID();
    await rows("INSERT INTO public.binding_reviews(id,tenant_id,owner_id) VALUES($1,$2,$3)",
      [id, identity.tenantId, identity.actorId]);
    return { id, expectedVersion: 1 };
  }
  function binding(options: { auditFailure?: boolean; database?: CommandDatabase } = {}) {
    return createTransactionalCommandGovernance({
      permission: "review.approve",
      identity: invocation => decodeCommandIdentity(invocation.requestContext),
      input: invocation => invocation.input.body,
      rejection: error => error instanceof ApplicationError && error.code === "REVIEW_CONFLICT"
        ? new CommandError("COMMAND_IDEMPOTENCY_CONFLICT") : undefined,
      definition: {
        name: "review.approve", input, result, inputCodec: plaintextCommandInput,
        store: createPostgresCommandStore(options.database ?? database),
        async authorize(who, request, tx) {
          const found = await tx.query(
            "SELECT id FROM public.binding_reviews WHERE id=$1 AND tenant_id=$2 AND owner_id=$3 AND allowed FOR UPDATE",
            [request.id, who.tenantId, who.actorId]);
          return Array.isArray(found) && found.length === 1 ? "allow" : "deny";
        },
        audit: {
          event: "review.approved", details: request => ({ reviewId: request.id }),
          async write() { if (options.auditFailure) throw new Error("private audit failure"); },
        },
      },
    });
  }
  function invocation(value: unknown, key: string): CommandInvocation {
    return {
      command: descriptor,
      request: new Request("https://test.invalid/reviews/approval-receipt", {
        headers: { "idempotency-key": key },
      }),
      requestContext: identity, services: {},
      input: { params: {}, query: {}, body: value },
    };
  }
  function run(
    bound: ReturnType<typeof binding>, value: unknown, key = crypto.randomUUID(),
    options: {
      identity?: typeof identity; command?: CompiledCommand;
      afterWrite?: () => Promise<unknown>; invalidResult?: boolean; signal?: AbortSignal;
    } = {},
  ) {
    return executeCompiledCommand({
      module: options.command ? { ...module, commands: [options.command] } : module,
      command: "Approve", input: value, governance: bound.governance,
      request: new Request("https://test.invalid/reviews/approve", {
        headers: { "idempotency-key": key }, ...(options.signal ? { signal: options.signal } : {}),
      }),
      requestContext: options.identity ?? identity, decode: result,
      async handler(raw): Promise<unknown> {
        const request = input(raw);
        const tx = bound.transaction();
        const updated = await tx.query(
          "UPDATE public.binding_reviews SET state='approved',version=version+1 WHERE id=$1 AND version=$2 RETURNING state,version",
          [request.id, request.expectedVersion]);
        if (!Array.isArray(updated) || updated.length !== 1) {
          throw new ApplicationError("Review changed", { status: 409, code: "REVIEW_CONFLICT" });
        }
        await options.afterWrite?.();
        expect(bound.transaction()).toBe(tx);
        const row: unknown = updated[0];
        return options.invalidResult ? { state: "invalid" } : row;
      },
    });
  }
  async function state(id: string) {
    return rows("SELECT state,version FROM public.binding_reviews WHERE id=$1", [id]);
  }
  async function count(table: "execution_receipts" | "execution_audit", key: string) {
    return rows(`SELECT count(*)::integer AS count FROM supacloud_commands.${table} WHERE operation_key=$1`, [key]);
  }

  test("concurrent retries and recreated bindings share one write, receipt and audit", async () => {
    const value = await fixture(), key = crypto.randomUUID(), bound = binding();
    const responses = await Promise.all(Array.from({ length: 6 }, () => run(bound, value, key)));
    expect(responses).toEqual(Array.from({ length: 6 }, () => ({ state: "approved", version: 2 })));
    expect(await run(binding(), value, key)).toEqual(responses[0]);
    expect(await state(value.id)).toEqual([{ state: "approved", version: 2 }]);
    expect(await count("execution_receipts", key)).toEqual([{ count: 1 }]);
    expect(await count("execution_audit", key)).toEqual([{ count: 1 }]);
    expect(() => bound.transaction()).toThrow("not active");
  });

  test("lookup returns no receipt without submitting a business write or audit", async () => {
    const value = await fixture(), key = crypto.randomUUID(), bound = binding({ auditFailure: true });
    expect(await bound.lookup(invocation(value, key))).toBeNull();
    expect(await state(value.id)).toEqual([{ state: "draft", version: 1 }]);
    expect(await count("execution_receipts", key)).toEqual([{ count: 0 }]);
    expect(await count("execution_audit", key)).toEqual([{ count: 0 }]);
    expect(() => bound.transaction()).toThrow("not active");
  });

  test("lookup from a recreated binding returns validated authority without auditing again", async () => {
    const value = await fixture(), key = crypto.randomUUID();
    await run(binding(), value, key);
    const bound = binding({ auditFailure: true });
    expect(await bound.lookup(invocation(value, key))).toMatchObject({
      ...identity, command: descriptor.name, operationId: key,
      status: "confirmed", audit: "complete", result: { state: "approved", version: 2 },
    });
    expect(await state(value.id)).toEqual([{ state: "approved", version: 2 }]);
    expect(await count("execution_receipts", key)).toEqual([{ count: 1 }]);
    expect(await count("execution_audit", key)).toEqual([{ count: 1 }]);
    expect(() => bound.transaction()).toThrow("not active");
  });

  test("lookup checks current ownership and rejects changed inputs instead of returning authority", async () => {
    const value = await fixture(), key = crypto.randomUUID(), bound = binding();
    await run(bound, value, key);
    await expect(bound.lookup(invocation({ ...value, expectedVersion: 2 }, key)))
      .rejects.toMatchObject({ status: 409, code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    for (const who of [{ ...identity, tenantId: "project-b" }, { ...identity, actorId: "actor-b" }]) {
      await expect(bound.lookup({ ...invocation(value, key), requestContext: who }))
        .rejects.toMatchObject({ status: 403, code: "COMMAND_REJECTED" });
    }
    await rows("UPDATE public.binding_reviews SET allowed=false WHERE id=$1", [value.id]);
    await expect(bound.lookup(invocation(value, key)))
      .rejects.toMatchObject({ status: 403, code: "COMMAND_REJECTED" });
    // A missing key does not bypass current business authorization either.
    await expect(bound.lookup(invocation(value, crypto.randomUUID())))
      .rejects.toMatchObject({ status: 403, code: "COMMAND_REJECTED" });
    expect(await count("execution_audit", key)).toEqual([{ count: 1 }]);
  });

  test("lookup never disguises a database failure as an absent receipt", async () => {
    const value = await fixture(), key = crypto.randomUUID();
    const bound = binding({ database: {
      async transaction() { throw new Error("private database connection detail"); },
    } });
    await expect(bound.lookup(invocation(value, key))).rejects.toMatchObject({
      status: 503, code: "COMMAND_UNAVAILABLE", message: "COMMAND_UNAVAILABLE",
    });
    const uncertain = binding({ database: {
      async transaction(run) {
        await database.transaction(run);
        throw new Error("private connection lost after transaction");
      },
    } });
    await expect(uncertain.lookup(invocation(value, key))).rejects.toMatchObject({
      status: 503, code: "COMMAND_OUTCOME_UNKNOWN", message: "COMMAND_OUTCOME_UNKNOWN",
    });
    expect(await count("execution_receipts", key)).toEqual([{ count: 0 }]);
  });

  test("lookup validates command binding, original key and input before opening a transaction", async () => {
    let transactions = 0;
    const bound = binding({ database: {
      async transaction() { transactions++; throw new Error("Should not connect"); },
    } });
    const value = { id: "not-persisted", expectedVersion: 1 }, key = crypto.randomUUID();
    for (const change of [{ name: "other" }, { permission: "other" }, { audit: "other" },
      { transaction: "none" }, { idempotency: "none" }, { rpc: "other" }]) {
      await expect(bound.lookup({ ...invocation(value, key), command: { ...descriptor, ...change } }))
        .rejects.toMatchObject({ code: "COMMAND_BINDING_MISMATCH" });
    }
    await expect(bound.lookup({
      ...invocation(value, key), request: new Request("https://test.invalid/lookup"),
    })).rejects.toMatchObject({ status: 400 });
    await expect(bound.lookup(invocation({ ...value, expectedVersion: "1" }, key)))
      .rejects.toMatchObject({ status: 400, code: "COMMAND_INPUT_INVALID" });
    expect(transactions).toBe(0);
  });

  test("revoked access and other tenants/actors cannot replay a receipt", async () => {
    const value = await fixture(), key = crypto.randomUUID(), bound = binding();
    await run(bound, value, key);
    for (const who of [{ ...identity, tenantId: "project-b" }, { ...identity, actorId: "actor-b" }]) {
      await expect(run(bound, value, key, { identity: who })).rejects.toMatchObject({ status: 403, code: "COMMAND_REJECTED" });
    }
    await rows("UPDATE public.binding_reviews SET allowed=false WHERE id=$1", [value.id]);
    await expect(run(bound, value, key)).rejects.toMatchObject({ status: 403, code: "COMMAND_REJECTED" });
    expect(await count("execution_audit", key)).toEqual([{ count: 1 }]);
  });

  test("invalid inputs fail before writes and invalid outputs roll back the transaction", async () => {
    const value = await fixture(), key = crypto.randomUUID(), bound = binding();
    for (const invalid of [{ ...value, expectedVersion: "1" }, { ...value, injected: true }]) {
      await expect(run(bound, invalid, key)).rejects.toMatchObject({ status: 400, code: "COMMAND_INPUT_INVALID" });
    }
    await expect(run(bound, value, key, { invalidResult: true }))
      .rejects.toMatchObject({ status: 503, code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await state(value.id)).toEqual([{ state: "draft", version: 1 }]);
    expect(await count("execution_receipts", key)).toEqual([{ count: 0 }]);
    expect(await count("execution_audit", key)).toEqual([{ count: 0 }]);
  });

  test("audit failure rolls back business state and receipt", async () => {
    const value = await fixture(), key = crypto.randomUUID();
    await expect(run(binding({ auditFailure: true }), value, key))
      .rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await state(value.id)).toEqual([{ state: "draft", version: 1 }]);
    expect(await count("execution_receipts", key)).toEqual([{ count: 0 }]);
  });

  test("input conflicts and explicit business rejection do not perform a second write", async () => {
    const value = await fixture(), key = crypto.randomUUID(), bound = binding();
    await run(bound, value, key);
    await expect(run(bound, { ...value, expectedVersion: 2 }, key))
      .rejects.toMatchObject({ status: 409, code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    await expect(run(bound, value)).rejects.toMatchObject({ status: 409, code: "COMMAND_IDEMPOTENCY_CONFLICT" });
    expect(await state(value.id)).toEqual([{ state: "approved", version: 2 }]);
  });

  test("concurrent different inputs keep transaction contexts isolated, including detached continuations", async () => {
    const first = await fixture(), second = await fixture(), bound = binding();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let detached: Promise<boolean> | undefined;
    const a = run(bound, first, crypto.randomUUID(), { afterWrite: async () => {
      const tx = bound.transaction();
      detached = release.promise.then(() => {
        expect(() => bound.transaction()).toThrow("not active");
        return true;
      });
      entered.resolve();
      await Bun.sleep(20);
      expect(bound.transaction()).toBe(tx);
    } });
    await entered.promise;
    try {
      await Promise.all([a, run(bound, second)]);
    } finally { release.resolve(); }
    expect(await detached).toBe(true);
  });

  test("unsupported command metadata never enters the business continuation", async () => {
    const value = await fixture(), bound = binding();
    for (const change of [{ name: "other" }, { permission: "other" }, { audit: "other" },
      { transaction: "none" }, { idempotency: "none" }]) {
      await expect(run(bound, value, crypto.randomUUID(), { command: { ...descriptor, ...change } }))
        .rejects.toMatchObject({ code: "COMMAND_BINDING_MISMATCH" });
    }
    await expect(run(bound, value, crypto.randomUUID(), { command: { ...descriptor, rpc: "other" } }))
      .rejects.toMatchObject({ code: "COMMAND_RPC_UNAVAILABLE" });
    expect(await state(value.id)).toEqual([{ state: "draft", version: 1 }]);
  });

  test("lost commit acknowledgement is recovered by lookup without resubmission", async () => {
    let lose = true;
    const bound = binding({ database: {
      async transaction(run) {
        const value = await database.transaction(run);
        if (lose) { lose = false; throw new Error("Lost acknowledgement"); }
        return value;
      },
    } });
    const value = await fixture(), key = crypto.randomUUID();
    await expect(run(bound, value, key)).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await bound.lookup(invocation(value, key))).toMatchObject({
      status: "confirmed", audit: "complete", result: { state: "approved", version: 2 },
    });
    expect(await state(value.id)).toEqual([{ state: "approved", version: 2 }]);
    expect(await count("execution_audit", key)).toEqual([{ count: 1 }]);
    expect(await run(bound, value, key)).toEqual({ state: "approved", version: 2 });
    expect(await count("execution_audit", key)).toEqual([{ count: 1 }]);
  });

  test("cancellation after the handler rolls back instead of confirming success", async () => {
    const value = await fixture(), key = crypto.randomUUID(), controller = new AbortController();
    await expect(run(binding(), value, key, {
      signal: controller.signal, afterWrite: async () => controller.abort(),
    })).rejects.toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
    expect(await state(value.id)).toEqual([{ state: "draft", version: 1 }]);
    expect(await count("execution_receipts", key)).toEqual([{ count: 0 }]);
  });

  test("generated PostgreSQL approval host reuses contracts and verified identity", async () => {
    const root = await mkdtemp(join(import.meta.dir, ".transactional-starter-"));
    try {
      const files = appStarterFiles("binding-acceptance");
      for (const [path, source] of Object.entries(files)) {
        if (!(path.startsWith("src/") || path === "db/schema.ts" || path === "generated/application.ts")) continue;
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), source);
      }
      const types = Bun.spawn([
        join(import.meta.dir, "../node_modules/.bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
        "--experimentalDecorators", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler",
        "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes", "--noPropertyAccessFromIndexSignature",
        "--ignoreConfig", join(root, "src/host/review-postgres.ts"),
      ], { stdout: "pipe", stderr: "pipe" });
      const [typeExit, typeOut, typeErr] = await Promise.all([
        types.exited, new Response(types.stdout).text(), new Response(types.stderr).text(),
      ]);
      if (typeExit !== 0) throw new Error(`Generated approval typecheck failed:\n${typeOut}${typeErr}`);
      const schema = files["migrations/001-review.sql"];
      if (!schema) throw new Error("Missing review migration");
      await database.exec(schema);
      await rows("INSERT INTO public.starter_application(project_id,tenant_id) VALUES($1,$1)", [identity.tenantId]);
      await rows("INSERT INTO public.starter_members(subject,can_approve) VALUES($1,true)", [identity.actorId]);
      const id = crypto.randomUUID();
      await rows("INSERT INTO public.starter_reviews(id,owner_id,state,version) VALUES($1,$2,'draft',1)", [id, identity.actorId]);
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const jwk = await exportJWK(publicKey);
      const host: {
        createReviewPostgresAdapters(options: {
          database: CommandDatabase; tenantId: string; identity: Omit<SupAuthContextOptions, "resolveAccess">;
        }): Promise<{
          requestContext(request: Request): Promise<SupAuthRequestContext>;
          commandGovernance: CommandGovernance;
          deps: { dbClient: { get(table: string, id: string): unknown; set(table: string, id: string, value: unknown): Promise<void> } };
        }>;
      } = await import(join(root, "src/host/review-postgres.ts"));
      const adapters = await host.createReviewPostgresAdapters({
        database, tenantId: identity.tenantId,
        identity: {
          issuer: "https://identity.example.test", audience: "review-test", clientId: "review-test",
          projectId: identity.tenantId, jwksUrl: "https://identity.example.test/keys",
          keyResolver: createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }),
        },
      });
      const token = await new SignJWT({ client_id: "review-test", role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "test" }).setIssuer("https://identity.example.test")
        .setAudience("review-test").setSubject(identity.actorId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      const request = new Request("https://app.example.test/reviews/approve", {
        headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      });
      const requestContext = await adapters.requestContext(request);
      const invocation: CommandInvocation = {
        command: descriptor, request, requestContext, services: {},
        input: { params: { id }, body: { expectedVersion: 1 }, query: {} },
      };
      const execute = createCommandExecutor(adapters.commandGovernance);
      const business: {
        ApproveReview: new (store: typeof adapters.deps.dbClient) => {
          execute(id: string, expectedVersion: number): Promise<unknown>;
        };
      } = await import(join(root, "src/review/review.ts"));
      const approve = new business.ApproveReview(adapters.deps.dbClient);
      let writes = 0;
      const handler = async () => {
        writes++;
        return approve.execute(id, 1);
      };
      expect(await execute(invocation, handler)).toEqual({ state: "approved", version: 2 });
      expect(await execute(invocation, handler)).toEqual({ state: "approved", version: 2 });
      expect(writes).toBe(1);
      await rows("UPDATE public.starter_members SET can_approve=false WHERE subject=$1", [identity.actorId]);
      await expect(execute(invocation, handler)).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
      // Even a still-verified context cannot bypass fresh database authorization.
      await expect(adapters.deps.dbClient.get("reviews", id)).rejects.toThrow("not active");
      await expect(adapters.deps.dbClient.set("reviews", id, { state: "approved", version: 3 }))
        .rejects.toThrow("not active");
      await expect(execute({ ...invocation, input: {
        ...invocation.input, body: { expectedVersion: "1" },
      } }, handler)).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

test("a transaction cannot be used without its invocation, and empty permissions fail setup", () => {
  const store = createPostgresCommandStore({
    async transaction() { throw new Error("Should not connect"); },
  });
  const definition = {
    store, name: "review.approve", input, result, inputCodec: plaintextCommandInput,
    authorize: () => "allow" as const, audit: { event: "review.approved", details: () => ({}) },
  };
  const options = {
    definition, permission: "review.approve",
    identity: () => identity, input: (invocation: CommandInvocation) => invocation.input.body,
  };
  expect(() => createTransactionalCommandGovernance(options).transaction()).toThrow("not active");
  expect(() => createTransactionalCommandGovernance({ ...options, permission: " " })).toThrow("permission");
});
