import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqlImpactFile } from "./sql-impact-cli";

test("impact review approval is bound to a deterministic digest and cannot approve rewritten history", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-impact-"));
  try {
    const migration = join(root, "001.sql"), path = join(root, "impact.json");
    await writeFile(migration, "CREATE TABLE public.orders(id integer PRIMARY KEY)");
    const config = { migrations: [{ id: "001", owner: "orders", path: "001.sql" }] };
    await writeFile(path, JSON.stringify(config));
    const first = await runSqlImpactFile(path);
    expect(first.ok).toBe(false);
    expect(first.review).toContain("No live catalog snapshot supplied; verify deployed dependencies before applying");
    await writeFile(path, JSON.stringify({ ...config, approvedDigest: first.digest }));
    expect((await runSqlImpactFile(path)).ok).toBe(true);
    await writeFile(migration, "DROP TABLE public.orders");
    expect((await runSqlImpactFile(path)).approved).toBe(false);
    const changed = { ...config, baseline: first.migrations.map(({ id, sha256 }) => ({ id, sha256 })) };
    await writeFile(path, JSON.stringify(changed));
    const plan = await runSqlImpactFile(path);
    await writeFile(path, JSON.stringify({ ...changed, approvedDigest: plan.digest }));
    expect((await runSqlImpactFile(path)).ok).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
