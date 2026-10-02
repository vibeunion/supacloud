import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createEnvironmentInjector } from "./inject";
import { HttpClient, HTTP_CLIENT_CONFIG, provideHttpClient, withFetch, withInterceptors, withRequestsMadeViaParent } from "./http_client";
import type { HttpInterceptorFn } from "./interceptor";

const transport = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

for (const reverse of [false, true]) {
  test(`HTTP rejects competing local/parent transports in either order (${reverse})`, () => {
    const choices = [withFetch(), withRequestsMadeViaParent()];
    assert.throws(() => provideHttpClient(...(reverse ? choices.reverse() : choices)), /cannot be combined/);
  });
}

test("HTTP rejects duplicate transport features rather than silently ignoring one", () => {
  assert.throws(() => provideHttpClient(withFetch(), withFetch()), /only once/);
  assert.throws(() => provideHttpClient(withRequestsMadeViaParent(), withRequestsMadeViaParent()), /only once/);
});

test("parent delegation without a configured parent fails during provider resolution", async () => {
  const injector = createEnvironmentInjector([provideHttpClient(withRequestsMadeViaParent())], undefined, { initialize: false });
  try { assert.throws(() => injector.get(HttpClient), /requires a configured parent/); }
  finally { await injector.destroyAsync(); }
});

test("configured HTTP provider failures are not swallowed by constructor defaults", async () => {
  const failure = new Error("configuration unavailable");
  const injector = createEnvironmentInjector([
    provideHttpClient(),
    { provide: HTTP_CLIENT_CONFIG, useFactory: () => { throw failure; } },
  ], undefined, { initialize: false });
  try { assert.throws(() => injector.get(HttpClient), error => error === failure); }
  finally { await injector.destroyAsync(); }
});

test("HTTP provider delegation resolves the nearest ancestor through an empty injector", async () => {
  const events: string[] = [];
  const named = (name: string): HttpInterceptorFn => async (req, next) => {
    events.push(name);
    return next(req);
  };
  const root = createEnvironmentInjector([
    provideHttpClient(withFetch(transport(async () => { events.push("fetch"); return Response.json({ ok: true }); })), withInterceptors(named("root"))),
  ], undefined, { initialize: false });
  const middle = createEnvironmentInjector([], root, { initialize: false });
  const child = createEnvironmentInjector([
    provideHttpClient(withRequestsMadeViaParent(), withInterceptors(named("child-a")), withInterceptors(named("child-b"))),
  ], middle, { initialize: false });
  try {
    assert.deepEqual(await child.get(HttpClient).get("https://fixture.test"), { ok: true });
    assert.deepEqual(events, ["child-a", "child-b", "root", "fetch"]);
  } finally {
    await child.destroyAsync();
    await middle.destroyAsync();
    await root.destroyAsync();
  }
});

test("a child with no local interceptors does not run parent interceptors twice", async () => {
  let intercepts = 0, sends = 0;
  const root = createEnvironmentInjector([provideHttpClient(
    withFetch(transport(async () => { sends++; return Response.json({}); })),
    withInterceptors(async (req, next) => { intercepts++; return next(req); }),
  )], undefined, { initialize: false });
  const child = createEnvironmentInjector([provideHttpClient(withRequestsMadeViaParent())], root, { initialize: false });
  try {
    await child.get(HttpClient).get("https://fixture.test");
    assert.equal(intercepts, 1);
    assert.equal(sends, 1);
    await child.destroyAsync();
    assert.equal(root.destroyed, false);
    await root.get(HttpClient).get("https://fixture.test");
    assert.equal(sends, 2);
  } finally { await child.destroyAsync(); await root.destroyAsync(); }
});

test("a non-delegating HTTP child does not inherit parent transport or interceptors", async () => {
  let parentSends = 0, parentInterceptions = 0, childSends = 0;
  const root = createEnvironmentInjector([provideHttpClient(
    withFetch(transport(async () => { parentSends++; return Response.json({}); })),
    withInterceptors(async (req, next) => { parentInterceptions++; return next(req); }),
  )], undefined, { initialize: false });
  const child = createEnvironmentInjector([provideHttpClient(
    withFetch(transport(async () => { childSends++; return Response.json({ child: true }); })),
  )], root, { initialize: false });
  try {
    assert.deepEqual(await child.get(HttpClient).get("https://fixture.test"), { child: true });
    assert.equal(parentSends, 0);
    assert.equal(parentInterceptions, 0);
    assert.equal(childSends, 1);
  } finally { await child.destroyAsync(); await root.destroyAsync(); }
});
