import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRoutes } from "@supacloud/app";
import { featureScaffold } from "../../cli/src/shared/tools/app-feature";
import { runCompiledEffect, type CompiledEffectDescriptor } from "./effect";

type Method = "list" | "detail" | "approve" | "receipt" | "jobStatus";
type Input = { id: string; operationId: string };
type Lookup = { lookup(context: unknown, input: Input): Promise<unknown> };
interface Service {
  list(input: object): Promise<unknown>;
  detail(id: string): Promise<unknown>;
  approve(id: string, input: { expectedVersion: number }): Promise<unknown>;
  receipt(id: string, operationId: string): Promise<unknown>;
  jobStatus(id: string, operationId: string): Promise<unknown>;
}
interface Controller {
  list(): unknown;
  detail(id: string): unknown;
  approve(id: string, input: { expectedVersion: number }): unknown;
  receipt(id: string, operationId: string): unknown;
  jobStatus(id: string, operationId: string): unknown;
}
let ServiceClass: new (
  context: unknown,
  reader: { list(): Promise<unknown>; detail(): Promise<unknown> },
  writer: { approve(): Promise<unknown> },
  receipts: Lookup,
  statuses: Lookup,
) => Service;
let ControllerClass: new (
  list: { execute(): Promise<unknown> },
  detail: { execute(id: string): Promise<unknown> },
  receipt: { execute(id: string, operationId: string): Promise<unknown> },
  jobStatus: { execute(id: string, operationId: string): Promise<unknown> },
  command: { execute(id: string, input: { expectedVersion: number }): Promise<unknown> },
) => Controller;
let root: string | undefined;
const identity = {
  requestId: "request", identity: { authenticated: true, subject: "actor" },
  access: { tenantId: "tenant", permissions: ["cases:approve", "cases:read"] },
};
const row = { id: "case-1", state: "approved", version: 2 };
const input: Input = { id: row.id, operationId: "operation-1" };

beforeAll(async () => {
  root = await mkdtemp(join(import.meta.dir, ".feature-errors-"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { experimentalDecorators: true },
  }));
  const files = featureScaffold("case-approval", "CaseApproval", {
    permission: "cases:approve", readPermission: "cases:read", rpc: "approveCase",
    database: { source: "db/schema.ts", table: "public.reviews", rowType: "ReviewRow" },
  });
  for (const suffix of ["contracts", "model", "service", "feature"]) {
    const name = "case-approval." + suffix + ".ts";
    const source = files[name];
    if (!source) throw new Error("Missing generated file " + name);
    await writeFile(join(root, name), source);
  }
  const services: { CaseApprovalService: typeof ServiceClass } = await import(join(root, "case-approval.service.ts"));
  const controllers: { CaseApprovalController: typeof ControllerClass } = await import(join(root, "case-approval.feature.ts"));
  ServiceClass = services.CaseApprovalService;
  ControllerClass = controllers.CaseApprovalController;
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function controller(context: unknown, lookup: Lookup["lookup"], failure?: Error, onRead: () => void = () => {}) {
  const call = async () => { onRead(); if (failure) throw failure; return row; };
  const service = new ServiceClass(context, { list: call, detail: call }, { approve: call }, { lookup }, { lookup });
  return new ControllerClass(
    { execute: () => service.list({}) },
    { execute: (id) => service.detail(id) },
    { execute: (id, operationId) => service.receipt(id, operationId) },
    { execute: (id, operationId) => service.jobStatus(id, operationId) },
    { execute: (id, body) => service.approve(id, body) },
  );
}
function run(instance: Controller, method: Method) {
  const effect = getRoutes(ControllerClass).find(route => route.handler === method)?.effect;
  if (effect?.required !== true) throw new Error("Missing generated Effect descriptor");
  const descriptor: CompiledEffectDescriptor = { ...effect, required: true };
  const program = method === "list" ? instance.list()
    : method === "detail" ? instance.detail(input.id)
    : method === "approve" ? instance.approve(input.id, { expectedVersion: 1 })
    : instance[method](input.id, input.operationId);
  return runCompiledEffect(program, descriptor);
}

for (const method of ["list", "detail", "approve", "receipt", "jobStatus"] as const) {
  test(`generated ${method} maps missing context without invoking adapters`, async () => {
    let calls = 0;
    const instance = controller(undefined, async () => { calls++; return {}; }, undefined, () => { calls++; });
    await expect(run(instance, method)).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect(calls).toBe(0);
  });
}
for (const method of ["list", "detail", "receipt", "jobStatus"] as const) {
  for (const permissions of [[], ["cases:approve"]]) {
    test(`generated ${method} denies missing read permission with ${JSON.stringify(permissions)} before adapters`, async () => {
      let calls = 0;
      const context = { ...identity, access: { ...identity.access, permissions } };
      const instance = controller(context, async () => { calls++; return {}; }, undefined, () => { calls++; });
      await expect(run(instance, method)).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
      expect(calls).toBe(0);
    });
  }
  test(`generated ${method} allows a read-only identity and invokes one adapter`, async () => {
    let calls = 0;
    const context = { ...identity, access: { ...identity.access, permissions: ["cases:read"] } };
    const result = { ...row, ...input, status: "unknown" };
    const instance = controller(context, async () => { calls++; return result; }, undefined, () => { calls++; });
    expect(await run(instance, method)).toBe(method === "list" || method === "detail" ? row : result);
    expect(calls).toBe(1);
  });
}
for (const method of ["receipt", "jobStatus"] as const) {
  for (const field of ["id", "operationId"] as const) {
    for (const mutate of [false, true]) {
      test(`generated ${method} rejects foreign ${field} with argument mutation=${mutate}`, async () => {
        let calls = 0;
        const instance = controller(identity, async (_context, request) => {
          calls++;
          if (mutate) Object.assign(request, { [field]: "foreign" });
          return { ...row, ...request, [field]: "foreign", status: "confirmed" };
        });
        await expect(run(instance, method)).rejects.toMatchObject({
          status: 503, code: "FEATURE_OPERATION_RESULT_MISMATCH",
          message: "FEATURE_OPERATION_RESULT_MISMATCH",
        });
        expect(calls).toBe(1);
      });
    }
  }
  test(`generated ${method} preserves matching results and performs one read`, async () => {
    const result = { ...row, ...input, status: "unknown" };
    let calls = 0;
    const instance = controller(identity, async () => { calls++; return result; });
    expect(await run(instance, method)).toBe(result);
    expect(calls).toBe(1);
  });
  test(`generated ${method} keeps unknown adapter failures generic without replay`, async () => {
    let calls = 0;
    const instance = controller(identity, async () => { calls++; throw new Error("private://credentials"); });
    await expect(run(instance, method)).rejects.toMatchObject({
      status: 500, code: "EFFECT_UNMAPPED_ERROR", message: "Effect execution failed",
    });
    expect(calls).toBe(1);
  });
}
for (const [code, status] of [
  ["AUTHENTICATION_REQUIRED", 401], ["PERMISSION_DENIED", 403],
  ["FEATURE_TRANSITION_CONFLICT", 409], ["VERSION_CONFLICT", 409],
  ["COMMAND_IDEMPOTENCY_CONFLICT", 409], ["COMMAND_OUTCOME_UNKNOWN", 503],
] as const) {
  test(`generated approval retains the declared ${code} mapping`, async () => {
    const error = Object.assign(new Error("private failure"), { code });
    const instance = controller(identity, async () => ({}), error);
    await expect(run(instance, "approve")).rejects.toMatchObject({ status, code, message: code });
  });
}
