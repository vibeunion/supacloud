import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";
import { readEnvironmentBindingsFile } from "./environment-bindings-file";

const document = (binding: string) => JSON.stringify({ schema: "supacloud.environments.v1", environments: {
  test: { bindings: { orders: binding } },
} });

test("CLI scopes default and relative binding files to an explicit root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "binding-roots-"));
  const root = join(cwd, "application");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, "environment-bindings", ...args], {
      cwd, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { status, stdout, stderr };
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  };
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/features/orders/resources.ts": `import { InfraResource } from "../../runtime";\n@InfraResource({ name: "orders", kind: "database" })\nexport class OrdersDatabase {}\n`,
      "supacloud.environments.json": document("project:selected"),
      "bindings/custom.json": document("project:custom"),
    });
    await writeFile(join(cwd, "supacloud.environments.json"), document("project:wrong-workspace"));
    const result = await invoke([root, "--environment", "test", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).bindings[0].binding).toBe("project:selected");
    const relative = await invoke(["--root", root, "--environment", "test", "--bindings-file", "bindings/custom.json", "--json"]);
    expect(relative.status).toBe(0);
    expect(JSON.parse(relative.stdout).bindings[0].binding).toBe("project:custom");
    const absolute = await invoke([root, "--environment", "test", "--bindings-file", join(root, "bindings/custom.json"), "--json"]);
    expect(absolute.status).toBe(0);
    expect(JSON.parse(absolute.stdout).bindings[0].binding).toBe("project:custom");
    const missing = await invoke([root, "--json"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("requires --environment");
    expect(missing.stdout).toBe("");
    const write = await invoke([root, "--environment", "test", "--write"]);
    expect(write.status).toBe(1);
    expect(write.stderr).toContain("read-only");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);

test("binding file reader rejects oversized and malformed UTF-8 input without echoing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "binding-read-"));
  const file = join(root, "bindings.json");
  try {
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    await expect(readEnvironmentBindingsFile(file)).rejects.toThrow("ENVIRONMENT_BINDINGS_TOO_LARGE");
    const invalid = Buffer.from(document("local"));
    invalid[invalid.indexOf("local")] = 0xff;
    await writeFile(file, invalid);
    await expect(readEnvironmentBindingsFile(file)).rejects.toThrow("ENVIRONMENT_BINDINGS_INVALID");
    await writeFile(file, '{"secret":"do-not-echo"');
    await expect(readEnvironmentBindingsFile(file)).rejects.toThrow("ENVIRONMENT_BINDINGS_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});
