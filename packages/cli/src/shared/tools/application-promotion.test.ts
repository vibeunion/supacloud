import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationReleaseId, applicationPromotionPlanDigest, parseApplicationPromotionPlan,
  applicationPromotionAction, applicationPromotionSteps,
  type ApplicationPromotionPlan, type ApplicationPromotionPlanContent,
} from "@supacloud/delivery";
import { registerApplicationTools } from "./application-tools";
import { runAppTool } from "./app-tools";
import { HttpTransport } from "../transports/http";
import type { ToolInvocation } from "../tool-server";
import { authorizeExecution, executionMode } from "../execution-policy";
import { resolveSupaCloudContext } from "../context";
import { outcomeUnknownGuidance } from "../outcome-guidance";

const configurationId = "11234567-89ab-4def-8123-456789abcdef";
function plan(): ApplicationPromotionPlan {
  const content: ApplicationPromotionPlanContent = {
    schema: "supacloud.application-promotion-plan.v1",
    project_ref: "production", application_id: "reviews", environment_id: "production",
    manifest_sha256: "a".repeat(64),
    source: {
      project_ref: "staging", environment_id: "staging",
      release_id: applicationReleaseId("staging", "reviews", "a".repeat(64)),
      activation_id: "01234567-89ab-4def-8123-456789abcdef",
      receipt_confirmed: true, ready: true, smoke_verified: true, evidence_sha256: "e".repeat(64),
      migration_ledger_digest: "b".repeat(64),
    },
    target: {
      candidate_release_id: applicationReleaseId("production", "reviews", "a".repeat(64)),
      current_release_id: null, artifact_action: "materialize", activation_id: null,
      configuration_id: configurationId,
      receipt_confirmed: false, ready: false, smoke_verified: false, evidence_sha256: null,
      migration_ledger_digest: null,
      configuration: {
        schema: "supacloud.application-configuration.v1", project_ref: "production", application_id: "reviews",
        environment_id: "production", configuration_id: configurationId, created_at: "2026-10-10T00:00:00.000Z",
        bun_version: "1.4.2", targets: [{ name: "api", kind: "http", hosts: ["example.com"], environment_names: ["DATABASE_URL"] }],
      },
    },
    migrations: {
      ledger_digest: "b".repeat(64), ledger_compatible: true, project_migrations_applied: true,
      pending_versions: [], operator_provisioning_required: false,
    },
    backup: { required: false, confirmed: false },
    action: "promote", blockers: [], steps: ["transfer", "activate-with-cas", "verify-runtime-and-smoke"],
    execution_performed: false, data_recovery: "separate-required",
  };
  return parseApplicationPromotionPlan({ ...content, plan_sha256: applicationPromotionPlanDigest(content) });
}

function noOpPlan(): ApplicationPromotionPlan {
  const current = plan();
  const { plan_sha256: _planSha256, ...content } = current;
  const noOpContent = {
    ...content,
    target: {
      ...content.target,
      current_release_id: content.target.candidate_release_id,
      artifact_action: "reuse" as const,
      activation_id: "21234567-89ab-4def-8123-456789abcdef",
      receipt_confirmed: true,
      ready: true,
      smoke_verified: true,
      evidence_sha256: "e".repeat(64),
      migration_ledger_digest: "b".repeat(64),
    },
    action: "no-op" as const,
    blockers: [],
    steps: [],
  };
  return parseApplicationPromotionPlan({
    ...noOpContent,
    plan_sha256: applicationPromotionPlanDigest(noOpContent),
  });
}

function plannedChange(change: Partial<ApplicationPromotionPlanContent>): ApplicationPromotionPlan {
  const { plan_sha256: _digest, ...content } = plan();
  const next = { ...content, ...change };
  next.action = applicationPromotionAction(next);
  next.steps = applicationPromotionSteps(next);
  return parseApplicationPromotionPlan({ ...next, plan_sha256: applicationPromotionPlanDigest(next) });
}
const args = {
  action: "get_promotion_plan", ref: "production", id: "reviews", environment_id: "production",
  source_ref: "staging", source_environment_id: "staging", source_release_id: plan().source.release_id,
};
function handler(http: HttpTransport): ToolInvocation {
  let invoke: ToolInvocation | undefined;
  registerApplicationTools({ tool(_name, _description, _schema, callback) { invoke = callback; } }, http);
  if (!invoke) throw new Error("Missing application handler");
  return invoke;
}

test("promotion planning uses one bounded GET and defaults to concise output", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    expect(new URL(request.url).searchParams.get("source_environment_id")).toBe("staging");
    return Response.json(plan());
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    const output = await invoke(args);
    expect(JSON.parse(output.content[0]!.text)).toMatchObject({ ok: true, plan: plan() });
    const request = { ...args, action: "promote-plan" as const };
    const text = await runAppTool(request, { getApplications: () => invoke });
    expect(text.content[0]!.text).toContain("production/reviews/production: promote");
    expect(text.content[0]!.text).toContain("Execution: not performed");
    const json = await runAppTool({ ...request, format: "json" }, { getApplications: () => invoke });
    expect(JSON.parse(json.content[0]!.text)).toMatchObject({ ok: true, plan: plan() });
    expect(requests).toEqual(Array(3).fill("GET /v1/projects/production/applications/reviews/environments/production/promotion-plan"));
  } finally { server.stop(true); }
});

test.each(["digest", "scope", "private", "source"] as const)(
  "CLI rejects %s promotion plans without exposing their payload", async fault => {
    const candidate = plan();
    const payload = fault === "digest" ? { ...candidate, plan_sha256: "f".repeat(64) }
      : fault === "scope" ? { ...candidate, project_ref: "foreign" }
      : fault === "private" ? { ...candidate, private: "private-marker" }
      : { ...candidate, source: { ...candidate.source, environment_id: "foreign" } };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(payload) });
    try {
      const invoke = handler(new HttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture",
      }));
      const result = await invoke(args);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
      expect(result.content[0]!.text).not.toContain("private-marker");
      const execution = await runAppTool({ ...args, action: "promote", format: "json" }, { getApplications: () => invoke });
      expect(JSON.parse(execution.content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    } finally { server.stop(true); }
  },
);

test("missing source environment is rejected before HTTP and policy is read-only", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return Response.json(plan());
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    await expect(invoke({ ...args, source_environment_id: undefined })).rejects.toThrow();
    expect(requests).toBe(0);
    expect(executionMode("app", "promote-plan", args)).toBe("read");
    expect(executionMode("applications", "get_promotion_plan", args)).toBe("read");
  } finally { server.stop(true); }
});

test("app promote reads one plan and skips POST for a complete no-op", async () => {
  const calls: string[] = [];
  const noOp = noOpPlan();
  const result = await runAppTool({
    action: "promote", ref: "production", id: "reviews", environment_id: "production",
    source_ref: "staging", source_environment_id: "staging", source_release_id: noOp.source.release_id,
  }, {
    getApplications: () => async args => {
      calls.push(String(args.action));
      expect(args.action).toBe("get_promotion_plan");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, plan: noOp }) }] };
    },
  });
  expect(result.isError).toBe(false);
  expect(result.content[0]!.text).toContain("no-op");
  expect(calls).toEqual(["get_promotion_plan"]);
});

test("real HTTP no-op and diff perform only plan reads, including JSON output", async () => {
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls.push(request.method);
    return Response.json(noOpPlan());
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    const json = await runAppTool({ ...args, action: "promote", json: true }, { getApplications: () => invoke });
    expect(JSON.parse(json.content[0]!.text)).toMatchObject({ ok: true, no_op: true, execution_performed: false });
    expect(JSON.parse(json.content[0]!.text).mutation_id).toBeUndefined();
    const diff = await runAppTool({ ...args, action: "diff" }, { getApplications: () => invoke });
    expect(diff.content[0]!.text).toContain("no-op");
    expect(calls).toEqual(["GET", "GET"]);
  } finally { server.stop(true); }
});

test.each(["success", "server-error", "private", "scope", "digest", "activation", "accepted", "empty"] as const)(
  "real promotion handles %s with exactly one POST and preserves recovery identity", async fault => {
    const calls: string[] = [];
    let mutationId = "";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      calls.push(request.method);
      if (request.method === "GET") return Response.json(plan());
      expect(new URL(request.url).pathname).toBe("/v1/projects/production/applications/reviews/environments/production/promotions");
      const body = await request.json() as Record<string, unknown>;
      expect(body.plan).toEqual(plan());
      expect(body.configuration_id).toBe(configurationId);
      expect(body.approved_migration_digest).toBeUndefined();
      mutationId = String(body.mutation_id);
      const result = {
        project_ref: "production", application_id: "reviews", environment_id: "production",
        mutation_id: mutationId, activation_id: "31234567-89ab-4def-8123-456789abcdef",
        plan_sha256: plan().plan_sha256, action: "promote", replayed: false,
      };
      if (fault === "server-error") return Response.json({ error: "private-marker" }, { status: 503 });
      if (fault === "empty") return new Response(null, { status: 200 });
      if (fault === "private") return Response.json({ ...result, private: "private-marker" });
      if (fault === "scope") result.environment_id = "foreign";
      if (fault === "digest") result.plan_sha256 = "f".repeat(64);
      if (fault === "activation") result.activation_id = mutationId;
      return Response.json(result, { status: fault === "accepted" ? 202 : 200 });
    } });
    try {
      const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
      const output = await runAppTool({ ...args, action: "promote", format: "json" }, { getApplications: () => invoke });
      const result = JSON.parse(output.content[0]!.text);
      expect(calls).toEqual(["GET", "POST"]);
      expect(result.mutation_id).toBe(mutationId);
      expect(output.content[0]!.text).not.toContain("private-marker");
      if (fault === "success") {
        expect(result).toMatchObject({ ok: true, result: { action: "promote" } });
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
        expect(outcomeUnknownGuidance(output.content[0]!.text)).toContain(`--mutation_id ${mutationId}`);
      }
    } finally { server.stop(true); }
  },
);

test("CLI delegates migration prerequisites without inventing an approval digest", async () => {
  const pending = plannedChange({
    migrations: {
      ...plan().migrations, project_migrations_applied: false, pending_versions: ["20261011000100"],
    },
    backup: { required: true, confirmed: false }, blockers: ["MIGRATION_PENDING", "BACKUP_REQUIRED"],
  });
  let posts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json(pending);
    posts++;
    expect(await request.json()).toMatchObject({
      plan: pending, approved_migration_digest: "d".repeat(64),
    });
    return Response.json({ code: "MIGRATION_REQUIRES_REVIEW" }, { status: 409 });
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    const result = await runAppTool({
      ...args, action: "promote", format: "json", approved_migration_digest: "d".repeat(64),
    }, { getApplications: () => invoke });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code: "HTTP_ERROR", http_status: 409 } });
    expect(posts).toBe(1);
  } finally { server.stop(true); }
});

test("hard blockers never submit a promotion and an existing mutation ID cannot start a new attempt", async () => {
  const blocked = plannedChange({
    source: { ...plan().source, smoke_verified: false }, blockers: ["SOURCE_SMOKE_UNVERIFIED"],
  });
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.method);
    return Response.json(blocked);
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    const output = await runAppTool({ ...args, action: "promote", format: "json" }, { getApplications: () => invoke });
    expect(output.isError).toBe(true);
    expect(JSON.parse(output.content[0]!.text)).toMatchObject({ execution_performed: false });
    await expect(runAppTool({
      ...args, action: "promote", mutation_id: "41234567-89ab-4def-8123-456789abcdef",
    }, { getApplications: () => invoke })).rejects.toThrow("promote-status");
    expect(requests).toEqual(["GET"]);
  } finally { server.stop(true); }
});

test("promotion and preview policy permits reads and requires exact production confirmation for writes", () => {
  const context = resolveSupaCloudContext({
    SUPACLOUD_ENV: "production", SUPACLOUD_API_URL: "https://management.example.test",
    SUPACLOUD_API_TOKEN: "fixture", SUPACLOUD_PROJECT_REF: "production",
  });
  for (const action of ["diff", "promote-plan", "promote-status", "preview-plan"]) {
    expect(executionMode("app", action, {})).toBe("read");
    expect(() => authorizeExecution("app", { action, ref: "production" }, {
      context: { ...context, readOnly: true },
    })).not.toThrow();
    expect(() => authorizeExecution("app", { action, ref: "foreign" }, { context })).toThrow("different project");
  }
  for (const action of ["promote", "promote-reconcile", "preview-list", "preview-create", "preview-status", "preview-cleanup"]) {
    expect(executionMode("app", action, {})).toBe("write");
    expect(() => authorizeExecution("app", { action, ref: "production" }, { context })).toThrow("confirm-production");
    expect(() => authorizeExecution("app", { action, ref: "production" }, {
      context, confirmProduction: "production",
    })).not.toThrow();
    expect(() => authorizeExecution("app", { action, ref: "production" }, {
      context: { ...context, readOnly: true }, confirmProduction: "production",
    })).toThrow("read-only");
  }
});

test("app promote generates one mutation request after an immutable plan", async () => {
  const current = plan();
  const calls: Record<string, unknown>[] = [];
  const result = await runAppTool({
    action: "promote", ref: "production", id: "reviews", environment_id: "production",
    source_ref: "staging", source_environment_id: "staging", source_release_id: current.source.release_id,
  }, {
    getApplications: () => async args => {
      calls.push(args);
      if (args.action === "get_promotion_plan") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, plan: current }) }] };
      }
      expect(args.action).toBe("promote_application");
      return { content: [{
        type: "text",
        text: JSON.stringify({
          ok: true, operation: "applications.promote_application", project_ref: "production",
          application_id: "reviews", environment_id: "production",
          mutation_id: args.mutation_id, plan_sha256: current.plan_sha256,
          result: {
            project_ref: "production", application_id: "reviews", environment_id: "production",
            mutation_id: args.mutation_id, activation_id: "31234567-89ab-4def-8123-456789abcdef",
            plan_sha256: current.plan_sha256, action: "promote", replayed: false,
          },
        }),
      }] };
    },
  });
  expect(result.isError).toBe(false);
  expect(result.content[0]!.text).toContain("promoted");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.mutation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1]!.plan).toEqual(current);
});

test("CLI subprocess permits production read-only planning but rejects a foreign target", async () => {
  const root = await mkdtemp(join(tmpdir(), "promotion-cli-"));
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.method);
    return Response.json(plan());
  } });
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(SUPACLOUD_|SUPABASE_|X_PROJECT_REF$|MANAGEMENT_API_URL$)/.test(key),
  ));
  const run = async (flags: string[]) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../index.ts", import.meta.url)),
      "--env", "prod", "app", "promote-plan", "--id", "reviews", "--environment_id", "production",
      "--source_ref", "staging", "--source_environment_id", "staging",
      "--source_release_id", plan().source.release_id, ...flags], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    await Bun.write(join(root, ".env.supacloud.prod"), [
      "SUPACLOUD_ENV=production", "SUPACLOUD_PROJECT_REF=production",
      `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
      "SUPACLOUD_API_TOKEN=fixture", "SUPACLOUD_READ_ONLY=true",
    ].join("\n"));
    const text = await run([]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("Execution: not performed");
    const json = await run(["--format", "json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, plan: plan() });
    const foreign = await run(["--ref", "foreign"]);
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain("different project");
    expect(requests).toEqual(["GET", "GET"]);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("CLI subprocess protects production promote and preserves the unknown ID with a next-step command", async () => {
  const root = await mkdtemp(join(tmpdir(), "promotion-execution-cli-"));
  const requests: string[] = [];
  let selectedPlan = plan();
  let mutationId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(request.method);
    if (request.method === "GET") return Response.json(selectedPlan);
    const body = await request.json() as Record<string, unknown>;
    mutationId = String(body.mutation_id);
    expect(body.plan).toEqual(selectedPlan);
    return Response.json({ error: "private-marker" }, { status: 503 });
  } });
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(SUPACLOUD_|SUPABASE_|X_PROJECT_REF$|MANAGEMENT_API_URL$)/.test(key),
  ));
  const run = async (action: string, flags: string[] = []) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../index.ts", import.meta.url)),
      "--env", "prod", "app", action, ...(flags[0] === "--help" ? flags : [
        "--id", "reviews", "--environment_id", "production",
        "--source_ref", "staging", "--source_environment_id", "staging",
        "--source_release_id", plan().source.release_id, ...flags,
      ])], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const config = (readOnly: boolean) => Bun.write(join(root, ".env.supacloud.prod"), [
    "SUPACLOUD_ENV=production", "SUPACLOUD_PROJECT_REF=production",
    `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
    "SUPACLOUD_API_TOKEN=fixture", `SUPACLOUD_READ_ONLY=${readOnly}`,
  ].join("\n"));
  try {
    await config(true);
    const readOnly = await run("promote", ["--confirm-production", "production"]);
    expect(readOnly.code).toBe(1);
    expect(readOnly.stderr).toContain("read-only");
    await config(false);
    const denied = await run("promote");
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("--confirm-production production");
    expect(requests).toEqual([]);
    selectedPlan = noOpPlan();
    const noOp = await run("promote", ["--confirm-production", "production", "--json"]);
    expect(noOp.code, noOp.stderr).toBe(0);
    expect(JSON.parse(noOp.stdout)).toMatchObject({ ok: true, no_op: true, execution_performed: false });
    expect(requests).toEqual(["GET"]);
    requests.length = 0;
    selectedPlan = plan();
    const unknown = await run("promote", ["--confirm-production", "production", "--format", "json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ mutation_id: mutationId, error: { code: "OUTCOME_UNKNOWN" } });
    expect(unknown.stderr).toContain(`app promote-status --ref production --id reviews --environment_id production --mutation_id ${mutationId}`);
    expect(unknown.stdout + unknown.stderr).not.toContain("private-marker");
    expect(requests).toEqual(["GET", "POST"]);
    const help = await run("promote", ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toContain("--approved_migration_digest ");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);
