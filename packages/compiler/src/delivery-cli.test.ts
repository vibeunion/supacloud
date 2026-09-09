import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import { parseDeliveryPlanResult } from "./delivery-schema";
import { planDeliveryProject } from "./delivery-plan";

let root: string;
const cli = join(import.meta.dir, "cli.ts");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "supacloud-delivery-"));
  await writeFixtureProject(root, {
    ...GOOD_PROJECT_FILES,
    "supacloud.config.ts": `export default {
      root: ".", outDir: "generated", strict: false, requireRouteContracts: false,
      generateClient: false, generatePermissions: false, treeShakeUnusedProviders: false,
    };`,
    "invalid.json": JSON.stringify({ version: 1, secret: "DO_NOT_ECHO_THIS" }),
    "invalid-syntax.json": "{ DO_NOT_ECHO_THIS",
    "valid.json": JSON.stringify({ version: 1 }),
  });
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
}, 30_000);

async function run(args: string[]) {
  const process = Bun.spawn([Bun.argv[0] ?? "bun", cli, "plan", ...args, "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  const code = await process.exited;
  const wire: unknown = JSON.parse(stdout);
  return { result: parseDeliveryPlanResult(wire), stdout, stderr, code };
}

test("CLI plans an uncompiled project and writes nothing", async () => {
  const result = await run([]);
  expect(result.result.diagnostics).toEqual([]);
  expect(result.code).toBe(0);
  expect(result.result.ok).toBe(true);
  expect(result.stderr).toBe("");
  expect(existsSync(join(root, "generated"))).toBe(false);
  expect((await run(["--delivery", "valid.json"])).result).toEqual(result.result);
}, 30_000);

test.each([
  ["--delivery", "invalid.json"], ["--delivery", "invalid-syntax.json"],
  ["--delivery", "missing.json"], ["--delivery"],
  ["--write"], ["--unknown-option"],
  ["--root"], ["--out", "--json"], ["--url", "https://unverified.example.test"],
].map((args) => ({ args })))("CLI returns structured failures and nonzero status: %#", async ({ args }) => {
  const result = await run(args);
  expect(result.code).toBe(1);
  expect(result.result.ok).toBe(false);
  expect(result.result.plan).toBeNull();
  expect(result.stdout + result.stderr).not.toContain("DO_NOT_ECHO_THIS");
  expect(existsSync(join(root, "generated"))).toBe(false);
}, 30_000);

test("planning preserves existing generated content and propagates compiler failures", async () => {
  await writeFixtureProject(root, { "generated/application.ts": "// last good artifact\n" });
  const result = await planDeliveryProject({
    rootDir: root, outDir: join(root, "generated"), strict: false,
  });
  expect(result.ok).toBe(true);
  expect(await readFile(join(root, "generated/application.ts"), "utf8")).toBe("// last good artifact\n");
  const controller = Object.entries(GOOD_PROJECT_FILES).find(([, source]) => source.includes("response: AcceptResult,"));
  if (!controller) throw new Error("Expected controller fixture");
  await writeFixtureProject(root, { [controller[0]]: controller[1].replace("response: AcceptResult,", "") });
  const rejected = await planDeliveryProject({
    rootDir: root, outDir: join(root, "generated"), requireRouteContracts: true,
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.plan).toBeNull();
  expect(rejected.written).toEqual([]);
}, 30_000);
