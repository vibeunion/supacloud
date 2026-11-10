import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseSources, type DatabaseSourcesConfig } from "./source-contracts";
import { emitPolicyRls, PolicyRlsError, policyRlsDivergence } from "./policy-rls";
import { modelCommandTemplateFiles } from "../../cli/src/shared/tools/app-model-command-starter";
import { compileModel } from "../../db-zenstack/src/model";

const orders = `datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
plugin policy {
  provider = "@zenstackhq/plugin-policy"
}
type Principal {
  id String
  tenantId String
  canApprove Boolean
  @@auth()
}
model Order {
  tenantId String @map("tenant_id")
  id String @id
  @@map("model_orders")
  @@allow("read", auth() != null && tenantId == auth().tenantId)
  @@deny("update", tenantId != auth().tenantId)
}
`;

test("emits authenticated RLS from row policy and fails closed on relations", () => {
  const emitted = emitPolicyRls(orders);
  expect(emitted.role).toBe("authenticated");
  expect(emitted.statements.some(statement => statement.includes('CREATE POLICY "model_orders_select"'))).toBe(true);
  expect(emitted.statements.some(statement => statement.includes("AS RESTRICTIVE") && statement.includes('FOR UPDATE'))).toBe(true);
  expect(emitted.sql).toContain("auth.jwt()");
  expect(emitted.sql).not.toContain("model_orders_app");
  const relation = `type Principal { id String @@auth() }
model Review {
  id String @id
  ownerId String
  @@allow("read", auth() != null)
}
model Attachment {
  id String @id
  review Review
  @@allow("read", review.ownerId == auth().id)
}
`;
  expect(() => emitPolicyRls(relation)).toThrow(PolicyRlsError);
  expect(() => emitPolicyRls(`model Note { id String @id @@allow("read", now() == 1) }`)).toThrow(/cannot be emitted/);
  expect(() => emitPolicyRls(orders, { role: "ModelOrders" })).toThrow(PolicyRlsError);
});

test("migration divergence ignores host policies and fails when the projection changes", () => {
  const emitted = emitPolicyRls(orders);
  const host = `CREATE POLICY model_orders_host ON public.model_orders TO model_orders_app USING (true);`;
  expect(policyRlsDivergence(emitted, [host, ...emitted.statements])).toEqual([]);
  expect(policyRlsDivergence(emitted, [emitted.statements.join("\n").replace("tenantId", "tenant")])).not.toEqual([]);
  const spaced = emitted.statements.map(statement => statement.replaceAll(" ", "\n  ")).join("\n");
  expect(policyRlsDivergence(emitted, [spaced])).toEqual([]);
});

test("source contract check fails closed without writing and accepts a matching ledger", async () => {
  const adapter = join(import.meta.dir, "../node_modules/@supacloud");
  await mkdir(adapter, { recursive: true });
  await symlink(join(import.meta.dir, "../../db-zenstack"), join(adapter, "db-zenstack"), "dir").catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const root = await mkdtemp(join(tmpdir(), "policy-rls-"));
  const emitted = emitPolicyRls(orders);
  const config: DatabaseSourcesConfig = {
    version: 1, schema: ["zenstack/schema.zmodel"], functions: "db/functions", migrations: "migrations",
    contracts: "db/contracts", audit: "output/database-audit", consumers: ["src"], auditConsumers: [],
    trustedHosts: ["src/host"], role: "service_role",
  };
  const write = async (path: string, text: string) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  try {
    await write("database.sources.json", JSON.stringify(config));
    await write("zenstack/schema.zmodel", orders);
    await write("migrations/001.sql", "SELECT 1;");
    await write("src/host/db.ts", "export const host = true;\n");
    const functionSql = `CREATE FUNCTION public.lookup(p_id bigint, p_values numeric[] DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE ALL ON FUNCTION public.lookup(bigint,numeric[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup(bigint,numeric[]) TO service_role;`;
    await write("db/functions/lookup.sql", functionSql);
    await compileModel(join(root, "zenstack/schema.zmodel"), join(root, "zenstack/generated"));
    const blocked = await databaseSources(root, "generate");
    expect(blocked.ok).toBe(false);
    expect(blocked.written).toEqual([]);
    expect(blocked.findings.some(item => item.code === "policy-rls-mismatch")).toBe(true);
    expect(blocked.findings.some(item => item.code === "function-contract")).toBe(false);
    await write("migrations/002.sql", `${emitted.statements.join("\n")}\n`);
    await compileModel(join(root, "zenstack/schema.zmodel"), join(root, "zenstack/generated"));
    const generated = await databaseSources(root, "generate");
    expect(generated.findings.filter(item => item.code.startsWith("policy-rls"))).toEqual([]);
    expect(generated.ok).toBe(true);
    expect(generated.written).toContain("db/contracts/policy-rls.sql");
    const artifact = await readFile(join(root, "db/contracts/policy-rls.sql"), "utf8");
    expect(artifact).toContain('CREATE POLICY "model_orders_select"');
    await write("zenstack/schema.zmodel", orders.replace("tenantId == auth().tenantId", "false"));
    await compileModel(join(root, "zenstack/schema.zmodel"), join(root, "zenstack/generated"));
    const drifted = await databaseSources(root, "check");
    expect(drifted.ok).toBe(false);
    expect(drifted.findings.some(item => item.code === "policy-rls-mismatch")).toBe(true);
    expect(await readFile(join(root, "migrations/002.sql"), "utf8")).toContain('CREATE POLICY "model_orders_select"');
    await write("database.sources.json", JSON.stringify({ ...config, policyRls: "deferred" }));
    await write("zenstack/schema.zmodel", `type Principal { id String @@auth() }
model Note {
  id String @id
  review Order
  @@allow("read", review.id == auth().id)
}
`);
    const deferred = await databaseSources(root, "check");
    expect(deferred.findings.some(item => item.code.startsWith("policy-rls"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model-command migration contains the emitted authenticated projection", () => {
  const files = modelCommandTemplateFiles("orders", { "@supacloud/js": "0.0.0", "@supabase/supabase-js": "0.0.0" });
  const emitted = emitPolicyRls(files["zenstack/schema.zmodel"] ?? "");
  const migration = files["migrations/002-model-orders.sql"] ?? "";
  expect(policyRlsDivergence(emitted, [migration])).toEqual([]);
  expect(migration).toContain("model_orders_host");
  expect(files["db/modules.ts"]).toContain("model_orders_select");
  expect(files["database.sources.json"]).not.toContain("policyRls");
});
