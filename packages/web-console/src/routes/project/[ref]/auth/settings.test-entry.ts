import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, unmount } from "svelte";
import { page } from "./settings.test-state.svelte";
import { setApiHandler } from "./settings.test-network";
import Harness from "./settings.test-harness.svelte";
import { emailTemplateIds, parseEmailTemplates } from "../../../../lib/auth-settings";

const assert: { equal: typeof strictEqual; deepEqual: typeof deepStrictEqual; ok: typeof ok } =
  { equal: strictEqual, deepEqual: deepStrictEqual, ok };

async function eventually(assertion: () => void): Promise<void> {
  const end = performance.now() + 3000;
  let lastError: unknown;
  while (performance.now() < end) {
    try { assertion(); return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw lastError;
}

function element<T extends Element>(selector: string, kind: { new(...args: never[]): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof kind)) throw new Error(`Missing fixture element: ${selector}`);
  return value;
}

function field(placeholder: string): HTMLInputElement {
  return element(`input[placeholder="${placeholder}"]`, HTMLInputElement);
}

function edit(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const value = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!value) throw new Error(`Missing fixture command: ${label}`);
  return value;
}

async function openGithub(): Promise<void> {
  await eventually(() => assert.ok(document.querySelector('input[placeholder="搜索提供者..."]')));
  edit(field("搜索提供者..."), "GitHub");
  await eventually(() => assert.equal(document.querySelectorAll('[role="button"]').length, 1));
  element('[role="button"]', HTMLElement).click();
  await eventually(() => assert.ok(document.querySelector('input[placeholder="填写 Client ID / App ID"]')));
}

async function providers(): Promise<void> {
  page.params.ref = "a";
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const pending = Promise.withResolvers<Response>();
  let malformed = false;
  let warning = false;
  setApiHandler(async (url, options) => {
    if (!options.method) {
      const client = url.includes("/a/") ? "client-a" : "client-b";
      return Response.json(malformed ? { providers: { github: { enabled: "false" } } }
        : { providers: { github: { enabled: true, client_id: client, redirect_uri: null } } });
    }
    requests.push({ url, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
    return requests.length === 1 ? pending.promise : Response.json({
      id: "github", enabled: true, ...(warning ? { warning: "fixture-runtime-offline" } : {}),
    });
  });
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target, props: { view: "providers" } });
  try {
    await openGithub();
    assert.equal(field("填写 Client ID / App ID").value, "client-a");
    edit(field("填写 Client Secret / App Secret"), "secret-a");
    button("保存并启用").click();
    await eventually(() => assert.equal(requests.length, 1));
    edit(field("填写 Client ID / App ID"), "edited-after-send");
    assert.deepEqual(requests[0], {
      url: "/v1/projects/a/auth/providers/github", method: "POST",
      body: { client_id: "client-a", client_secret: "secret-a" },
    });
    page.params.ref = "b";
    await eventually(() => assert.equal(document.querySelector('input[placeholder="填写 Client ID / App ID"]'), null));
    element('[role="button"]', HTMLElement).click();
    await eventually(() => assert.equal(field("填写 Client ID / App ID").value, "client-b"));
    assert.equal(field("填写 Client Secret / App Secret").value, "");
    pending.resolve(Response.json({ id: "github", enabled: true }));
    await eventually(() => assert.equal(button("保存并启用").disabled, false));
    assert.equal(document.body.textContent?.includes("配置已保存"), false);
    assert.equal(field("填写 Client Secret / App Secret").value, "");
    warning = true;
    edit(field("填写 Client Secret / App Secret"), "secret-b");
    button("保存并启用").click();
    await eventually(() => assert.ok(document.body.textContent?.includes("fixture-runtime-offline")));
    await eventually(() => assert.equal(field("填写 Client Secret / App Secret").value, ""));
    assert.equal(requests.length, 2);
    malformed = true;
    page.params.ref = "invalid";
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(requests.length, 2);
  } finally {
    await unmount(component);
    target.remove();
  }
}

async function protection(): Promise<void> {
  page.params.ref = "a";
  const pending = Promise.withResolvers<Response>();
  let patches = 0;
  let malformed = false;
  setApiHandler(async (_url, options) => {
    if (!options.method) return Response.json(malformed ? [] : { SECURITY_CAPTCHA_ENABLED: false });
    patches++;
    return patches === 1 ? Response.json({}, { status: 500 }) : pending.promise;
  });
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target, props: { view: "protection" } });
  try {
    await eventually(() => assert.equal(document.querySelectorAll('[role="switch"]').length, 6));
    element('[role="switch"]', HTMLButtonElement).click();
    await eventually(() => assert.equal(patches, 1));
    await eventually(() => assert.equal(element('[role="switch"]', HTMLButtonElement).getAttribute("aria-checked"), "false"));
    await eventually(() => assert.equal(element('[role="switch"]', HTMLButtonElement).disabled, false));
    element('[role="switch"]', HTMLButtonElement).click();
    await eventually(() => assert.equal(patches, 2));
    page.params.ref = "b";
    await eventually(() => assert.equal(element('[role="switch"]', HTMLButtonElement).getAttribute("aria-checked"), "false"));
    pending.resolve(Response.json({ SECURITY_CAPTCHA_ENABLED: true }));
    await eventually(() => assert.equal(element('[role="switch"]', HTMLButtonElement).disabled, false));
    assert.equal(element('[role="switch"]', HTMLButtonElement).getAttribute("aria-checked"), "false");
    assert.equal(document.body.textContent?.includes("AuthProtection.enabled"), false);
    malformed = true;
    page.params.ref = "invalid";
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(patches, 2);
  } finally {
    await unmount(component);
    target.remove();
  }
}

async function templates(): Promise<void> {
  page.params.ref = "a";
  const pending = Promise.withResolvers<Response>();
  const requests: Array<{ url: string; method: string; templates: unknown }> = [];
  const defaultTemplates = (ref: string) => Object.fromEntries(emailTemplateIds.map((id) => [
    id, { subject: `${ref}-${id}`, content: `${ref}-body` },
  ]));
  let submitted = defaultTemplates("a");
  let malformed = false;
  setApiHandler(async (url, options) => {
    if (!options.method) return Response.json(malformed ? { templates: { confirmation: [] } }
      : { templates: defaultTemplates(url.includes("/a/") ? "a" : "b") });
    const payload: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method, templates: payload });
    if (requests.length === 1) {
      submitted = Object.fromEntries(parseEmailTemplates(payload).map(({ id, subject, content }) => [id, { subject, content }]));
      return pending.promise;
    }
    if (options.method === "PUT") return Response.json({ saved: false, templates: defaultTemplates("b") });
    return Response.json({ reset: true, templates: defaultTemplates("b"), warning: "fixture-restart-unconfirmed" });
  });
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target, props: { view: "templates" } });
  const expand = async () => {
    await eventually(() => {
      const header = [...target.querySelectorAll("button")].find((item) => item.textContent?.includes("确认邮箱"));
      assert.ok(header);
      header.click();
    });
    await eventually(() => assert.ok(document.querySelector('input[placeholder="Email subject line"]')));
  };
  try {
    await expand();
    edit(field("Email subject line"), "submitted-subject-a");
    button("保存全部").click();
    await eventually(() => assert.equal(requests.length, 1));
    edit(field("Email subject line"), "edited-after-send");
    assert.equal(submitted.confirmation?.subject, "submitted-subject-a");
    assert.equal(requests[0]?.url, "/v1/projects/a/auth/template");
    page.params.ref = "b";
    await eventually(() => assert.equal(document.querySelector('input[placeholder="Email subject line"]'), null));
    await expand();
    assert.equal(field("Email subject line").value, "b-confirmation");
    pending.resolve(Response.json({ saved: true, templates: submitted }));
    await eventually(() => assert.equal(button("保存全部").disabled, false));
    assert.equal(document.body.textContent?.includes("邮件模板已保存"), false);
    button("保存全部").click();
    await eventually(() => assert.ok(document.body.textContent?.includes("Invalid email template update response")));
    assert.equal(requests.length, 2);
    await eventually(() => assert.equal(button("恢复默认").disabled, false));
    button("恢复默认").click();
    await eventually(() => assert.ok(document.body.textContent?.includes("fixture-restart-unconfirmed")));
    assert.equal(requests.length, 3);
    assert.equal(requests[2]?.method, "DELETE");
    malformed = true;
    page.params.ref = "invalid";
    await eventually(() => assert.ok(document.querySelector('[role="alert"]')));
    assert.equal(button("保存全部").disabled, true);
    assert.equal(button("恢复默认").disabled, true);
  } finally {
    await unmount(component);
    target.remove();
  }
}

async function rateLimits(): Promise<void> {
  page.params.ref = "a";
  const pending = Promise.withResolvers<Response>();
  const requests: Array<{ url: string; body: unknown }> = [];
  let mode: "valid" | "malformed" | "failed" = "failed";
  let receipt: unknown = {};
  let signin = 12;
  setApiHandler(async (url, options) => {
    if (!options.method) {
      if (mode === "failed") return Response.json({}, { status: 503 });
      if (mode === "malformed") return Response.json({ RATE_LIMIT_SIGNIN: true });
      return Response.json({ RATE_LIMIT_SIGNIN: url.includes("/b/") ? "42" : signin });
    }
    requests.push({ url, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
    return requests.length === 1 ? pending.promise : Response.json(receipt);
  });
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target, props: { view: "rate-limits" } });
  const input = () => element('input[aria-label="AuthRateLimits.signin"]', HTMLInputElement);
  const save = () => button("AuthRateLimits.save");
  const refresh = () => button("Common.refresh");
  try {
    await eventually(() => assert.ok(target.querySelector('[role="alert"]')));
    assert.equal(save().disabled, true);
    assert.equal(target.querySelector("input"), null);
    save().click();
    assert.equal(requests.length, 0);
    mode = "valid";
    refresh().click();
    await eventually(() => assert.equal(input().value, "12"));
    assert.equal(element('input[aria-label="AuthRateLimits.signup"]', HTMLInputElement).value, "");
    assert.equal(save().disabled, true);
    for (const value of ["", "-1", "1.5", "9007199254740992"]) {
      edit(input(), value);
      await eventually(() => assert.equal(input().getAttribute("aria-invalid"), "true"));
      assert.equal(save().disabled, true);
      save().click();
    }
    assert.equal(requests.length, 0);
    edit(input(), "0");
    await eventually(() => assert.equal(save().disabled, false));
    save().click();
    await eventually(() => assert.equal(requests.length, 1));
    assert.deepEqual(requests[0], { url: "/v1/projects/a/auth/config", body: { RATE_LIMIT_SIGNIN: "0" } });
    page.params.ref = "b";
    await eventually(() => assert.equal(input().value, "42"));
    page.params.ref = "a";
    await eventually(() => assert.equal(input().value, "12"));
    // Even a programmatic edit cannot be overwritten by the old page's completion.
    edit(input(), "23");
    pending.resolve(Response.json({ RATE_LIMIT_SIGNIN: "0" }));
    await eventually(() => assert.equal(save().disabled, false));
    assert.equal(input().value, "23");
    assert.equal(target.querySelector('[role="status"]'), null);
    assert.equal(requests.length, 1);
    save().click();
    await eventually(() => assert.equal(requests.length, 2));
    await eventually(() => assert.equal(target.querySelector('[role="alert"]')?.textContent?.trim(), "AuthRateLimits.save_failed"));
    await eventually(() => assert.equal(input().disabled, false));
    assert.equal(target.querySelector('[role="status"]'), null);
    assert.equal(requests.length, 2);
    receipt = { RATE_LIMIT_SIGNIN: "24" };
    edit(input(), "23");
    await eventually(() => assert.equal(save().disabled, false));
    save().click();
    await eventually(() => assert.equal(requests.length, 3));
    await eventually(() => assert.equal(target.querySelector('[role="alert"]')?.textContent?.trim(), "AuthRateLimits.save_failed"));
    await eventually(() => assert.equal(input().disabled, false));
    receipt = { RATE_LIMIT_SIGNIN: 23 };
    edit(input(), "23");
    signin = 23;
    await eventually(() => assert.equal(save().disabled, false));
    save().click();
    await eventually(() => assert.equal(requests.length, 4));
    await eventually(() => assert.equal(target.querySelector('[role="status"]')?.textContent?.trim(), "AuthRateLimits.save_success"));
    await eventually(() => assert.equal(input().disabled, false));
    assert.equal(input().value, "23");
    assert.equal(save().disabled, true);
    mode = "malformed";
    refresh().click();
    await eventually(() => assert.ok(target.querySelector('[role="alert"]')));
    assert.equal(save().disabled, true);
    assert.equal(target.querySelector("input"), null);
    assert.equal(requests.length, 4);
  } finally {
    pending.resolve(Response.json({ RATE_LIMIT_SIGNIN: 0 }));
    await unmount(component);
    target.remove();
  }
}

await providers();
await protection();
await templates();
await rateLimits();
