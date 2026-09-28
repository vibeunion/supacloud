import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileProject } from "./compile";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

test("context CLI correlates runtime failures with diagnostics and remains read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-context-cli-"));
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
      cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { status, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  };
  try {
    await writeFixtureProject(root, GOOD_PROJECT_FILES);
    const outDir = join(root, "generated");
    expect((await compileProject({ rootDir: root, outDir })).diagnostics).toEqual([]);
    const artifact = join(outDir, "application.ts");
    const originalArtifact = await readFile(artifact, "utf8");
    const source = join(root, "src/features/case/accept-case.command.ts");
    const originalSource = await readFile(source, "utf8");
    const event = { kind: "command", operation: "case.accept", stage: "authorize", phase: "failed", requestId: "trace-one" };
    const eventsFile = join(root, "events.json");
    await writeFile(eventsFile, JSON.stringify({ version: 1, events: [event] }));
    const args = ["context", "case", "--events", eventsFile, "--request-id", "trace-one", "--json"];
    const response = await invoke(args);
    expect(response.status).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({
      correlation: "current-graph-only", deploymentVerified: false, eventsTrusted: false,
      subject: "case", events: [{ ...event, module: "case" }],
    });
    expect(Buffer.byteLength(response.stdout)).toBeLessThanOrEqual(32_768);
    const legacy = await invoke(["context", "case", "--json"]);
    expect(legacy.status).toBe(0);
    expect(JSON.parse(legacy.stdout)).not.toHaveProperty("correlation");

    await writeFile(artifact, originalArtifact + "\n// drift sentinel\n");
    expect((await invoke(args)).status).toBe(0);
    expect(await readFile(artifact, "utf8")).toBe(originalArtifact + "\n// drift sentinel\n");
    await rm(artifact);
    expect((await invoke(args)).status).toBe(0);
    expect(existsSync(artifact)).toBe(false);
    await writeFile(artifact, originalArtifact);

    const invalidSource = originalSource.replace('transaction: "required"', 'transaction: "requried"');
    await writeFile(source, invalidSource);
    const diagnosis = await invoke(args);
    expect(diagnosis.status).toBe(0);
    expect(JSON.parse(diagnosis.stdout).diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid-command-mode", repair: { type: "set_command_mode", readiness: "input-required" },
    }));
    expect(diagnosis.stdout).not.toContain("expectedExpression");
    for (const flags of [["--write"], ["--write", "--dry-run"]]) {
      const denied = await invoke([...args, ...flags]);
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain("context is read-only");
    }
    expect(await readFile(source, "utf8")).toBe(invalidSource);
    expect(await readFile(artifact, "utf8")).toBe(originalArtifact);

    for (const content of [
      '{"credentials":"PRIVATE_INPUT"',
      JSON.stringify({ version: 1, events: [{ ...event, body: "PRIVATE_INPUT" }] }),
      JSON.stringify({ version: 1, events: [{ ...event, operation: "PRIVATE_INPUT" }] }),
    ]) {
      await writeFile(eventsFile, content);
      const denied = await invoke(args);
      expect(denied.status).not.toBe(0);
      expect(denied.stdout + denied.stderr).not.toContain("PRIVATE_INPUT");
      expect(JSON.parse(denied.stdout).ok).toBe(false);
    }
    const missing = await invoke(["context", "case", "--events", eventsFile, "--json"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("requires --events, --request-id and --json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
