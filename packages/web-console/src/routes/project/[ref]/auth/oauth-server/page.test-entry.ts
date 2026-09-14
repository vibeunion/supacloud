import { strictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import OAuthPage from "./+page.svelte";
import { page, notifications } from "./page.test-fixture.svelte";
import { oauthStatus, oauthClient, partialFailure } from "./oauth-server.test-fixtures";

const assert: { equal: typeof strictEqual; ok: typeof ok } = { equal: strictEqual, ok };
const originalFetch = globalThis.fetch;
function network(handler: (url: string, options: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) =>
    handler(String(input), options), originalFetch);
}
function text() { return document.body.textContent ?? ""; }
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(button =>
    button.getAttribute("aria-label") === label || button.title === label);
  if (!found) throw new Error(`Missing OAuth button: ${label}`);
  return found;
}
function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const field = document.querySelector(`[aria-label="${label}"]`);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) throw new Error(`Missing OAuth input: ${label}`);
  return field;
}
async function eventually(assertion: () => void) {
  const deadline = performance.now() + 4000;
  let error: unknown;
  do {
    try { assertion(); return; } catch (value) { error = value; }
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw error;
}
async function mounted(run: () => Promise<void>) {
  page.params.ref = "a";
  notifications.length = 0;
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(OAuthPage, { target });
  try { await run(); } finally { await unmount(component); target.remove(); }
}
async function change(ref: string | undefined) { page.params.ref = ref; await tick(); }
async function ready(ref = "a") {
  await tick();
  await eventually(() => {
    assert.ok(text().includes(`https://${ref}.example.test/auth/v1`));
    assert.equal(button("创建客户端").disabled, false);
  });
}
function fill() {
  const name = input("客户端名称"), redirects = input("回调地址");
  name.value = "App"; name.dispatchEvent(new Event("input", { bubbles: true }));
  redirects.value = "https://app.test/callback"; redirects.dispatchEvent(new Event("input", { bubbles: true }));
}
async function badResponses() {
  let status: unknown = oauthStatus("b");
  let clients: unknown = { clients: [] };
  let clientReads = 0;
  network(async url => {
    if (url.endsWith("/oauth-server")) return Response.json(status);
    clientReads++;
    return Response.json(clients);
  });
  await mounted(async () => {
    await eventually(() => assert.ok(text().includes("OAuth 配置暂时不可用")));
    assert.equal(document.querySelector('[title="复制 JWKS"]'), null);
    assert.equal(clientReads, 0);
    status = oauthStatus();
    clients = {};
    button("刷新 OAuth").click();
    await eventually(() => assert.ok(text().includes("客户端列表暂时不可用")));
    assert.equal(text().includes("尚无客户端"), false);
    assert.equal(button("创建客户端").disabled, true);
    assert.ok(text().includes("运行状态未验证"));
    clients = { clients: [] };
    button("重试客户端").click();
    await ready();
    assert.ok(text().includes("尚无客户端"));
    status = { ...oauthStatus(), token_endpoint: "javascript:alert(1)" };
    button("刷新 OAuth").click();
    await eventually(() => assert.ok(text().includes("OAuth 配置暂时不可用")));
    assert.equal(document.querySelector('[title="复制 JWKS"]'), null);
    assert.equal(text().includes("尚无客户端"), false);
  });
}
async function readRaces() {
  const late = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  let reads = 0;
  network(async (url, options) => {
    if (options.signal) signals.push(options.signal);
    if (url.endsWith("/oauth-server")) {
      if (++reads === 1) return late.promise;
      return Response.json(oauthStatus(url.includes("/b/") ? "b" : "a"));
    }
    return Response.json({ clients: [] });
  });
  await mounted(async () => {
    await eventually(() => assert.equal(reads, 1));
    await change("b"); await ready("b");
    await change("a"); await ready();
    let disposed = false;
    late.resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
    await eventually(() => assert.ok(disposed));
    assert.ok(signals[0]?.aborted);
    const count = reads;
    await change(undefined);
    await eventually(() => assert.ok(text().includes("OAuth 配置暂时不可用")));
    assert.equal(reads, count);
  });
}
async function creationAndSecrets() {
  const creation = Promise.withResolvers<Response>();
  let writes = 0, lists = 0;
  network(async (url, options) => {
    if (url.endsWith("/oauth-server")) return Response.json(oauthStatus());
    assert.equal(options.credentials, "same-origin");
    assert.equal(new Headers(options.headers).has("authorization"), false);
    if (options.method === "POST") {
      writes++;
      assert.equal(url, "/v1/projects/a/auth/oauth-clients");
      assert.equal(typeof options.body, "string");
      assert.ok(String(options.body).includes('"client_type":"confidential"'));
      assert.ok(String(options.body).includes('"client_name":"App"'));
      return creation.promise;
    }
    if (++lists > 1) return Response.json({ message: "private upstream detail" }, { status: 503 });
    return Response.json({ clients: [] });
  });
  await mounted(async () => {
    await ready();
    fill();
    button("创建客户端").click();
    button("创建客户端").click();
    await eventually(() => assert.equal(writes, 1));
    input("客户端名称").value = "New draft";
    input("客户端名称").dispatchEvent(new Event("input", { bubbles: true }));
    creation.resolve(Response.json({ ...oauthClient(), client_secret: "one-time-secret" }, { status: 201 }));
    await eventually(() => assert.ok(text().includes("one-time-secret") && text().includes("客户端列表暂时不可用")));
    assert.equal(input("客户端名称").value, "New draft");
    assert.equal(button("刷新 OAuth").disabled, true);
    assert.equal(button("创建客户端").disabled, true);
    assert.equal(text().includes("private upstream detail"), false);
    const copy = Promise.withResolvers<void>();
    let copies = 0;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText(value: string) { copies++; assert.equal(value, "one-time-secret"); return copy.promise; },
    } });
    notifications.length = 0;
    button("复制客户端密钥").click();
    button("复制客户端密钥").click();
    assert.equal(copies, 1);
    button("关闭密钥").click();
    copy.resolve(); await tick();
    assert.equal(notifications.length, 0);
    assert.equal(text().includes("one-time-secret"), false);
    assert.equal(button("刷新 OAuth").disabled, false);
  });
}
async function publicCreationAndDelete() {
  const publicClient = { ...oauthClient(), client_type: "public", token_endpoint_auth_method: "none" };
  let created = false, deleted = false, writes = 0;
  network(async (url, options) => {
    if (url.endsWith("/oauth-server")) return Response.json(oauthStatus());
    if (options.method === "POST") {
      writes++;
      assert.ok(String(options.body).includes('"client_type":"public"'));
      assert.ok(String(options.body).includes('"token_endpoint_auth_method":"none"'));
      created = true;
      return Response.json(publicClient, { status: 201 });
    }
    if (options.method === "DELETE") {
      writes++;
      assert.equal(url, `/v1/projects/a/auth/oauth-clients/${publicClient.client_id}`);
      deleted = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ clients: created && !deleted ? [publicClient] : [] });
  });
  await mounted(async () => {
    await ready();
    fill();
    const type = document.querySelector('[aria-label="客户端类型"]');
    if (!(type instanceof HTMLSelectElement)) throw new Error("Missing client type");
    type.value = "public"; type.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    const auth = document.querySelector('[aria-label="客户端认证方式"]');
    if (!(auth instanceof HTMLSelectElement)) throw new Error("Missing client auth method");
    assert.equal(auth.value, "none");
    assert.equal(auth.disabled, true);
    button("创建客户端").click();
    await eventually(() => assert.ok(created)); await ready();
    assert.equal(document.querySelector('[aria-label="新客户端密钥"]'), null);
    button("删除").click();
    await eventually(() => assert.ok(deleted)); await ready();
    assert.ok(text().includes("尚无客户端"));
    assert.equal(writes, 2);
  });
}
async function staleMutations() {
  for (const kind of ["create", "delete", "migrate"] as const) {
    const mutation = Promise.withResolvers<Response>();
    let writes = 0;
    let mutationUrl = "";
    let signal: AbortSignal | null | undefined;
    network(async (url, options) => {
      if (options.method === "POST" || options.method === "DELETE") {
        writes++; mutationUrl = url; signal = options.signal;
        return mutation.promise;
      }
      return Response.json(url.endsWith("/oauth-server") ? oauthStatus(url.includes("/b/") ? "b" : "a") : { clients: [oauthClient()] });
    });
    await mounted(async () => {
      await ready();
      const label = kind === "create" ? "创建客户端" : kind === "delete" ? "删除" : "应用 OAuth 配置";
      if (kind === "create") fill();
      button(label).click(); button(label).click();
      await eventually(() => assert.equal(writes, 1));
      assert.ok(mutationUrl.startsWith("/v1/projects/a/"));
      await change("b"); await ready("b");
      assert.ok(signal?.aborted);
      mutation.resolve(kind === "delete" ? new Response(null, { status: 204 })
        : kind === "migrate" ? Response.json(oauthStatus())
          : Response.json({ ...oauthClient(), client_secret: "stale-secret" }, { status: 201 }));
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(notifications.length, 0);
      assert.equal(text().includes("stale-secret"), false);
      assert.equal(writes, 1);
    });
  }
}
async function partialAndUncertain() {
  let writes = 0;
  network(async (url, options) => {
    if (options.method === "POST") { writes++; return Response.json(partialFailure(), { status: 503 }); }
    return Response.json(url.endsWith("/oauth-server") ? oauthStatus() : { clients: [] });
  });
  await mounted(async () => {
    await ready();
    button("应用 OAuth 配置").click();
    await eventually(() => assert.ok(text().includes("尚未完成全部应用")));
    await ready();
    assert.equal(writes, 1);
    assert.equal(notifications.filter(value => value.kind === "success").length, 0);
    assert.equal(notifications.filter(value => value.kind === "warning").length, 1);
    button("刷新 OAuth").click(); await ready();
    assert.ok(text().includes("尚未完成全部应用"));
  });
  let deletes = 0;
  network(async (url, options) => {
    if (options.method === "DELETE") {
      deletes++;
      return Response.json({ code: "OAUTH_CONTEXT_UNCONFIRMED", mutation_may_have_applied: true }, { status: 503 });
    }
    return Response.json(url.endsWith("/oauth-server") ? oauthStatus() : { clients: [oauthClient()] });
  });
  await mounted(async () => {
    await ready();
    button("删除").click();
    await eventually(() => assert.ok(text().includes("请先刷新核对")));
    assert.equal(button("删除").disabled, true);
    button("删除").click();
    assert.equal(deletes, 1);
    button("刷新 OAuth").click(); await ready();
    assert.equal(button("删除").disabled, false);
  });
}
async function clipboardAndUnmount() {
  const copy = Promise.withResolvers<void>();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText() { return copy.promise; } } });
  network(async url => Response.json(url.endsWith("/oauth-server") ? oauthStatus(url.includes("/b/") ? "b" : "a") : { clients: [] }));
  await mounted(async () => {
    await ready();
    button("复制 JWKS").click();
    await change("b"); await ready("b");
    copy.resolve(); await tick();
    assert.equal(notifications.length, 0);
  });
  const unmounted = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  network(async (_url, options) => { signal = options.signal; return unmounted.promise; });
  await mounted(async () => { await eventually(() => assert.ok(signal)); });
  assert.ok(signal?.aborted);
  unmounted.resolve(Response.json(oauthStatus()));
}
try {
  await badResponses();
  await readRaces();
  await creationAndSecrets();
  await publicCreationAndDelete();
  await staleMutations();
  await partialAndUncertain();
  await clipboardAndUnmount();
} finally { globalThis.fetch = originalFetch; }
