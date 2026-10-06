import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, unmount } from "svelte";
import { page } from "../settings.test-state.svelte";
import Harness from "./page.test-harness.svelte";

async function eventually(assertion: () => void) {
  const end = performance.now() + 3000;
  let last: unknown;
  while (performance.now() < end) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw last;
}
function siteInput() {
  const input = document.querySelector('input[placeholder="https://your-app.com"]');
  if (!(input instanceof HTMLInputElement)) throw Error("Missing site URL input");
  return input;
}
function saveButton() {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === "Common.save");
  if (!button) throw Error("Missing save button");
  return button;
}
function edit(value: string) {
  siteInput().value = value;
  siteInput().dispatchEvent(new Event("input", { bubbles: true }));
}
const originalFetch = globalThis.fetch;
const writes: { url: string; body: unknown; credentials: RequestCredentials | undefined }[] = [];
const pending = Promise.withResolvers<Response>();
let readMalformed = false;
let mode: "pending" | "mismatch" | "success" = "pending";
globalThis.fetch = Object.assign(async (url: RequestInfo | URL, options: RequestInit = {}) => {
  const path = String(url);
  if (options.method === "PATCH") {
    writes.push({ url: path, body: JSON.parse(String(options.body)), credentials: options.credentials });
    if (mode === "pending") return pending.promise;
    return Response.json(mode === "mismatch" ? {} : JSON.parse(String(options.body)));
  }
  const ref = path.includes("/b/") ? "b" : "a";
  return Response.json(readMalformed ? { site_url: 123 } : { site_url: `https://${ref}.test`, uri_allow_list: "" });
}, originalFetch);
page.params.ref = "a";
const target = document.body.appendChild(document.createElement("div"));
const component = mount(Harness, { target });
try {
  await eventually(() => strictEqual(siteInput().value, "https://a.test"));
  edit("https://submitted.test");
  saveButton().click();
  await eventually(() => strictEqual(writes.length, 1));
  saveButton().click();
  deepStrictEqual(writes[0], {
    url: "/v1/projects/a/auth/config", body: { site_url: "https://submitted.test", uri_allow_list: "" }, credentials: "include",
  });
  page.params.ref = "b";
  await eventually(() => strictEqual(siteInput().value, "https://b.test"));
  page.params.ref = "a";
  await eventually(() => strictEqual(siteInput().value, "https://a.test"));
  edit("https://new-draft.test");
  pending.resolve(Response.json({ site_url: "https://submitted.test", uri_allow_list: "" }));
  await eventually(() => strictEqual(saveButton().disabled, false));
  strictEqual(siteInput().value, "https://new-draft.test");
  strictEqual(document.body.textContent?.includes("AuthUrlConfiguration.save_success"), false);
  strictEqual(writes.length, 1);
  mode = "mismatch";
  saveButton().click();
  await eventually(() => ok(document.body.textContent?.includes("AuthUrlConfiguration.save_failed")));
  await new Promise(resolve => setTimeout(resolve, 50));
  strictEqual(writes.length, 2);
  strictEqual(siteInput().value, "https://new-draft.test");
  mode = "success";
  saveButton().click();
  await eventually(() => ok(document.body.textContent?.includes("AuthUrlConfiguration.save_success")));
  strictEqual(writes.length, 3);
  readMalformed = true;
  page.params.ref = "invalid";
  await eventually(() => ok(document.querySelector('[role="alert"]')));
  strictEqual(saveButton().disabled, true);
  strictEqual(document.querySelector('input[placeholder="https://your-app.com"]'), null);
} finally {
  await unmount(component);
  target.remove();
  globalThis.fetch = originalFetch;
}
