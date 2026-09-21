import { expect, test } from "bun:test";
import { parseRlsPolicies, parsePolicyNames, type RlsPolicy } from "./auth-policies";

const policy = {
  policyname: "read", tablename: "items", schemaname: "public",
  cmd: "SELECT", roles: null, permissive: "PERMISSIVE", qual: null,
} satisfies RlsPolicy;

test("decodes real nullable PostgreSQL policy fields without fabricating strings", () => {
  expect(parseRlsPolicies([policy])).toEqual([policy]);
  expect(parseRlsPolicies([{ ...policy, qual: "(owner = auth.uid())", roles: "authenticated" }]))
    .toMatchObject([{ qual: "(owner = auth.uid())", roles: "authenticated" }]);
});

test("rejects malformed policy fields and unknown action enums", () => {
  for (const patch of [{ policyname: 1 }, { roles: [] }, { qual: undefined },
    { cmd: "DROP" }, { permissive: true }, { tablename: null }, { schemaname: null }]) {
    expect(() => parseRlsPolicies([{ ...policy, ...patch }])).toThrow("Invalid RLS policy response");
  }
});

test("policy metadata names must be strings", () => {
  expect(parsePolicyNames([{ tablename: "items" }], "tablename")).toEqual(["items"]);
  expect(parsePolicyNames([{ rolname: "role with spaces" }], "rolname")).toEqual(["role with spaces"]);
  expect(() => parsePolicyNames([{ tablename: 1 }], "tablename")).toThrow("Invalid RLS metadata response");
  expect(() => parsePolicyNames([{}], "rolname")).toThrow("Invalid RLS metadata response");
});
