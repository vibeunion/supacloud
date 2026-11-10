import { expect, test } from "bun:test";
import { createZenStackDatabase as fromPackage } from "@supacloud/db-zenstack";
import { compileModel as compileFromPackage } from "@supacloud/db-zenstack/model";
import { createZenStackDatabase as fromCompat } from "./zenstack";
import { compileModel as compileFromCompat } from "./model";

test("db compatibility paths re-export the ZenStack adapter", () => {
  expect(fromCompat).toBe(fromPackage);
  expect(compileFromCompat).toBe(compileFromPackage);
});
