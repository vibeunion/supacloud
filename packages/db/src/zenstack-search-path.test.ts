import { expect, test } from "bun:test";
import { isSafeDefinerSearchPath } from "./search-path";

test("SECURITY DEFINER search_path validation rejects dynamic and empty entries", () => {
  expect(isSafeDefinerSearchPath(["search_path=public"])).toBe(true);
  for (const config of [
    ["search_path=public, pg_temp"], ["search_path=public, PG_TEMP"],
    ["search_path=public, \"PG_TEMP\""], ["search_path=public, $user"],
    ["search_path=public, \"$USER\""], ["search_path=public, "],
  ]) expect(isSafeDefinerSearchPath(config)).toBe(false);
});
