import { expect, test } from "bun:test";
import * as protocol from "./index";
import * as client from "./client";
import * as browser from "./browser";

test("protocol, client and storage are separate entrypoints", async () => {
  expect(Object.hasOwn(protocol, "CommandError")).toBe(true);
  for (const key of ["createCommandScope", "createAuthenticatedFetch", "createDurableCommandLocks"]) {
    expect(Object.hasOwn(protocol, key)).toBe(false);
  }
  expect(Object.hasOwn(client, "createCommandScope")).toBe(true);
  expect(Object.hasOwn(client, "createAuthenticatedFetch")).toBe(true);
  expect(Object.hasOwn(client, "createDurableCommandLocks")).toBe(false);
  expect(Object.hasOwn(browser, "createDurableCommandLocks")).toBe(true);
  const build = await Bun.build({ entrypoints: [new URL("./index.ts", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  for (const output of build.outputs) {
    expect(await output.text()).not.toMatch(/AbortController|localStorage|navigator\.locks|createAuthenticatedFetch/);
  }
});

test("target invalidation aborts old work without destroying the reusable scope", () => {
  const scope = client.createCommandScope();
  const first = scope.begin("first");
  scope.invalidate();
  expect(first.signal.aborted).toBe(true);
  expect(first.commit(() => { throw new Error("stale"); })).toBe(false);
  expect(scope.destroyed).toBe(false);
  const next = scope.begin("next");
  expect(next.commit(() => {})).toBe(true);
  scope.destroy();
  expect(next.signal.aborted).toBe(true);
});
