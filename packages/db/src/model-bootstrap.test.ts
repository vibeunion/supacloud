import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BOOTSTRAP_MODEL_SCHEMA, compileModel } from "./model";
import { modelMain } from "./model-cli";
import { startStarterPostgres } from "../../../scripts/lib/starter-postgres";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "model-bootstrap-")); roots.push(root); return root; }

test("the bootstrap datasource compiles without a maintained model", async () => {
  const root = await temporary();
  const schema = join(root, "bootstrap.zmodel");
  await writeFile(schema, BOOTSTRAP_MODEL_SCHEMA);
  await compileModel(schema, join(root, "generated"));
  const prisma = await readFile(join(root, "generated/schema.prisma"), "utf8");
  expect(prisma).toContain('provider = "postgresql"');
  expect(prisma).toContain('env("DATABASE_URL")');
  expect(prisma).not.toMatch(/(?:directUrl|shadowDatabaseUrl)\s*=/);
});

test("adoption requires an explicit database and never writes maintained files", async () => {
  const root = await temporary();
  const schema = join(root, "zenstack/schema.zmodel");
  const candidate = join(root, "output/database-audit/adopted.zmodel");
  const previous = process.env["SUPACLOUD_MODEL_DATABASE_URL"];
  try {
    delete process.env["SUPACLOUD_MODEL_DATABASE_URL"];
    await expect(modelMain(["pull", "--schema", schema, "--candidate", candidate])).rejects.toThrow("SUPACLOUD_MODEL_DATABASE_URL");
    process.env["SUPACLOUD_MODEL_DATABASE_URL"] = "postgresql://readonly@127.0.0.1:1/unreachable";
    await expect(modelMain(["generate", "--schema", schema]))
      .rejects.toThrow(`Maintain ${schema} before generate`);
    await expect(modelMain(["check", "--schema", schema]))
      .rejects.toThrow(`Maintain ${schema} before check`);
    await expect(modelMain(["diff", "--schema", schema, "--candidate", join(root, "output/database-audit/change.sql")]))
      .rejects.toThrow(`Maintain ${schema} before diff`);
    await expect(modelMain(["pull", "--schema", schema, "--candidate", schema]))
      .rejects.toThrow("refusing to overwrite maintained files");
  } finally {
    if (previous === undefined) delete process.env["SUPACLOUD_MODEL_DATABASE_URL"];
    else process.env["SUPACLOUD_MODEL_DATABASE_URL"] = previous;
  }
  expect(existsSync(join(root, "zenstack"))).toBe(false);
  expect(existsSync(join(root, "output"))).toBe(false);
});

const postgresBin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
test.skipIf(!postgresBin)("pull adopts a live database without a maintained model", async () => {
  const server = await startStarterPostgres(postgresBin!);
  try {
    await server.exec('CREATE TABLE "Note" (id text PRIMARY KEY, owner text NOT NULL, value integer NOT NULL);');
    await server.withConnection(async url => {
      const root = await temporary();
      await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "model-cli.ts"), "pull",
        "--candidate", "output/database-audit/adopted.zmodel"], {
        cwd: root, env: { ...process.env, SUPACLOUD_MODEL_DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const diagnostics = (out + err).replaceAll(url, "[local database]").replaceAll(new URL(url).password, "[redacted]");
      expect(code, diagnostics).toBe(0);
      expect(out).toContain("does not exist yet");
      const candidate = await readFile(join(root, "output/database-audit/adopted.zmodel"), "utf8");
      expect(candidate).toContain("model Note");
      expect(candidate).toContain("provider = 'postgresql'");
      expect(existsSync(join(root, "zenstack"))).toBe(false);
    });
  } finally { await server.close(); }
}, 60_000);
