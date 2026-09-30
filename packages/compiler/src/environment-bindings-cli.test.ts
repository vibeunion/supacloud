import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";

const RESOURCES = `import { InfraResource } from "../../runtime";

@InfraResource({ name: "orders-db", kind: "database" })
export class OrdersDatabase {}

@InfraResource({ name: "attachments", kind: "bucket" })
export class AttachmentsBucket {}
`;

const DOCUMENT = {
  schema: "supacloud.environments.v1",
  environments: {
    production: { bindings: { "orders-db": "project:orders", attachments: "bucket:attachments" } },
    test: { bindings: { "orders-db": "postgres://user:pass@host/orders" } },
  },
};

test("environment-bindings CLI resolves one environment and fails closed on invalid bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "environment-bindings-cli-"));
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
      cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { status, stdout, stderr };
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  };
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/features/orders/resources.ts": RESOURCES,
      "supacloud.environments.json": JSON.stringify(DOCUMENT),
    });

    const ok = await invoke(["environment-bindings", "--environment", "production", "--json"]);
    expect(ok.status).toBe(0);
    const projection = JSON.parse(ok.stdout);
    expect(projection.environment).toBe("production");
    expect(projection.bindings).toEqual([
      { resource: "attachments", kind: "bucket", binding: "bucket:attachments" },
      { resource: "orders-db", kind: "database", binding: "project:orders" },
    ]);
    expect(projection.diagnostics).toEqual([]);

    const invalid = await invoke(["environment-bindings", "--environment", "test"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toContain("invalid-environment-binding");
    expect(invalid.stdout).toContain("missing-environment-binding");

    const unknown = await invoke(["environment-bindings", "--environment", "staging"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});