import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appStarterFiles } from "./app-starter";

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
    const sdk = join(cli, "../supacloud-js");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noPropertyAccessFromIndexSignature: true, skipLibCheck: true, noEmit: true,
        types: ["bun"], typeRoots: [join(cli, "node_modules/@types")],
        paths: {
          "@supabase/supabase-js": [join(sdk, "node_modules/@supabase/supabase-js")],
          "@supacloud/js/contracts": [join(cli, "../contracts/src/authenticated_fetch.ts")],
        },
      }, include: ["src/client/*.ts", "tests/review-client.test.ts"],
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
