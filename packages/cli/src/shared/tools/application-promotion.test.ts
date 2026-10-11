import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationReleaseId, applicationPromotionPlanDigest, parseApplicationPromotionPlan,
  type ApplicationPromotionPlan, type ApplicationPromotionPlanContent,
} from "@supacloud/delivery";
import { registerApplicationTools } from "./application-tools";
import { runAppTool } from "./app-tools";
import { HttpTransport } from "../transports/http";
import type { ToolInvocation } from "../tool-server";
import { executionMode } from "../execution-policy";

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
      const result = await handler(new HttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture",
      }))(args);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
      expect(result.content[0]!.text).not.toContain("private-marker");
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
