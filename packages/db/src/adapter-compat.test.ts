import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const adapterAvailable = (() => {
  try {
    Bun.resolveSync("@supacloud/db-zenstack", import.meta.dir);
    return true;
  } catch {
    return false;
  }
})();

test("db compatibility paths declare the ZenStack adapter re-exports", () => {
  const zenstack = readFileSync(join(import.meta.dir, "zenstack.ts"), "utf8");
  const model = readFileSync(join(import.meta.dir, "model.ts"), "utf8");
  expect(zenstack).toContain('from "@supacloud/db-zenstack"');
  expect(zenstack).toContain("createZenStackDatabase");
  expect(model).toContain('from "@supacloud/db-zenstack/model"');
  expect(model).toContain("compileModel");
});

test.skipIf(!adapterAvailable)("db compatibility paths re-export the ZenStack adapter", async () => {
  const [{ createZenStackDatabase: fromPackage }, { compileModel: compileFromPackage }] = await Promise.all([
    import("@supacloud/db-zenstack"),
    import("@supacloud/db-zenstack/model"),
  ]);
  const [{ createZenStackDatabase: fromCompat }, { compileModel: compileFromCompat }] = await Promise.all([
    import("./zenstack"),
    import("./model"),
  ]);
  expect(fromCompat).toBe(fromPackage);
  expect(compileFromCompat).toBe(compileFromPackage);
});
