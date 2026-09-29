import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

test("dev-context CLI prints the application development contract read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "application-development-cli-"));
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

    const json = await invoke(["dev-context", "--json"]);
    expect(json.status).toBe(0);
    const context = JSON.parse(json.stdout);
    expect(context).toMatchObject({ schema: "supacloud.application-development.v1", source: "current-graph", deploymentVerified: false });
    expect(context.modules.map((item: { name: string }) => item.name)).toContain("case");
    expect(context.routes.some((route: { path: string }) => route.path.includes("accept"))).toBe(true);
    expect(context.executionPlans.some((plan: { name: string }) => plan.name === "case.accept")).toBe(true);
    expect(context.diagnostics).toEqual([]);

    const text = await invoke(["dev-context"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("APPLICATION supacloud.application-development.v1");

    const denied = await invoke(["dev-context", "--json", "--write"]);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain("dev-context is read-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);