/**
 * An editable vertical feature slice. Persistence remains application-owned,
 * while every generated port receives the trusted framework request context.
 */
export function featureScaffold(
    name: string,
    className: string,
    governance: { permission: string; rpc: string },
): Record<string, string> {
    const commandName = `${name}.approve`;
    const { permission, rpc } = governance;
    return {
        [`${name}.contracts.ts`]: `import { t } from "elysia";

export const ${className}Params = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
});
export const ${className}ListQuery = t.Object({
    state: t.Optional(t.Union([t.Literal("draft"), t.Literal("approved")])),
});
export const ${className}ApproveBody = t.Object({
    expectedVersion: t.Integer({ minimum: 1 }),
    reason: t.Optional(t.String({ maxLength: 2000 })),
});
export const ${className}Row = t.Object({
    id: t.String(),
    state: t.String(),
    version: t.Integer({ minimum: 1 }),
});
export const ${className}ListResponse = t.Array(${className}Row);
export const ${className}RefreshInput = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    version: t.Integer({ minimum: 1 }),
});
`,
        [`${name}.model.ts`]: `import {
    InjectionToken, type FeatureRequestContext,
} from "@supacloud/app/core";
import type {
    ${className}ApproveBody,
    ${className}ListQuery,
    ${className}Row,
    ${className}RefreshInput,
} from "./${name}.contracts";
import type { StaticDecode } from "typebox";

export type ${className}ListInput = StaticDecode<typeof ${className}ListQuery>;
export type ${className}ApproveInput = StaticDecode<typeof ${className}ApproveBody>;
export type ${className}ApproveCommand = ${className}ApproveInput & { id: string };
export type ${className}Result = StaticDecode<typeof ${className}Row>;
export type ${className}RefreshJobInput = StaticDecode<typeof ${className}RefreshInput>;

export interface ${className}ReadPort {
    list(context: FeatureRequestContext, input: ${className}ListInput): Promise<${className}Result[]>;
    detail(context: FeatureRequestContext, id: string): Promise<${className}Result>;
}

export interface ${className}WritePort {
    approve(context: FeatureRequestContext, input: ${className}ApproveCommand): Promise<${className}Result>;
}

export const ${className}Reader = new InjectionToken<${className}ReadPort>(
    "${name}.reader", { scope: "request" },
);
export const ${className}Writer = new InjectionToken<${className}WritePort>(
    "${name}.writer", { scope: "request" },
);
`,
        [`${name}.service.ts`]: `import {
    Inject, Injectable, Optional, REQUEST_CONTEXT, requireFeatureRequestContext,
    type FeatureRequestContext,
} from "@supacloud/app/core";
import {
    ${className}Reader,
    ${className}Writer,
    type ${className}ApproveInput,
    type ${className}ReadPort,
    type ${className}Result,
    type ${className}WritePort,
} from "./${name}.model";

@Injectable({ scope: "request" })
export class ${className}Service {
    constructor(
        @Inject(REQUEST_CONTEXT) private readonly requestContext: unknown,
        @Inject(${className}Reader) @Optional() private readonly reader?: ${className}ReadPort,
        @Inject(${className}Writer) @Optional() private readonly writer?: ${className}WritePort,
    ) {}

    private context(): FeatureRequestContext {
        return requireFeatureRequestContext(this.requestContext);
    }

    async list(input: Parameters<${className}ReadPort["list"]>[1]): Promise<${className}Result[]> {
        if (!this.reader) throw new Error("Bind ${className}Reader with verified identity and tenant scope");
        return this.reader.list(this.context(), input);
    }

    async detail(id: string): Promise<${className}Result> {
        if (!this.reader) throw new Error("Bind ${className}Reader with verified identity and tenant scope");
        return this.reader.detail(this.context(), id);
    }

    async approve(id: string, input: ${className}ApproveInput): Promise<${className}Result> {
        if (!this.writer) throw new Error("Bind ${className}Writer with durable command governance");
        return this.writer.approve(this.context(), { ...input, id });
    }
}
`,
        [`${name}.feature.ts`]: `import { Effect } from "effect";
import {
    Body, Command, Controller, defineFeatureSlice, defineFeatureSpec, Get, Inject, JOB_CONTEXT,
    Injectable, Job, Param, Post, Query, requireFeatureRequestContext, type FeatureRequestContext,
    type FeatureState,
} from "@supacloud/app/core";
import {
    ${className}ApproveBody,
    ${className}ListQuery,
    ${className}ListResponse,
    ${className}Params,
    ${className}RefreshInput,
    ${className}Row,
} from "./${name}.contracts";
import { ${className}Service } from "./${name}.service";
import type {
    ${className}ApproveInput,
    ${className}ListInput,
    ${className}RefreshJobInput,
    ${className}Result,
} from "./${name}.model";

export const featureSpec = defineFeatureSpec({
    name: ${JSON.stringify(name)},
    states: ["draft", "approved"],
    tenantField: "tenant_id",
    transitions: {
        approve: {
            from: "draft", to: "approved", command: "Approve${className}Command",
            permission: ${JSON.stringify(permission)}, transaction: "required",
            idempotency: "required", audit: ${JSON.stringify(`${name}.approved`)},
            job: ${JSON.stringify(`${name}.refresh`)},
            persistence: {
                boundary: "database", optimisticLock: "required", versionField: "version", tenantField: "tenant_id", stateField: "state",
                receipt: "required", reconciliation: "none",
            },
            route: "POST /${name}/:id/approve",
        },
    },
});
export type ${className}State = FeatureState<typeof featureSpec>;

@Injectable({ scope: "request" })
@Query({ name: "${name}.list", tenantScope: "required" })
export class List${className}Query {
    constructor(@Inject(${className}Service) private readonly service: ${className}Service) {}
    execute(input: ${className}ListInput): Promise<${className}Result[]> {
        return this.service.list(input);
    }
}

@Injectable({ scope: "request" })
@Command({
    name: ${JSON.stringify(commandName)},
    permission: ${JSON.stringify(permission)},
    transaction: "required",
    audit: ${JSON.stringify(`${name}.approved`)},
    idempotency: "required",
    tenantScope: "required",
    rpc: ${JSON.stringify(rpc)},
})
export class Approve${className}Command {
    constructor(@Inject(${className}Service) private readonly service: ${className}Service) {}
    execute(id: string, input: ${className}ApproveInput): Promise<${className}Result> {
        return this.service.approve(id, input);
    }
}

@Job({
    name: ${JSON.stringify(`${name}.refresh`)},
    input: ${className}RefreshInput,
    mode: "task",
    idempotency: "required",
    tenantScope: "required",
})
export class Refresh${className}Job {
    constructor(@Inject(JOB_CONTEXT) private readonly jobContext: unknown) {}

    async run(_input: ${className}RefreshJobInput): Promise<void> {
        const context: FeatureRequestContext = requireFeatureRequestContext(this.jobContext);
        void context;
        throw new Error("Bind the existing Workflow/Queue adapter before dispatching ${name}.refresh");
    }
}

@Controller("/${name}")
export class ${className}Controller {
    constructor(
        @Inject(List${className}Query) private readonly listQuery: List${className}Query,
        @Inject(Approve${className}Command) private readonly approveCommand: Approve${className}Command,
        @Inject(${className}Service) private readonly service: ${className}Service,
    ) {}

    @Get("/", {
        query: ${className}ListQuery,
        responses: { 200: ${className}ListResponse },
        effect: { required: true, dependencies: [], errors: [], retry: "none" },
    })
    list(@Query("state") state?: ${className}State): Effect.Effect<${className}Result[], never, never> {
        return Effect.promise(() => this.listQuery.execute(state === undefined ? {} : { state }));
    }

    @Get("/:id", {
        params: ${className}Params,
        responses: { 200: ${className}Row },
        effect: { required: true, dependencies: [], errors: [], retry: "none" },
    })
    detail(@Param("id") id: string): Effect.Effect<${className}Result, never, never> {
        return Effect.promise(() => this.service.detail(id));
    }

    @Post("/:id/approve", {
        params: ${className}Params,
        body: ${className}ApproveBody,
        responses: { 200: ${className}Row },
        command: Approve${className}Command,
        effect: { required: true, dependencies: [], errors: [], retry: "none" },
    })
    approve(
        @Param("id") id: string,
        @Body() body: ${className}ApproveInput,
    ): Effect.Effect<${className}Result, never, never> {
        return Effect.promise(() => this.approveCommand.execute(id, body));
    }
}

export const ${className}Feature = defineFeatureSlice({
    name: ${JSON.stringify(name)},
    tags: ["type:feature"],
    spec: featureSpec,
    providers: [${className}Service, List${className}Query, Approve${className}Command],
    controllers: [${className}Controller],
    jobs: [Refresh${className}Job],
});
`,
        [`${name}.feature.test.ts`]: `import { expect, test } from "bun:test";
import { Refresh${className}Job } from "./${name}.feature";
import { ${className}Service } from "./${name}.service";
import { ${className}Fixture, ${className}RequestContext, ${className}RequestEnvelope } from "./${name}.fixture";

test("${name} rejects missing trusted tenant context before adapter execution", async () => {
    let calls = 0;
    const service = new ${className}Service(undefined, {
        list: async () => { calls++; return []; },
        detail: async () => { calls++; return { id: "example", state: "draft", version: 1 }; },
    });
    await expect(service.list({})).rejects.toThrow("FEATURE_CONTEXT_REQUIRED");
    expect(calls).toBe(0);
});

test("${name} rejects missing trusted job context before dispatch", async () => {
    const job = new Refresh${className}Job({});
    await expect(job.run({ id: "example", version: 1 })).rejects.toThrow("FEATURE_CONTEXT_REQUIRED");
});

test("${name} fails closed until verified read and durable write ports are bound", async () => {
    const service = new ${className}Service(${className}RequestEnvelope);
    await expect(service.list({})).rejects.toThrow("Bind ${className}Reader");
    await expect(service.detail("example")).rejects.toThrow("Bind ${className}Reader");
    await expect(service.approve("example", { expectedVersion: 1 })).rejects.toThrow("Bind ${className}Writer");
});

test("${name} preserves denied reads and rejected writes without fallback or retry", async () => {
    const denied = new Error("denied");
    let attempts = 0;
    const service = new ${className}Service(${className}RequestEnvelope, {
        list: async () => { throw denied; },
        detail: async () => { throw denied; },
    }, {
        approve: async () => { attempts++; throw denied; },
    });
    await expect(service.list({})).rejects.toBe(denied);
    await expect(service.detail("example")).rejects.toBe(denied);
    await expect(service.approve("example", { expectedVersion: 1 })).rejects.toBe(denied);
    expect(attempts).toBe(1);
});

test("${name} forwards the authoritative version and result without inventing persistence", async () => {
    const row = { id: ${className}Fixture.id, state: "approved", version: 2 };
    const service = new ${className}Service(${className}RequestEnvelope, undefined, {
        async approve(requestContext, input) {
            expect(requestContext).toMatchObject(${className}RequestContext);
            expect(input).toEqual({ id: ${className}Fixture.id, ...${className}Fixture.approve });
            return row;
        },
    });
    expect(await service.approve(${className}Fixture.id, ${className}Fixture.approve)).toBe(row);
});
`,
        [`${name}.fixture.ts`]: `import type { ${className}ApproveInput, ${className}Result } from "./${name}.model";

/**
 * Test data only. Production adapters must load authoritative rows and
 * identity from the database/authentication boundary.
 */
export const ${className}Fixture = {
    id: "example",
    approve: { expectedVersion: 1, reason: "reviewed" } satisfies ${className}ApproveInput,
    row: { id: "example", state: "draft", version: 1 } satisfies ${className}Result,
} as const;

export const ${className}RequestContext = {
    requestId: "request-example",
    tenantId: "tenant-example",
    actorId: "reviewer-example",
    permissions: [${JSON.stringify(permission)}],
} as const;

export const ${className}RequestEnvelope = {
    ...${className}RequestContext,
    identity: { authenticated: true, subject: "reviewer-example" },
    access: { tenantId: "tenant-example", permissions: [${JSON.stringify(permission)}] },
} as const satisfies Record<string, unknown>;
`,
        [`${name}.e2e.test.ts`]: `import { expect, test } from "bun:test";
import { ${className}Fixture } from "./${name}.fixture";

const baseUrl = process.env.SUPACLOUD_FEATURE_E2E_URL;
const authorization = process.env.SUPACLOUD_FEATURE_E2E_AUTHORIZATION;
const otherAuthorization = process.env.SUPACLOUD_FEATURE_E2E_OTHER_AUTHORIZATION;
const fixtureId = process.env.SUPACLOUD_FEATURE_E2E_ID ?? ${className}Fixture.id;
const idempotencyKey = process.env.SUPACLOUD_FEATURE_E2E_IDEMPOTENCY_KEY;
const enabled = Boolean(baseUrl && authorization && idempotencyKey);
const tenantIsolationEnabled = Boolean(enabled && otherAuthorization);

function requireConfig(): { baseUrl: string; authorization: string; idempotencyKey: string } {
    if (!baseUrl || !authorization || !idempotencyKey) {
        throw new Error(
            "Set SUPACLOUD_FEATURE_E2E_URL, SUPACLOUD_FEATURE_E2E_AUTHORIZATION and " +
            "SUPACLOUD_FEATURE_E2E_IDEMPOTENCY_KEY before running this generated E2E test.",
        );
    }
    return { baseUrl, authorization, idempotencyKey };
}

async function json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

function containsFixture(value: unknown): boolean {
    return JSON.stringify(value).includes(fixtureId);
}

test.skipIf(!enabled)("${name} authenticated list/detail/approval E2E", async () => {
    const config = requireConfig();
    const headers = { authorization: config.authorization, "content-type": "application/json" };
    const list = await fetch(new URL("/${name}", config.baseUrl), { headers });
    expect(list.ok).toBe(true);
    const detail = await fetch(
        new URL("/${name}/" + encodeURIComponent(fixtureId), config.baseUrl),
        { headers },
    );
    expect(detail.ok).toBe(true);
    const approve = (key: string, body = ${className}Fixture.approve) => fetch(
        new URL("/${name}/" + encodeURIComponent(fixtureId) + "/approve", config.baseUrl),
        {
            method: "POST",
            headers: { ...headers, "idempotency-key": key },
            body: JSON.stringify(body),
        },
    );
    const first = await approve(config.idempotencyKey);
    const firstBody = await json(first);
    expect([200, 409, 422]).toContain(first.status);

    // Replaying an identical command may return the original success or a
    // domain conflict, but it must never create a second successful transition.
    const replay = await approve(config.idempotencyKey);
    const replayBody = await json(replay);
    expect(replay.status).toBe(first.status);
    expect(replayBody).toEqual(firstBody);

    // Reusing a key with a different payload must be rejected by the receipt
    // boundary instead of being treated as a new approval.
    const conflicting = await approve(
        config.idempotencyKey,
        { ...${className}Fixture.approve, reason: "conflicting replay" },
    );
    expect([400, 409, 422]).toContain(conflicting.status);

    // Two distinct keys racing on one version may commit at most one state
    // transition. A fixture that is already terminal may reject both.
    const [raceA, raceB] = await Promise.all([
        approve(config.idempotencyKey + "-race-a"),
        approve(config.idempotencyKey + "-race-b"),
    ]);
    expect([raceA.status, raceB.status].filter((status) => status >= 200 && status < 300).length)
        .toBeLessThanOrEqual(1);
});

test.skipIf(!tenantIsolationEnabled)("${name} rejects cross-tenant access", async () => {
    const config = requireConfig();
    if (!otherAuthorization) throw new Error("Missing SUPACLOUD_FEATURE_E2E_OTHER_AUTHORIZATION");
    const headers = {
        authorization: otherAuthorization,
        "content-type": "application/json",
    };
    const list = await fetch(new URL("/${name}", config.baseUrl), { headers });
    expect(list.ok).toBe(true);
    expect(containsFixture(await json(list))).toBe(false);

    const detail = await fetch(
        new URL("/${name}/" + encodeURIComponent(fixtureId), config.baseUrl),
        { headers },
    );
    expect([403, 404]).toContain(detail.status);

    const approval = await fetch(
        new URL("/${name}/" + encodeURIComponent(fixtureId) + "/approve", config.baseUrl),
        {
            method: "POST",
            headers: { ...headers, "idempotency-key": config.idempotencyKey + "-other-tenant" },
            body: JSON.stringify(${className}Fixture.approve),
        },
    );
    expect([403, 404]).toContain(approval.status);
});
`,
        [`${name}.deployment.md`]: `# ${className} feature delivery checklist

- [ ] Bind ${className}Reader to a tenant-scoped, authenticated database read path.
- [ ] Bind ${className}Writer to a transactional RPC or persistent Command adapter.
- [ ] Register the \`${rpc}\` compiler and runtime RPC capability.
- [ ] Verify RLS, permission denial, stale version, identical replay and conflicting replay.
- [ ] Verify the refresh job uses the existing Workflow/Queue delivery path.
- [ ] Run the generated client contract and authenticated E2E test.
- [ ] Run \`supacloud app check --format json\`, package tests and the selected deployment receipt.

The scaffold does not create migrations, infer permissions, or provide an in-memory
production fallback. Database migrations remain the database source of truth.
Every adapter receives a trusted framework context whose tenant and actor values
come from verified identity/access data. Do not add tenant, actor, or permission
fields to the request body as a substitute for this context.
The HTTP schemas describe the boundary, not a second database model. Bind their
fields to the existing database-source contract checker before delivery.
The Writer input is derived from the approval body contract plus the route ID.
Add request fields in the contract, not a second handwritten Writer interface.
Typecheck application adapters after changing a field type; the derived Port
must expose incompatible assumptions in business code.

For authenticated tenant-isolation acceptance, also provide
\`SUPACLOUD_FEATURE_E2E_OTHER_AUTHORIZATION\` for a principal from another tenant.
The generated E2E then verifies that the fixture is absent from list results and that
cross-tenant detail and approval are rejected.

The named RPC adapter must invoke the continuation in the same database transaction
used by the request-scoped Writer, or own the complete command instead; never execute
both paths. Lock/check the version and state, reauthorize replays, and commit the
business write, receipt, audit and outbox together. Do not put a network side effect
inside this transaction. The refresh Job is an explicit unimplemented integration
point, not an automatically scheduled workflow.

Compile the routes with the existing client generator and use @supacloud/query for
identity-scoped caching/invalidation. There is deliberately no second hand-maintained
HTTP client. A committed approval followed by a failed refresh is still committed;
recover its receipt instead of resending. Use the host's standard error translation
and requestId propagation; the scaffold does not claim to implement those adapters.

## Required acceptance (not executed by generation)

\`\`\`gherkin
Scenario: Authorization and tenant isolation
  Given two tenants and a revoked reviewer
  When list, detail, approval or receipt replay is requested
  Then unauthorized records and prior success receipts are not disclosed

Scenario: Atomic approval
  Given a draft and its authoritative version
  When an authorized reviewer approves and repeats the same request
  Then one transition, audit event and asynchronous intent commit
  And changed input or a stale version is rejected

Scenario: Unknown outcome
  Given a committed approval whose response was lost
  When the client recovers the original receipt
  Then it does not create a new approval or automatic compensation

Scenario: Delivery
  Given verified migrations, RLS and generated client contracts
  When the selected environment is deployed
  Then its receipt and authenticated list/detail/approval flow are read back
\`\`\`
`,
    };
}
