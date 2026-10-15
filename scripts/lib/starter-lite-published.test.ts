import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStarterLite } from "./starter-lite";

test("published runtime loading fails closed without creating a workspace-backed database", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-published-runtime-"));
  try {
    const signal = new AbortController().signal;
    await expect(startStarterLite(join(root, "database"), signal, undefined,
      join(root, "missing.ts"))).rejects.toThrow();
    const invalid = join(root, "invalid.ts");
    await writeFile(invalid, "export const unrelated = true;\n");
    await expect(startStarterLite(join(root, "database"), signal, undefined, invalid)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["invalid.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
