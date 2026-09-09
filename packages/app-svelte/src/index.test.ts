import { expect, test } from "bun:test";
import { createSvelteCommandScope } from "./index";

test("Svelte scope registration fails outside a component instead of leaking a global lifetime", () => {
  expect(() => createSvelteCommandScope()).toThrow();
  let subscriptions = 0;
  expect(() => createSvelteCommandScope({
    target: { subscribe: () => { subscriptions++; return () => {}; } },
  })).toThrow();
  expect(subscriptions).toBe(0);
});
