import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appStarterFiles } from "./app-starter";

const { checkStarterDependencies }: {
  checkStarterDependencies(manifest: unknown, runNpm?: (args: string[]) => Promise<string>): Promise<Record<string, string[]>>;
} = await import(new URL("../../../scripts/check-starter-dependencies.mjs", import.meta.url).href);

test("the CLI release gate resolves the emitted framework dependencies without local substitutes", async () => {
  const manifest: unknown = JSON.parse(appStarterFiles("release-reference")["package.json"]!);
  const requests: string[][] = [];
  const versions = await checkStarterDependencies(manifest, async args => {
    requests.push(args);
    return JSON.stringify(["0.42.0", "0.42.1"]);
  });
  expect(Object.keys(versions).sort()).toEqual([
    "@supacloud/app", "@supacloud/commands", "@supacloud/compiler", "@supacloud/contracts",
    "@supacloud/db", "@supacloud/elysia", "@supacloud/js",
  ]);
  expect(requests).toHaveLength(7);
  for (const args of requests) {
    expect(args[0]).toBe("view");
    expect(args.slice(2)).toEqual(["version", "--json", "--registry=https://registry.npmjs.org"]);
  }
  for (const response of ["[]", "null", "{}", '"latest"', "not-json"]) {
    await expect(checkStarterDependencies(manifest, async () => response)).rejects.toThrow("not confirmed in npm");
  }
  await expect(checkStarterDependencies(manifest, async () => { throw new Error("E404"); }))
    .rejects.toThrow("Publish the compatible package set before the CLI");
  await expect(checkStarterDependencies({
    dependencies: { "@supacloud/js": "file:../supacloud-js" }, devDependencies: {},
  }, async () => { throw new Error("Must not query a local override"); })).rejects.toThrow("Invalid registry dependency");
});

test("the emitted client reference executes its behavior tests without a UI framework", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-client-"));
  try {
    const files = appStarterFiles("reference");
    for (const path of ["src/client/reviews.ts", "src/client/review-transport.ts", "tests/review-client.test.ts"]) {
      const content = files[path];
      expect(content).toBeDefined();
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content!);
    }
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", "tests/review-client.test.ts"], {
      cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ code, failure: code ? output : "" }).toEqual({ code: 0, failure: "" });
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
    const cli = fileURLToPath(new URL("../../../", import.meta.url));
    await copyFile(new URL("../../../../../scripts/fixtures/starter-browser-client.fixture", import.meta.url),
      join(root, "tests/starter-browser-client.ts"));
    await copyFile(new URL("../../../../../scripts/fixtures/starter-browser-session.fixture", import.meta.url),
      join(root, "tests/starter-browser-session.ts"));
    await writeFile(join(root, "tests/sdk-types.ts"), [
      'import type { SupabaseClient } from "@supabase/supabase-js";',
      'import type { ReviewSupabaseClient } from "../src/client/review-transport";',
      "export function acceptExistingClient(client: SupabaseClient): ReviewSupabaseClient { return client; }",
    ].join("\n"));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noPropertyAccessFromIndexSignature: true, skipLibCheck: true, noEmit: true,
        allowJs: true, checkJs: true,
        types: ["bun"], typeRoots: [join(cli, "node_modules/@types")],
        paths: {
          "@supabase/supabase-js": [join(cli, "node_modules/@supabase/supabase-js")],
          "@supacloud/js/contracts": [join(cli, "../contracts/src/authenticated_fetch.ts")],
        },
      }, include: ["src/client/*.ts", "tests/review-client.test.ts", "tests/sdk-types.ts", "tests/starter-browser-client.ts",
        join(cli, "scripts/check-starter-dependencies.mjs")],
    }));
    const types = Bun.spawn([process.execPath, join(cli, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const typeTimer = setTimeout(() => types.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        types.exited, new Response(types.stdout).text(), new Response(types.stderr).text(),
      ]);
      expect({ code, failure: code ? stdout + stderr : "" }).toEqual({ code: 0, failure: "" });
    } finally { clearTimeout(typeTimer); if (types.exitCode === null) { types.kill(); await types.exited; } }
  } finally { await rm(root, { recursive: true, force: true }); }
});
