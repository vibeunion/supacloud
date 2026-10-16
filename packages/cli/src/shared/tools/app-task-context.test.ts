import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeAppProject } from "./app-starter";
import { registerAppAliases, registerAppTools, runAppTool, type AppToolArguments } from "./app-tools";
import type { ToolInvocation, ToolServer } from "../tool-server";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("target context connects maintained files, dependencies, preview repairs and bounded verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-context-"));
  roots.push(root);
  await initializeAppProject({ root, name: "sample" });
  const repo = resolve(import.meta.dir, "../../../../..");
  await symlink(join(repo, "packages/cli/node_modules"), join(root, "node_modules"), "dir");
  const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  config.compilerOptions.paths = { "@supacloud/app/core": [join(repo, "packages/app/src/core.ts")] };
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  const generated = await readFile(join(root, "generated/application.ts"), "utf8");
  const result = await runAppTool({ action: "context", root, target: "health", format: "json" });
  const pack = JSON.parse(result.content[0]!.text);
  expect(pack.subject).toBe("health");
  expect(pack.workflow.editFiles).toContain("src/features/health/health.ts");
  expect(pack.workflow.verification.tests).toEqual(["src/features/health/health.test.ts"]);
  expect(pack.workflow.allowedDependencies.dependencies).toContain("@supacloud/js");
  expect(pack.workflow.rules.permissions).toBe("explicit-business-input-required");
  expect(pack.workflow.rules.fixDefault).toBe("preview");
  expect(pack.workflow.release.first).toEqual(["supacloud", "app", "check", "--format", "json"]);
  expect(pack.workflow.executed).toBe(false);
  expect(pack).not.toHaveProperty("execution");
  const doctor = await runAppTool({ action: "doctor", root, target: "health", format: "json" });
  const diagnosis = JSON.parse(doctor.content[0]!.text);
  expect(diagnosis.scope.target).toBe("health");
  expect(diagnosis.scope.generatedArtifactCheck).toBe("project-wide");
  expect(diagnosis.scope.notChecked).toContain("unwired contracts outside graph");
  expect(await readFile(join(root, "generated/application.ts"), "utf8")).toBe(generated);

  const registered = new Map<string, ToolInvocation>();
  const server: ToolServer = { tool(name, _description, _schema, callback) { registered.set(name, callback); } };
  registerAppTools(server);
  registerAppAliases(server);
  const operation = pack.executionPlans.find((plan: { kind: string; name: string }) => plan.kind === "route")?.name;
  expect(operation).toBeString();
  const event = { kind: "route", operation, stage: "handler", phase: "failed", requestId: "request-123" };
  const eventFile = join(root, "execution.ndjson");
  const sourceFile = join(root, "src/features/health/health.ts");
  const source = await readFile(sourceFile, "utf8");
  const drift = generated + "\n// preserve drift during execution context\n";
  await writeFile(join(root, "generated/application.ts"), drift);
  const log = { event: "review-http-execution", component: "review-http", timestamp: "2026-10-16T00:00:00.000Z", ...event };
  for (const input of [JSON.stringify({ version: 1, events: [event] }),
    [log, { ...log, requestId: "other-request" }].map(value => JSON.stringify(value)).join("\n")]) {
    await writeFile(eventFile, input);
    for (const name of ["app", "context"]) {
      const callback = registered.get(name);
      if (!callback) throw new Error("Missing registered context entry");
      const enriched = await callback({
        ...(name === "app" ? { action: "context" } : {}),
        root, target: "health", format: "json", events: "execution.ndjson",
        ...(name === "app" ? { "request-id": "request-123" } : { request_id: "request-123" }),
      });
      const enrichedPack = JSON.parse(enriched.content[0]!.text);
      expect(enrichedPack.execution).toMatchObject({
        correlation: "current-graph-only", eventsTrusted: false, deploymentVerified: false,
        events: [{ ...event, module: "health", index: 0 }],
      });
      expect(enrichedPack.workflow).toEqual(pack.workflow);
      expect(enrichedPack.execution).not.toHaveProperty("timestamp");
      expect(enriched.content[0]!.text).not.toContain("other-request");
      expect(enriched.isError).toBe(false);
    }
  }
  const request = { action: "context", root, target: "health", format: "json",
    events: "execution.ndjson", request_id: "request-123" } as const;
  await expect(runAppTool({ ...request, request_id: "absent-request" })).rejects.toThrow("EXECUTION_CONTEXT_NOT_FOUND");
  await expect(runAppTool({ ...request, events: "PRIVATE_MISSING_FILE" })).rejects.toThrow("EXECUTION_METADATA_UNREADABLE");
  await writeFile(eventFile, JSON.stringify({ ...log, credentials: "PRIVATE_INPUT" }));
  try {
    await runAppTool(request);
    throw new Error("Expected rejection");
  } catch (error) {
    expect((error as Error).message).toBe("EXECUTION_METADATA_INVALID");
    expect(String(error)).not.toContain("PRIVATE_INPUT");
  }
  expect(await readFile(sourceFile, "utf8")).toBe(source);
  expect(await readFile(join(root, "generated/application.ts"), "utf8")).toBe(drift);
}, 30_000);

test("execution options fail before project reads or remote dispatch when incomplete or used on another action", async () => {
  let dispatched = false;
  const options = { getApplications: () => async () => { dispatched = true; return { content: [] }; } };
  const valid: AppToolArguments = {
    action: "context", root: "/nonexistent-project", target: "health",
    events: "PRIVATE_INPUT", request_id: "request-123", format: "json",
  };
  const invalid: Partial<AppToolArguments>[] = [
    { events: undefined }, { request_id: undefined }, { request_id: "PRIVATE_INPUT\n" },
    { target: undefined }, { target: " " }, { format: "text" }, { format: undefined },
    { write: true }, { write: false }, { action: "compile" }, { action: "deploy" },
    { action: "fix" }, { action: "doctor" }, { events: " " },
  ];
  for (const override of invalid) {
    await expect(runAppTool({ ...valid, ...override }, options)).rejects.toThrow("Execution context requires");
  }
  await expect(runAppTool({ ...valid, "request-id": "other-request" })).rejects.toThrow("aliases");
  expect(dispatched).toBe(false);
});
