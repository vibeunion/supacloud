import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("optional SVAdmin helpers load without installing a Web Console dependency graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-svadmin-optional-"));
  try {
    const file = join(root, "starter-svadmin.ts");
    await copyFile(new URL("./starter-svadmin.ts", import.meta.url), file);
    const helper = await import(pathToFileURL(file).href) as {
      checkStarterSvadmin?: unknown; starterSvadminBundle?: unknown;
    };
    expect(typeof helper.checkStarterSvadmin).toBe("function");
    expect(typeof helper.starterSvadminBundle).toBe("function");
  } finally { await rm(root, { recursive: true, force: true }); }
});
