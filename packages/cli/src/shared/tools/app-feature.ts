/**
 * An editable vertical feature slice. Persistence remains application-owned,
 * while every generated port receives the trusted framework request context.
 */
export function featureScaffold(
    name: string,
    className: string,
    governance: {
        permission: string;
        readPermission: string;
        rpc: string;
        database: { source: string; table: string; rowType: string };
        databaseImportPath?: string;
    },
): Record<string, string> {
    const commandName = `${name}.approve`;
    const { permission, readPermission, rpc, database } = governance;
    const databaseImportPath = governance.databaseImportPath
        ?? `../../../${database.source.replace(/\.(?:[cm]?tsx?|mts|cts)$/, "")}`;
    const rowTypeRoot = database.rowType.split(".")[0]!;
    return {
        [`${name}.contracts.ts`]: `import { t } from "elysia";
import type { ${rowTypeRoot} } from "${databaseImportPath}";

export const ${className}Params = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
});
export const ${className}ReceiptParams = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    operationId: t.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9._:-]+$" }),
});
export const ${className}ListQuery = t.Object({
    state: t.Optional(t.Union([t.Literal("draft"), t.Literal("approved")])),
});
export const ${className}ApproveBody = t.Object({
    expectedVersion: t.Integer({ minimum: 1 }),
    reason: t.Optional(t.String({ maxLength: 2000 })),
});
/** Transport projection; the business result type is derived from the database source below. */
export const ${className}Row = t.Object({
    id: t.String(),
    state: t.String(),
    version: t.Integer({ minimum: 1 }),
});
export type ${className}DatabaseRow = ${database.rowType};
export const ${className}Receipt = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    operationId: t.String({ minLength: 1, maxLength: 512 }),
    status: t.Union([
        t.Literal("pending"), t.Literal("confirmed"), t.Literal("failed"), t.Literal("unknown"),
    ]),
    state: t.String(),
    version: t.Integer({ minimum: 1 }),
});
export const ${className}JobStatus = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    operationId: t.String({ minLength: 1, maxLength: 512 }),
    status: t.Union([
        t.Literal("queued"), t.Literal("running"), t.Literal("completed"),
        t.Literal("failed"), t.Literal("cancelled"), t.Literal("unknown"),
    ]),
    errorCode: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
});
/** Query tags are explicit cache contracts; use them with @supacloud/query. */
export const ${className}QueryTags = {
    list: ${JSON.stringify(`${name}.list`)},
    detail: ${JSON.stringify(`${name}.detail`)},
    receipt: ${JSON.stringify(`${name}.receipt`)},
    jobStatus: ${JSON.stringify(`${name}.job-status`)},
} as const;
export const ${className}ApproveInvalidateTags = [
    ${className}QueryTags.list,
    ${className}QueryTags.detail,
    ${className}QueryTags.receipt,
    ${className}QueryTags.jobStatus,
] as const;
export const ${className}ListResponse = t.Array(${className}Row);
export const ${className}RefreshInput = t.Object({
    id: t.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    version: t.Integer({ minimum: 1 }),
    operationId: t.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9._:-]+$" }),
});
`,
        [`${name}.model.ts`]: `import {
    InjectionToken, type FeatureJobPort, type FeatureOperationPort, type FeatureRequestContext,
} from "@supacloud/app/core";
import type {
    ${className}ApproveBody,
    ${className}ListQuery,
    ${className}Receipt,
    ${className}ReceiptParams,
    ${className}JobStatus,
    ${className}DatabaseRow,
    ${className}Row,
    ${className}RefreshInput,
} from "./${name}.contracts";
import type { StaticDecode } from "typebox";

export type ${className}ListInput = StaticDecode<typeof ${className}ListQuery>;
export type ${className}ApproveInput = StaticDecode<typeof ${className}ApproveBody>;
export type ${className}ApproveCommand = ${className}ApproveInput & { id: string };
export type ${className}Result = ${className}DatabaseRow;
export type ${className}ReceiptResult = StaticDecode<typeof ${className}Receipt>;
export type ${className}RefreshJobInput = StaticDecode<typeof ${className}RefreshInput>;
export type ${className}JobStatusResult = StaticDecode<typeof ${className}JobStatus>;

export interface ${className}ReadPort {
    list(context: FeatureRequestContext, input: ${className}ListInput): Promise<${className}Result[]>;
    detail(context: FeatureRequestContext, id: string): Promise<${className}Result>;
}

export interface ${className}WritePort {
    approve(context: FeatureRequestContext, input: ${className}ApproveCommand): Promise<${className}Result>;
}

export interface ${className}ReceiptPort extends FeatureOperationPort<${className}ReceiptResult> {}

export interface ${className}JobStatusPort extends FeatureOperationPort<${className}JobStatusResult> {}

export interface ${className}RefreshPort extends FeatureJobPort<${className}RefreshJobInput> {}

export const ${className}Reader = new InjectionToken<${className}ReadPort>(
    "${name}.reader", { scope: "request" },
);
export const ${className}Writer = new InjectionToken<${className}WritePort>(
    "${name}.writer", { scope: "request" },
);
export const ${className}Receipts = new InjectionToken<${className}ReceiptPort>(
    "${name}.receipts", { scope: "request" },
);
export const ${className}JobStatuses = new InjectionToken<${className}JobStatusPort>(
    "${name}.job-statuses", { scope: "request" },
);
export const ${className}Refresher = new InjectionToken<${className}RefreshPort>(
    "${name}.refresher", { scope: "job" },
);
`,
        [`${name}.service.ts`]: `import {
    FeatureAdapterError, Inject, Injectable, Optional, REQUEST_CONTEXT, requireFeatureOperationResult,
    requireFeaturePermission,
    requireFeatureRequestContext, requireFeatureTransitionResult,
    type FeatureRequestContext,
} from "@supacloud/app/core";
import {
    ${className}Reader,
    ${className}JobStatuses,
    ${className}Receipts,
    ${className}Writer,
    type ${className}ApproveInput,
    type ${className}ReadPort,
    type ${className}Result,
    type ${className}ReceiptPort,
    type ${className}JobStatusPort,
    type ${className}JobStatusResult,
    type ${className}WritePort,
} from "./${name}.model";

@Injectable({ scope: "request" })
export class ${className}Service {
    constructor(
        @Inject(REQUEST_CONTEXT) private readonly requestContext: unknown,
        @Inject(${className}Reader) @Optional() private readonly reader?: ${className}ReadPort,
        @Inject(${className}Writer) @Optional() private readonly writer?: ${className}WritePort,
        @Inject(${className}Receipts) @Optional() private readonly receipts?: ${className}ReceiptPort,
        @Inject(${className}JobStatuses) @Optional() private readonly jobStatuses?: ${className}JobStatusPort,
    ) {}

    private context(): FeatureRequestContext {
        return requireFeatureRequestContext(this.requestContext);
    }

    async list(input: Parameters<${className}ReadPort["list"]>[1]): Promise<${className}Result[]> {
        const context = this.context();
        requireFeaturePermission(context, ${JSON.stringify(readPermission)});
        if (!this.reader) throw new FeatureAdapterError("${name}.reader");
        return this.reader.list(context, input);
    }

    async detail(id: string): Promise<${className}Result> {
        const context = this.context();
        requireFeaturePermission(context, ${JSON.stringify(readPermission)});
        if (!this.reader) throw new FeatureAdapterError("${name}.reader");
        return this.reader.detail(context, id);
    }

    async approve(id: string, input: ${className}ApproveInput): Promise<${className}Result> {
        if (!this.writer) throw new FeatureAdapterError("${name}.writer");
        return requireFeatureTransitionResult(
            id,
            "approved",
            input.expectedVersion,
            await this.writer.approve(this.context(), { ...input, id }),
        );
    }

    async receipt(id: string, operationId: string): Promise<Awaited<ReturnType<${className}ReceiptPort["lookup"]>>> {
        const context = this.context();
        requireFeaturePermission(context, ${JSON.stringify(readPermission)});
        if (!this.receipts) throw new FeatureAdapterError("${name}.receipts");
        const input = { id, operationId };
        // Keep the comparison identity separate from mutable adapter arguments.
        return requireFeatureOperationResult(input, await this.receipts.lookup(context, { ...input }));
    }

    async jobStatus(id: string, operationId: string): Promise<${className}JobStatusResult> {
        const context = this.context();
        requireFeaturePermission(context, ${JSON.stringify(readPermission)});
        if (!this.jobStatuses) throw new FeatureAdapterError("${name}.job-statuses");
        const input = { id, operationId };
        // Keep the comparison identity separate from mutable adapter arguments.
        return requireFeatureOperationResult(input, await this.jobStatuses.lookup(context, { ...input }));
    }
}
`,
        [`${name}.feature.ts`]: `import { Effect } from "effect";
import {
    Body, Command, Controller, defineFeatureSlice, defineFeatureSpec, FeatureAdapterError, Get, Inject, JOB_CONTEXT,
    Injectable, Job, Optional, Param, Post, Query, requireFeatureJobContext, type FeatureRequestContext,
    type FeatureState,
} from "@supacloud/app/core";
import {
    ${className}ApproveBody,
    ${className}ListQuery,
    ${className}Receipt,
    ${className}ReceiptParams,
    ${className}JobStatus,
    ${className}ListResponse,
    ${className}Params,
    ${className}RefreshInput,
    ${className}Row,
} from "./${name}.contracts";
import { ${className}Refresher } from "./${name}.model";
import { ${className}Service } from "./${name}.service";
import type {
    ${className}ApproveInput,
    ${className}ListInput,
    ${className}ReceiptResult,
    ${className}JobStatusResult,
    ${className}RefreshPort,
    ${className}RefreshJobInput,
    ${className}Result,
} from "./${name}.model";

export const featureSpec = defineFeatureSpec({
    name: ${JSON.stringify(name)},
    states: ["draft", "approved"],
    database: ${JSON.stringify(database)},
    tenantField: "tenant_id",
    readPermission: ${JSON.stringify(readPermission)},
    requiredAdapters: [
        "${className}Reader",
        "${className}Writer",
        "${className}Receipts",
        "${className}JobStatuses",
        "${className}Refresher",
    ],
    requiredAdapterScopes: {
        ${className}Reader: "request",
        ${className}Writer: "request",
        ${className}Receipts: "request",
        ${className}JobStatuses: "request",
        ${className}Refresher: "job",
    },
    transitions: {
        approve: {
            from: "draft", to: "approved", command: "Approve${className}Command",
            permission: ${JSON.stringify(permission)}, transaction: "required",
            idempotency: "required", audit: ${JSON.stringify(`${name}.approved`)},
            job: ${JSON.stringify(`${name}.refresh`)},
            invalidateTags: [
                ${JSON.stringify(`${name}.list`)},
                ${JSON.stringify(`${name}.detail`)},
                ${JSON.stringify(`${name}.receipt`)},
                ${JSON.stringify(`${name}.job-status`)},
            ],
            persistence: {
                boundary: "database", optimisticLock: "required", versionField: "version", tenantField: "tenant_id", stateField: "state",
                receipt: "required", reconciliation: "none",
            },
            route: "POST /${name}/:id/approve",
        },
    },
});
export type ${className}State = FeatureState<typeof featureSpec>;
type ${className}ListError =
    | { readonly _tag: "AUTHENTICATION_REQUIRED" }
    | { readonly _tag: "FEATURE_CONTEXT_REQUIRED" }
    | { readonly _tag: "PERMISSION_DENIED" }
    | { readonly _tag: "FEATURE_NOT_FOUND" }
    | { readonly _tag: "FEATURE_ADAPTER_UNAVAILABLE" };
type ${className}ApproveError =
    | { readonly _tag: "AUTHENTICATION_REQUIRED" }
    | { readonly _tag: "FEATURE_CONTEXT_REQUIRED" }
    | { readonly _tag: "PERMISSION_DENIED" }
    | { readonly _tag: "FEATURE_TRANSITION_CONFLICT" }
    | { readonly _tag: "FEATURE_ENTITY_RESULT_MISMATCH" }
    | { readonly _tag: "VERSION_CONFLICT" }
    | { readonly _tag: "COMMAND_IDEMPOTENCY_CONFLICT" }
    | { readonly _tag: "COMMAND_OUTCOME_UNKNOWN" }
    | { readonly _tag: "FEATURE_ADAPTER_UNAVAILABLE" };
type ${className}ReceiptError =
    | { readonly _tag: "AUTHENTICATION_REQUIRED" }
    | { readonly _tag: "FEATURE_CONTEXT_REQUIRED" }
    | { readonly _tag: "PERMISSION_DENIED" }
    | { readonly _tag: "FEATURE_NOT_FOUND" }
    | { readonly _tag: "COMMAND_RECEIPT_INVALID" }
    | { readonly _tag: "FEATURE_OPERATION_RESULT_MISMATCH" }
    | { readonly _tag: "COMMAND_OUTCOME_UNKNOWN" }
    | { readonly _tag: "FEATURE_ADAPTER_UNAVAILABLE" };
type ${className}JobStatusError =
    | { readonly _tag: "AUTHENTICATION_REQUIRED" }
    | { readonly _tag: "FEATURE_CONTEXT_REQUIRED" }
    | { readonly _tag: "PERMISSION_DENIED" }
    | { readonly _tag: "FEATURE_NOT_FOUND" }
    | { readonly _tag: "FEATURE_OPERATION_RESULT_MISMATCH" }
    | { readonly _tag: "COMMAND_OUTCOME_UNKNOWN" }
    | { readonly _tag: "FEATURE_ADAPTER_UNAVAILABLE" };

@Injectable({ scope: "request" })
@Query({ name: "${name}.list", permission: ${JSON.stringify(readPermission)}, tenantScope: "required" })
export class List${className}Query {
    constructor(@Inject(${className}Service) private readonly service: ${className}Service) {}
    execute(input: ${className}ListInput): Promise<${className}Result[]> {
        return this.service.list(input);
    }
}

@Injectable({ scope: "request" })
@Query({ name: "${name}.detail", permission: ${JSON.stringify(readPermission)}, tenantScope: "required" })
export class Detail${className}Query {
    constructor(@Inject(${className}Service) private readonly service: ${className}Service) {}
    execute(id: string): Promise<${className}Result> {
        return this.service.detail(id);
    }
}

@Injectable({ scope: "request" })
@Query({ name: "${name}.receipt", permission: ${JSON.stringify(readPermission)}, tenantScope: "required" })
export class Receipt${className}Query {
    constructor(@Inject(${className}Service) private readonly service: ${className}Service) {}
    execute(id: string, operationId: string): Promise<${className}ReceiptResult> {
        return this.service.receipt(id, operationId);
    }
}

@Injectable({ scope: "request" })
@Query({ name: "${name}.job-status", permission: ${JSON.stringify(readPermission)}, tenantScope: "required" })
export class JobStatus${className}Query {
    constructor(@Inject(${className}Service) private readonly service: ${className}Service) {}
    execute(id: string, operationId: string): Promise<${className}JobStatusResult> {
        return this.service.jobStatus(id, operationId);
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
    constructor(
        @Inject(JOB_CONTEXT) private readonly jobContext: unknown,
        @Inject(${className}Refresher) @Optional() private readonly refresher?: ${className}RefreshPort,
    ) {}

    async run(input: ${className}RefreshJobInput): Promise<void> {
        const context: FeatureRequestContext = requireFeatureJobContext(this.jobContext, input.operationId);
        if (!this.refresher) throw new FeatureAdapterError("${name}.refresher");
        await this.refresher.run(context, input);
    }
}

@Controller("/${name}")
export class ${className}Controller {
    constructor(
        @Inject(List${className}Query) private readonly listQuery: List${className}Query,
        @Inject(Detail${className}Query) private readonly detailQuery: Detail${className}Query,
        @Inject(Receipt${className}Query) private readonly receiptQuery: Receipt${className}Query,
        @Inject(JobStatus${className}Query) private readonly jobStatusQuery: JobStatus${className}Query,
        @Inject(Approve${className}Command) private readonly approveCommand: Approve${className}Command,
    ) {}

    @Get("/", {
        permission: ${JSON.stringify(readPermission)},
        query: ${className}ListQuery,
        tags: [${JSON.stringify(`${name}.list`)}],
        responses: { 200: ${className}ListResponse },
        effect: {
            required: true, dependencies: [], retry: "none",
            errors: [
                { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "FEATURE_CONTEXT_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "PERMISSION_DENIED", status: 403, code: "PERMISSION_DENIED" },
                { tag: "FEATURE_NOT_FOUND", status: 404, code: "FEATURE_NOT_FOUND" },
                { tag: "FEATURE_ADAPTER_UNAVAILABLE", status: 503, code: "FEATURE_ADAPTER_UNAVAILABLE" },
            ],
        },
    })
    list(@Query("state") state?: ${className}State): Effect.Effect<${className}Result[], ${className}ListError, never> {
        return Effect.promise(() => this.listQuery.execute(state === undefined ? {} : { state }));
    }

    @Get("/:id", {
        permission: ${JSON.stringify(readPermission)},
        params: ${className}Params,
        tags: [${JSON.stringify(`${name}.detail`)}],
        responses: { 200: ${className}Row },
        effect: {
            required: true, dependencies: [], retry: "none",
            errors: [
                { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "FEATURE_CONTEXT_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "PERMISSION_DENIED", status: 403, code: "PERMISSION_DENIED" },
                { tag: "FEATURE_NOT_FOUND", status: 404, code: "FEATURE_NOT_FOUND" },
                { tag: "FEATURE_ADAPTER_UNAVAILABLE", status: 503, code: "FEATURE_ADAPTER_UNAVAILABLE" },
            ],
        },
    })
    detail(@Param("id") id: string): Effect.Effect<${className}Result, ${className}ListError, never> {
        return Effect.promise(() => this.detailQuery.execute(id));
    }

    @Post("/:id/approve", {
        params: ${className}Params,
        body: ${className}ApproveBody,
        responses: { 200: ${className}Row },
        command: Approve${className}Command,
        idempotency: "required",
        effect: {
            required: true, dependencies: [], retry: "none",
            errors: [
                { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "FEATURE_CONTEXT_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "PERMISSION_DENIED", status: 403, code: "PERMISSION_DENIED" },
                { tag: "FEATURE_TRANSITION_CONFLICT", status: 409, code: "FEATURE_TRANSITION_CONFLICT" },
                { tag: "FEATURE_ENTITY_RESULT_MISMATCH", status: 503, code: "FEATURE_ENTITY_RESULT_MISMATCH" },
                { tag: "VERSION_CONFLICT", status: 409, code: "VERSION_CONFLICT" },
                { tag: "COMMAND_IDEMPOTENCY_CONFLICT", status: 409, code: "COMMAND_IDEMPOTENCY_CONFLICT" },
                { tag: "COMMAND_OUTCOME_UNKNOWN", status: 503, code: "COMMAND_OUTCOME_UNKNOWN" },
                { tag: "FEATURE_ADAPTER_UNAVAILABLE", status: 503, code: "FEATURE_ADAPTER_UNAVAILABLE" },
            ],
        },
    })
    approve(
        @Param("id") id: string,
        @Body() body: ${className}ApproveInput,
    ): Effect.Effect<${className}Result, ${className}ApproveError, never> {
        return Effect.promise(() => this.approveCommand.execute(id, body));
    }

    @Get("/:id/operations/:operationId", {
        permission: ${JSON.stringify(readPermission)},
        params: ${className}ReceiptParams,
        tags: [${JSON.stringify(`${name}.receipt`)}],
        responses: { 200: ${className}Receipt },
        effect: {
            required: true, dependencies: [], retry: "none",
            errors: [
                { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "FEATURE_CONTEXT_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "PERMISSION_DENIED", status: 403, code: "PERMISSION_DENIED" },
                { tag: "FEATURE_NOT_FOUND", status: 404, code: "FEATURE_NOT_FOUND" },
                { tag: "COMMAND_RECEIPT_INVALID", status: 503, code: "COMMAND_RECEIPT_INVALID" },
                { tag: "FEATURE_OPERATION_RESULT_MISMATCH", status: 503, code: "FEATURE_OPERATION_RESULT_MISMATCH" },
                { tag: "COMMAND_OUTCOME_UNKNOWN", status: 503, code: "COMMAND_OUTCOME_UNKNOWN" },
                { tag: "FEATURE_ADAPTER_UNAVAILABLE", status: 503, code: "FEATURE_ADAPTER_UNAVAILABLE" },
            ],
        },
    })
    receipt(
        @Param("id") id: string,
        @Param("operationId") operationId: string,
    ): Effect.Effect<${className}ReceiptResult, ${className}ReceiptError, never> {
        return Effect.promise(() => this.receiptQuery.execute(id, operationId));
    }

    @Get("/:id/operations/:operationId/status", {
        permission: ${JSON.stringify(readPermission)},
        params: ${className}ReceiptParams,
        tags: [${JSON.stringify(`${name}.job-status`)}],
        responses: { 200: ${className}JobStatus },
        effect: {
            required: true, dependencies: [], retry: "none",
            errors: [
                { tag: "AUTHENTICATION_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "FEATURE_CONTEXT_REQUIRED", status: 401, code: "AUTHENTICATION_REQUIRED" },
                { tag: "PERMISSION_DENIED", status: 403, code: "PERMISSION_DENIED" },
                { tag: "FEATURE_NOT_FOUND", status: 404, code: "FEATURE_NOT_FOUND" },
                { tag: "FEATURE_OPERATION_RESULT_MISMATCH", status: 503, code: "FEATURE_OPERATION_RESULT_MISMATCH" },
                { tag: "COMMAND_OUTCOME_UNKNOWN", status: 503, code: "COMMAND_OUTCOME_UNKNOWN" },
                { tag: "FEATURE_ADAPTER_UNAVAILABLE", status: 503, code: "FEATURE_ADAPTER_UNAVAILABLE" },
            ],
        },
    })
    jobStatus(
        @Param("id") id: string,
        @Param("operationId") operationId: string,
    ): Effect.Effect<${className}JobStatusResult, ${className}JobStatusError, never> {
        return Effect.promise(() => this.jobStatusQuery.execute(id, operationId));
    }
}

export const ${className}Feature = defineFeatureSlice({
    name: ${JSON.stringify(name)},
    tags: ["type:feature"],
    spec: featureSpec,
    providers: [
        ${className}Service,
        List${className}Query,
        Detail${className}Query,
        Receipt${className}Query,
        JobStatus${className}Query,
        Approve${className}Command,
    ],
    controllers: [${className}Controller],
    jobs: [Refresh${className}Job],
});
`,
        [`${name}.feature.test.ts`]: `import { expect, test } from "bun:test";
import { Refresh${className}Job } from "./${name}.feature";
import { ${className}Service } from "./${name}.service";
import {
    ${className}Fixture, ${className}JobRequestEnvelope, ${className}RequestContext, ${className}RequestEnvelope,
} from "./${name}.fixture";

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
    await expect(job.run({ id: "example", version: 1, operationId: "operation-example" }))
        .rejects.toThrow("FEATURE_CONTEXT_REQUIRED");
});

test("${name} rejects a job context correlated to a different operation", async () => {
    const job = new Refresh${className}Job({
        ...${className}RequestEnvelope,
        idempotencyKey: "foreign-operation",
    });
    await expect(job.run({ id: "example", version: 1, operationId: "operation-example" }))
        .rejects.toMatchObject({ _tag: "FEATURE_JOB_OPERATION_MISMATCH" });
});

test("${name} runs the refresh adapter with trusted tenant context", async () => {
    let received: unknown;
    const job = new Refresh${className}Job(${className}JobRequestEnvelope, {
        async run(context, input) {
            received = { context, input };
        },
    });
    await expect(job.run({ id: "example", version: 1, operationId: "operation-example" }))
        .resolves.toBeUndefined();
    expect(received).toEqual({
        context: { ...${className}RequestContext, idempotencyKey: "operation-example" },
        input: { id: "example", version: 1, operationId: "operation-example" },
    });
});

test("${name} fails closed until verified read and durable write ports are bound", async () => {
    const service = new ${className}Service(${className}RequestEnvelope);
    await expect(service.list({})).rejects.toThrow("FEATURE_ADAPTER_UNAVAILABLE");
    await expect(service.detail("example")).rejects.toThrow("FEATURE_ADAPTER_UNAVAILABLE");
    await expect(service.approve("example", { expectedVersion: 1 })).rejects.toThrow("FEATURE_ADAPTER_UNAVAILABLE");
    await expect(service.jobStatus("example", "operation-example")).rejects.toThrow("FEATURE_ADAPTER_UNAVAILABLE");
});

test("${name} preserves denied reads and rejected writes without fallback or retry", async () => {
    const denied = new Error("denied");
    let attempts = 0;
    const service = new ${className}Service(${className}RequestEnvelope, undefined, {
        approve: async () => { attempts++; throw denied; },
    });
    const readService = new ${className}Service(${className}RequestEnvelope, {
        list: async () => { throw denied; },
        detail: async () => { throw denied; },
    });
    await expect(readService.list({})).rejects.toBe(denied);
    await expect(readService.detail("example")).rejects.toBe(denied);
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

test("${name} rejects a writer result that does not prove the declared transition", async () => {
    const service = new ${className}Service(${className}RequestEnvelope, undefined, {
        approve: async () => ({ id: "example", state: "draft", version: 2 }),
    });
    await expect(service.approve("example", { expectedVersion: 1 }))
        .rejects.toMatchObject({ _tag: "FEATURE_TRANSITION_CONFLICT" });
    const stale = new ${className}Service(${className}RequestEnvelope, undefined, {
        approve: async () => ({ id: "example", state: "approved", version: 1 }),
    });
    await expect(stale.approve("example", { expectedVersion: 1 }))
        .rejects.toMatchObject({ _tag: "VERSION_CONFLICT" });
    const foreign = new ${className}Service(${className}RequestEnvelope, undefined, {
        approve: async () => ({ id: "foreign", state: "approved", version: 2 }),
    });
    await expect(foreign.approve("example", { expectedVersion: 1 }))
        .rejects.toMatchObject({ _tag: "FEATURE_ENTITY_RESULT_MISMATCH" });
});

test("${name} rejects operation lookup results for a different operation", async () => {
    const service = new ${className}Service(${className}RequestEnvelope, undefined, undefined, {
        lookup: async () => ({
            id: "example", operationId: "foreign-operation", status: "confirmed", state: "approved", version: 2,
        }),
    }, {
        lookup: async () => ({ id: "example", operationId: "foreign-operation", status: "completed" }),
    });
    await expect(service.receipt("example", "operation-example"))
        .rejects.toThrow("FEATURE_OPERATION_RESULT_MISMATCH");
    await expect(service.jobStatus("example", "operation-example"))
        .rejects.toThrow("FEATURE_OPERATION_RESULT_MISMATCH");
});


for (const field of ["id", "operationId"] as const) {
    test("${name} isolates lookup identity when an adapter rewrites " + field, async () => {
        let calls = 0;
        const service = new ${className}Service(${className}RequestEnvelope, undefined, undefined, {
            async lookup(_context, input) {
                calls++;
                Object.assign(input, { [field]: "foreign" });
                return { ...input, status: "confirmed", state: "approved", version: 2 };
            },
        }, {
            async lookup(_context, input) {
                calls++;
                Object.assign(input, { [field]: "foreign" });
                return { ...input, status: "completed" };
            },
        });
        await expect(service.receipt("example", "operation-example"))
            .rejects.toMatchObject({ _tag: "FEATURE_OPERATION_RESULT_MISMATCH" });
        await expect(service.jobStatus("example", "operation-example"))
            .rejects.toMatchObject({ _tag: "FEATURE_OPERATION_RESULT_MISMATCH" });
        expect(calls).toBe(2);
    });
}

test("${name} preserves matching lookup results and does not replay failures", async () => {
    const receipt = { id: "example", operationId: "operation-example", status: "unknown" as const, state: "draft", version: 1 };
    const status = { id: "example", operationId: "operation-example", status: "queued" as const };
    let calls = 0;
    const service = new ${className}Service(${className}RequestEnvelope, undefined, undefined, {
        async lookup() { calls++; return receipt; },
    }, {
        async lookup() { calls++; return status; },
    });
    expect(await service.receipt("example", "operation-example")).toBe(receipt);
    expect(await service.jobStatus("example", "operation-example")).toBe(status);
    expect(calls).toBe(2);
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
    permissions: [${JSON.stringify(permission)}, ${JSON.stringify(readPermission)}],
} as const;

export const ${className}RequestEnvelope = {
    ...${className}RequestContext,
    identity: { authenticated: true, subject: "reviewer-example" },
    access: { tenantId: "tenant-example", permissions: [${JSON.stringify(permission)}, ${JSON.stringify(readPermission)}] },
} as const satisfies Record<string, unknown>;

export const ${className}JobRequestEnvelope = {
    ...${className}RequestEnvelope,
    idempotencyKey: "operation-example",
} as const satisfies Record<string, unknown>;
`,
        [`${name}.e2e.test.ts`]: `import { expect, test } from "bun:test";
import { ${className}Fixture } from "./${name}.fixture";

const baseUrl = process.env["SUPACLOUD_FEATURE_E2E_URL"];
const authorization = process.env["SUPACLOUD_FEATURE_E2E_AUTHORIZATION"];
const otherAuthorization = process.env["SUPACLOUD_FEATURE_E2E_OTHER_AUTHORIZATION"];
const fixtureId = process.env["SUPACLOUD_FEATURE_E2E_ID"] ?? ${className}Fixture.id;
const idempotencyKey = process.env["SUPACLOUD_FEATURE_E2E_IDEMPOTENCY_KEY"];
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

    // A lost response is recovered through the durable receipt, never by
    // submitting the approval again.
    const recovered = await fetch(
        new URL("/${name}/" + encodeURIComponent(fixtureId) + "/operations/" + encodeURIComponent(config.idempotencyKey), config.baseUrl),
        { headers },
    );
    expect(recovered.ok).toBe(true);
    const recoveredBody = await json(recovered);
    expect(recoveredBody).toMatchObject({ operationId: config.idempotencyKey });
    const jobStatus = await fetch(
        new URL("/${name}/" + encodeURIComponent(fixtureId) + "/operations/" + encodeURIComponent(config.idempotencyKey) + "/status", config.baseUrl),
        { headers },
    );
    expect(jobStatus.ok).toBe(true);
    expect(await json(jobStatus)).toMatchObject({ operationId: config.idempotencyKey });

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
- [ ] Verify receipt lookup recovers a lost response without resubmitting the Command.
- [ ] Pass \`${className}ApproveInvalidateTags\` to the generated mutation's \`invalidateTags\` option.
- [ ] Bind \`${className}JobStatuses\` to the existing Workflow/Queue status read path.
- [ ] Verify status lookup is tenant-scoped and distinguishes queued, running, completed, failed and cancelled.
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
point, not an automatically scheduled workflow. The generated status route is also
an explicit read adapter boundary; it does not treat a queue message ID or current
business row as proof of task completion.

Compile the routes with the existing client generator and use @supacloud/query for
identity-scoped caching/invalidation. Use the generated \`${className}ApproveInvalidateTags\`
constant for the approval mutation; tags are explicit and never inferred from route names.
There is deliberately no second hand-maintained
HTTP client. A committed approval followed by a failed refresh is still committed;
recover its receipt instead of resending. Host domain errors must carry a stable
_tag, tag, code or error name matching the declared route mapping; an Error message
alone is not a machine-readable code. Context failures map to authentication-required,
and foreign operation results fail with FEATURE_OPERATION_RESULT_MISMATCH on both
lookup routes. Unknown failures remain generic server errors without exposing messages.
RequestId propagation and durable adapter implementation remain host responsibilities.

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
