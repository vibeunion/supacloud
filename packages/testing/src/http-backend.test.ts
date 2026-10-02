import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHttpTestBackend } from "./http-backend";

test("captures real Request bodies and flushes native Responses", async () => {
  const backend = createHttpTestBackend();
  const result = backend.fetch("https://fixture.test/orders", { method: "POST", body: JSON.stringify({ id: 7 }) });
  const captured = backend.expectOne(request => request.method === "POST");
  assert.deepEqual(await captured.request.json(), { id: 7 });
  captured.flush({ accepted: true }, { status: 202 });
  assert.equal((await result).status, 202);
  backend.verify(); backend.dispose();
});
test("matched but unflushed requests fail verification", async () => {
  const backend = createHttpTestBackend();
  const result = backend.fetch("https://fixture.test/orders");
  const request = backend.expectOne("https://fixture.test/orders");
  assert.throws(() => backend.verify(), /unsettled/);
  request.respond(new Response(null, { status: 204 }));
  await result;
  backend.verify();
  assert.throws(() => request.flush({}), /settled/);
});
test("duplicate requests cannot accidentally satisfy expectOne", async () => {
  const backend = createHttpTestBackend();
  const pending = [backend.fetch("https://fixture.test/a"), backend.fetch("https://fixture.test/a")];
  assert.throws(() => backend.expectOne("https://fixture.test/a"), /found 2/);
  assert.throws(() => backend.expectNone("https://fixture.test/a"), /Unexpected/);
  for (const request of backend.match("https://fixture.test/a")) request.flush({});
  await Promise.all(pending); backend.verify();
});
test("cancellation is delivered to the real fetch request", async () => {
  const backend = createHttpTestBackend();
  const owner = new AbortController();
  const result = backend.fetch("https://fixture.test/a", { signal: owner.signal });
  const rejection = assert.rejects(result, error => error instanceof Error && error.name === "AbortError");
  const request = backend.expectOne("https://fixture.test/a");
  owner.abort(); await rejection;
  assert.equal(request.cancelled, true); backend.verify();
});
test("unmatched cancellations require an explicit verification policy", async () => {
  const backend = createHttpTestBackend();
  const signal = AbortSignal.abort();
  await assert.rejects(backend.fetch("https://fixture.test/a", { signal }));
  assert.throws(() => backend.verify(), /unmatched/);
  backend.verify({ ignoreCancelled: true });
});
test("network failures preserve the original exception", async () => {
  const backend = createHttpTestBackend();
  const failure = new TypeError("synthetic transport failure");
  const pending = backend.fetch("https://fixture.test/a");
  backend.expectOne("https://fixture.test/a").error(failure);
  await assert.rejects(pending, error => error === failure); backend.verify();
});
test("dispose rejects unsettled requests and future requests", async () => {
  const backend = createHttpTestBackend();
  const pending = backend.fetch("https://fixture.test/a");
  backend.expectOne("https://fixture.test/a");
  backend.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(backend.fetch("https://fixture.test/b"), /disposed/);
  backend.verify(); backend.dispose();
});
test("bounded bookkeeping fails before unexpected extra requests", async () => {
  const backend = createHttpTestBackend({ capacity: 1 });
  const pending = backend.fetch("https://fixture.test/a");
  await assert.rejects(backend.fetch("https://fixture.test/b"), /capacity/);
  backend.expectOne("https://fixture.test/a").flush({}); await pending; backend.verify();
});
