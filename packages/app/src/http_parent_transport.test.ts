import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HttpClientCore, HttpErrorResponse, delegateHttpRequestsToParent } from "./http_client_core";
import { HttpContext, HttpContextToken } from "./http_context";
import { HttpReplayError } from "./http_replay";
import type { HttpInterceptorFn } from "./interceptor";

const transport = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;
const twice: HttpInterceptorFn = async (request, next) => { await next(request); return next(request); };

function trace(name: string, events: string[]): HttpInterceptorFn {
  return async (request, next) => {
    events.push(`${name}:in`);
    try { return await next(request); }
    finally { events.push(`${name}:out`); }
  };
}

test("parent HTTP delegation runs local then ancestor interceptors exactly once", async () => {
  const events: string[] = [];
  const root = new HttpClientCore({ fetch: transport(async () => {
    events.push("fetch"); return Response.json({ ok: true });
  }) }, [trace("root", events)]);
  const middle = new HttpClientCore({}, [trace("middle", events)]);
  const child = new HttpClientCore({}, [trace("child", events)]);
  delegateHttpRequestsToParent(middle, root);
  delegateHttpRequestsToParent(child, middle);
  assert.deepEqual(await child.get("https://fixture.test/item"), { ok: true });
  assert.deepEqual(events, ["child:in", "middle:in", "root:in", "fetch", "root:out", "middle:out", "child:out"]);
});

test("parent HTTP delegation preserves context identity, headers, query and body", async () => {
  const context = new HttpContext();
  const token = new HttpContextToken(() => ({ count: 0 }));
  const owner = new AbortController();
  let sends = 0;
  const parent = new HttpClientCore({ baseUrl: "https://fixture.test/api", fetch: transport(async (input, init) => {
    sends++;
    assert.equal(input, "https://fixture.test/api/items?q=a%20b");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, '{"id":7}');
    assert.equal(new Headers(init?.headers).get("x-parent"), "yes");
    assert.equal(new Headers(init?.headers).get("x-child"), "yes");
    assert.equal(init?.signal, owner.signal);
    assert.equal(init?.redirect, "error");
    return Response.json({ done: true });
  }) }, [async (request, next) => {
    assert.equal(request.context, context);
    assert.equal(request.signal, owner.signal);
    assert.equal(request.context?.get(token).count, 1);
    return next({ ...request, headers: { ...request.headers, "x-parent": "yes" } });
  }]);
  const child = new HttpClientCore({}, [async (request, next) => {
    request.context!.get(token).count++;
    return next({ ...request, headers: { ...request.headers, "x-child": "yes" } });
  }]);
  delegateHttpRequestsToParent(child, parent);
  assert.deepEqual(await child.post("items", { id: 7 }, { params: { q: "a b" }, context, signal: owner.signal }), { done: true });
  assert.equal(sends, 1);
});

test("the leaf decodes response bodies only after parent interceptors finish", async () => {
  const response = new Response("plain body", { status: 200 });
  const parent = new HttpClientCore({ fetch: transport(async () => response) }, [async (req, next) => {
    const result = await next(req);
    assert.equal(result.bodyUsed, false);
    return result;
  }]);
  const child = new HttpClientCore();
  delegateHttpRequestsToParent(child, parent);
  assert.equal(await child.get("https://fixture.test", { responseType: "text" }), "plain body");
});

test("observe response preserves native response identity and non-2xx envelopes", async () => {
  const response = Response.json({ reason: "denied" }, { status: 403 });
  const parent = new HttpClientCore({ fetch: transport(async () => response) });
  const child = new HttpClientCore();
  delegateHttpRequestsToParent(child, parent);
  assert.equal(await child.get("https://fixture.test", { observe: "response" }), response);
  assert.equal(response.bodyUsed, false);
});

test("body observation still reports a typed HTTP error from the parent", async () => {
  const parent = new HttpClientCore({ fetch: transport(async () => Response.json({ denied: true }, { status: 403 })) });
  const child = new HttpClientCore();
  delegateHttpRequestsToParent(child, parent);
  await assert.rejects(child.get("https://fixture.test"), error => {
    assert.ok(error instanceof HttpErrorResponse);
    assert.equal(error.status, 403);
    assert.deepEqual(error.error, { denied: true });
    return true;
  });
});

for (const repeatedAt of ["child", "parent"] as const) {
  test(`parent HTTP delegation blocks a repeated write from the ${repeatedAt} pipeline`, async () => {
    let sends = 0;
    const parent = new HttpClientCore({ fetch: transport(async () => { sends++; return Response.json({ ok: true }); }) }, repeatedAt === "parent" ? [twice] : []);
    const child = new HttpClientCore({}, repeatedAt === "child" ? [twice] : []);
    delegateHttpRequestsToParent(child, parent);
    await assert.rejects(child.post("https://fixture.test", { id: 1 }), HttpReplayError);
    assert.equal(sends, 1);
  });
}

test("a child interceptor cannot upgrade the caller's write replay policy", async () => {
  let sends = 0;
  const parent = new HttpClientCore({ fetch: transport(async () => { sends++; return Response.json({}); }) }, [twice]);
  const child = new HttpClientCore({}, [async (req, next) => next({
    ...req, replay: { mode: "idempotent", idempotencyKey: "invented" },
  })]);
  delegateHttpRequestsToParent(child, parent);
  await assert.rejects(child.post("https://fixture.test", {}), HttpReplayError);
  assert.equal(sends, 1);
});

test("explicit idempotent replay preserves the same body and key through a parent", async () => {
  const bodies: unknown[] = [];
  const parent = new HttpClientCore({ fetch: transport(async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "request-1");
    bodies.push(init?.body);
    return Response.json({ ok: true });
  }) });
  const child = new HttpClientCore({}, [twice]);
  delegateHttpRequestsToParent(child, parent);
  await child.post("https://fixture.test", { id: 1 }, { replay: { mode: "idempotent", idempotencyKey: "request-1" } });
  assert.deepEqual(bodies, ['{"id":1}', '{"id":1}']);
});

test("explicit never-replay also applies to reads delegated to a parent", async () => {
  let sends = 0;
  const parent = new HttpClientCore({ fetch: transport(async () => { sends++; return Response.json({}); }) });
  const child = new HttpClientCore({}, [twice]);
  delegateHttpRequestsToParent(child, parent);
  await assert.rejects(child.get("https://fixture.test", { replay: { mode: "never" } }), HttpReplayError);
  assert.equal(sends, 1);
});

test("owner cancellation before transport prevents parent I/O", async () => {
  let sends = 0;
  const parent = new HttpClientCore({ fetch: transport(async () => { sends++; return Response.json({}); }) });
  const child = new HttpClientCore();
  delegateHttpRequestsToParent(child, parent);
  const owner = new AbortController();
  owner.abort();
  await assert.rejects(child.get("https://fixture.test", { signal: owner.signal }), { name: "AbortError" });
  assert.equal(sends, 0);
});

test("the original owner signal reaches in-flight parent I/O even if an interceptor replaces it", async () => {
  const owner = new AbortController();
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const parent = new HttpClientCore({ fetch: transport(async (_input, init) => {
    assert.equal(init?.signal, owner.signal);
    start();
    return new Promise((_resolve, reject) => {
      owner.signal.addEventListener("abort", () => reject(owner.signal.reason), { once: true });
    });
  }) });
  const child = new HttpClientCore({}, [async (req, next) => next({ ...req, signal: new AbortController().signal })]);
  delegateHttpRequestsToParent(child, parent);
  const pending = child.get("https://fixture.test", { signal: owner.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started;
  owner.abort();
  await rejected;
});

test("concurrent children retain distinct request contexts through a shared parent", async () => {
  const token = new HttpContextToken(() => ({ value: "unset" }));
  const seen: string[] = [];
  const parent = new HttpClientCore({ fetch: transport(async () => Response.json({})) }, [async (req, next) => {
    await Promise.resolve();
    seen.push(req.context!.get(token).value);
    return next(req);
  }]);
  const a = new HttpClientCore(), b = new HttpClientCore();
  delegateHttpRequestsToParent(a, parent);
  delegateHttpRequestsToParent(b, parent);
  await Promise.all([
    a.get("https://fixture.test/a", { context: new HttpContext().set(token, { value: "a" }) }),
    b.get("https://fixture.test/b", { context: new HttpContext().set(token, { value: "b" }) }),
  ]);
  assert.deepEqual(seen.sort(), ["a", "b"]);
});

test("HTTP delegation rejects cycles before any request is started", () => {
  const a = new HttpClientCore(), b = new HttpClientCore(), c = new HttpClientCore();
  assert.throws(() => delegateHttpRequestsToParent(a, a), /cycle/);
  delegateHttpRequestsToParent(a, b);
  delegateHttpRequestsToParent(b, c);
  assert.throws(() => delegateHttpRequestsToParent(c, a), /cycle/);
});

test("a parent changing a read into a write cannot bypass the outer replay budget", async () => {
  let sends = 0;
  const parent = new HttpClientCore({ fetch: transport(async () => { sends++; return Response.json({}); }) }, [
    async (request, next) => next({ ...request, method: "POST", body: "{}" }),
  ]);
  const child = new HttpClientCore({}, [twice]);
  delegateHttpRequestsToParent(child, parent);
  await assert.rejects(child.get("https://fixture.test"), HttpReplayError);
  assert.equal(sends, 1);
});
