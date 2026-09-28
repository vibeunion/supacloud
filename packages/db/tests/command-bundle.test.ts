import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("detached command bundle does not initialize the optional SQL parser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-command-bundle-"));
  try {
    const first = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/command-bun.ts")],
      outdir: join(directory, "package"),
      target: "bun",
      external: ["libpg-query"],
    });
    expect(first.success).toBe(true);
    const entry = join(directory, "entry.ts");
    await Bun.write(entry, `
      import { createBunCommandDatabase } from "./package/command-bun.js";
      const database = createBunCommandDatabase({
        begin: async (run) => run({ unsafe: async () => [{ value: 42 }] }),
      });
      const rows = await database.transaction(tx => tx.query("SELECT 42"));
      if (rows[0].value !== 42) throw new Error("Command transaction failed");
    `);
    const bundled = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "detached"),
      target: "bun",
      plugins: [{
        name: "unavailable-parser",
        setup(build) {
          build.onResolve({ filter: /^libpg-query$/ }, () => ({
            path: "parser", namespace: "unavailable-parser",
          }));
          build.onLoad({ filter: /.*/, namespace: "unavailable-parser" }, () => ({
            contents: `throw new Error("Parser must not initialize for command-only runtime");
              export const parse = () => {}; export const fingerprint = () => {};`,
            loader: "js",
          }));
        },
      }],
    });
    expect(bundled.success).toBe(true);
    const child = Bun.spawn([process.execPath, join(directory, "detached/entry.js")], {
      cwd: directory, stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
