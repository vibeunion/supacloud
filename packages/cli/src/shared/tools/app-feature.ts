/**
 * An editable vertical feature slice. The generated ports are deliberately
 * fail-closed: database access, authorization and durable command adapters
 * remain application-owned and cannot be fabricated by the scaffold.
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
    state: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
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
`,
        [`${name}.model.ts`]: `import { InjectionToken } from "@supacloud/app/core";
import type {
    ${className}ApproveBody,
    ${className}ListQuery,
    ${className}Row,
} from "./${name}.contracts";
import type { StaticDecode } from "typebox";

export type ${className}ListInput = StaticDecode<typeof ${className}ListQuery>;
export type ${className}ApproveInput = StaticDecode<typeof ${className}ApproveBody>;
export type ${className}ApproveCommand = ${className}ApproveInput & { id: string };
export type ${className}Result = StaticDecode<typeof ${className}Row>;

export interface ${className}ReadPort {
    list(input: ${className}ListInput): Promise<${className}Result[]>;
    detail(id: string): Promise<${className}Result>;
}

export interface ${className}WritePort {
    approve(input: ${className}ApproveCommand): Promise<${className}Result>;
}

export const ${className}Reader = new InjectionToken<${className}ReadPort>(
    "${name}.reader", { scope: "request" },
);
export const ${className}Writer = new InjectionToken<${className}WritePort>(
    "${name}.writer", { scope: "request" },
);
`,
        [`${name}.service.ts`]: `import { Inject, Injectable, Optional } from "@supacloud/app/core";
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
        @Inject(${className}Reader) @Optional() private readonly reader?: ${className}ReadPort,
        @Inject(${className}Writer) @Optional() private readonly writer?: ${className}WritePort,
    ) {}

    async list(input: Parameters<${className}ReadPort["list"]>[0]): Promise<${className}Result[]> {
        if (!this.reader) throw new Error("Bind ${className}Reader with verified identity and tenant scope");
        return this.reader.list(input);
    }

    async detail(id: string): Promise<${className}Result> {
        if (!this.reader) throw new Error("Bind ${className}Reader with verified identity and tenant scope");
        return this.reader.detail(id);
    }

    async approve(id: string, input: ${className}ApproveInput): Promise<${className}Result> {
        if (!this.writer) throw new Error("Bind ${className}Writer with durable command governance");
        return this.writer.approve({ ...input, id });
    }
}
`,
        [`${name}.feature.ts`]: `import { Effect } from "effect";
import {
    Body, Command, Controller, defineFeatureSlice, defineFeatureSpec, Get, Inject,
    Injectable, Job, Param, Post, Query, type FeatureState,
} from "@supacloud/app/core";
import {
    ${className}ApproveBody,
    ${className}ListQuery,
    ${className}ListResponse,
    ${className}Params,
    ${className}Row,
} from "./${name}.contracts";
import { ${className}Service } from "./${name}.service";
import type { ${className}ApproveInput, ${className}ListInput, ${className}Result } from "./${name}.model";

export const featureSpec = defineFeatureSpec({
    name: ${JSON.stringify(name)},
    states: ["draft", "approved"],
    transitions: {
        approve: {
            from: "draft", to: "approved", command: "Approve${className}Command",
            permission: ${JSON.stringify(permission)}, transaction: "required",
            idempotency: "required", audit: ${JSON.stringify(`${name}.approved`)},
            route: "POST /${name}/:id/approve",
        },
    },
});
export type ${className}State = FeatureState<typeof featureSpec>;

@Injectable({ scope: "request" })
@Query({ name: "${name}.list" })
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
    mode: "task",
    idempotency: "required",
})
export class Refresh${className}Job {
    run(_input: { id: string; version: number }): Promise<void> {
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
    list(@Query("state") state?: string): Effect.Effect<${className}Result[], never, never> {
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
import { ${className}Service } from "./${name}.service";

test("${name} fails closed until verified read and durable write ports are bound", async () => {
    const service = new ${className}Service();
    await expect(service.list({})).rejects.toThrow("Bind ${className}Reader");
    await expect(service.detail("example")).rejects.toThrow("Bind ${className}Reader");
    await expect(service.approve("example", { expectedVersion: 1 })).rejects.toThrow("Bind ${className}Writer");
});

test("${name} preserves denied reads and rejected writes without fallback or retry", async () => {
    const denied = new Error("denied");
    let attempts = 0;
    const service = new ${className}Service({
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
    const row = { id: "example", state: "approved", version: 2 };
    const service = new ${className}Service(undefined, {
        async approve(input) {
            expect(input).toEqual({ id: "example", expectedVersion: 1, reason: "reviewed" });
            return row;
        },
    });
    expect(await service.approve("example", { expectedVersion: 1, reason: "reviewed" })).toBe(row);
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
The HTTP schemas describe the boundary, not a second database model. Bind their
fields to the existing database-source contract checker before delivery.
The Writer input is derived from the approval body contract plus the route ID.
Add request fields in the contract, not a second handwritten Writer interface.
Typecheck application adapters after changing a field type; the derived Port
must expose incompatible assumptions in business code.

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
