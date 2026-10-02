import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HttpContext, HttpContextToken } from "./http_context";

test("HTTP context materializes a mutable default once and exposes its key", () => {
  let calls = 0;
  const token = new HttpContextToken(() => { calls++; return { attempts: 0 }; });
  const context = new HttpContext();
  assert.equal(context.has(token), false);
  const value = context.get(token);
  value.attempts++;
  assert.equal(context.get(token), value);
  assert.equal(context.get(token).attempts, 1);
  assert.equal(calls, 1);
  assert.equal(context.has(token), true);
  assert.deepEqual([...context.keys()], [token]);
});

test("HTTP context caches undefined defaults instead of calling a factory again", () => {
  let calls = 0;
  const token = new HttpContextToken<undefined>(() => { calls++; return undefined; });
  const context = new HttpContext();
  assert.equal(context.get(token), undefined);
  assert.equal(context.get(token), undefined);
  assert.equal(context.has(token), true);
  assert.equal(calls, 1);
});

test("HTTP context explicit values bypass the factory, including undefined", () => {
  const token = new HttpContextToken<string | undefined>(() => { throw new Error("unused"); });
  const context = new HttpContext().set(token, undefined);
  assert.equal(context.get(token), undefined);
  assert.equal(context.set(token, "explicit").get(token), "explicit");
});

test("HTTP context deletion creates a fresh default on the next read", () => {
  const token = new HttpContextToken(() => ({}));
  const context = new HttpContext();
  const first = context.get(token);
  assert.equal(context.delete(token), context);
  assert.equal(context.has(token), false);
  assert.deepEqual([...context.keys()], []);
  assert.notEqual(context.get(token), first);
});

test("HTTP contexts do not share default state", () => {
  const token = new HttpContextToken(() => ({ attempts: 0 }));
  const first = new HttpContext();
  const second = new HttpContext();
  first.get(token).attempts++;
  assert.equal(second.get(token).attempts, 0);
  assert.notEqual(first.get(token), second.get(token));
});

test("HTTP context factory failures propagate without poisoning the cache", () => {
  const failure = new Error("factory failed");
  let calls = 0;
  const token = new HttpContextToken(() => {
    if (++calls === 1) throw failure;
    return "ready";
  });
  const context = new HttpContext();
  assert.throws(() => context.get(token), error => error === failure);
  assert.equal(context.has(token), false);
  assert.equal(context.get(token), "ready");
  assert.equal(calls, 2);
});
