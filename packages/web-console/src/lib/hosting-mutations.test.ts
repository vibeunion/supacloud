import { afterEach, expect, test } from "bun:test";
import { hostingReceipt, runHostingMutation } from "./hosting-mutations";
import { ensureMutationSucceeded } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const deletion = {
  success: true, operation: "delete_deployment", project_ref: "project-a", deployment_id: "deployment-a",
};
const decodeDeletion = hostingReceipt("project-a", "deployment-a", { operation: "delete_deployment" });

test("a hosting receipt requires matching operation, project and deployment identity", () => {
  expect(() => decodeDeletion(deletion)).not.toThrow();
  for (const value of [null, [], {}, { ...deletion, success: false },
    { ...deletion, project_ref: "project-b" }, { ...deletion, deployment_id: "deployment-b" },
    { ...deletion, operation: "redeploy" }, { ...deletion, success: "true" }]) {
    expect(() => decodeDeletion(value)).toThrow("Invalid hosting receipt");
  }
});

test("token and domain receipts prove the selected subresource", () => {
  const token = hostingReceipt("project-a", "deployment-a", { operation: "delete_token", tokenId: "token-a" });
  const tokenReceipt = { ...deletion, operation: "delete_token", token_id: "token-a" };
  expect(() => token(tokenReceipt)).not.toThrow();
  expect(() => token({ ...tokenReceipt, token_id: "token-b" })).toThrow();
  const domain = hostingReceipt("project-a", "deployment-a", { operation: "remove_domain", domain: "site.example.com" });
  const receipt = { ...deletion, operation: "remove_domain", id: "deployment-a",
    domain: "site.example.com", custom_domains: ["other.example.com"] };
  expect(() => domain(receipt)).not.toThrow();
  for (const value of [{ ...receipt, domain: "other.example.com" }, { ...receipt, id: "deployment-b" },
    { ...receipt, custom_domains: ["SITE.EXAMPLE.COM"] }, { ...receipt, custom_domains: [null] }]) {
    expect(() => domain(value)).toThrow();
  }
});

test("redeploy requires a positive build receipt with a usable public URL", () => {
  const decode = hostingReceipt("project-a", "deployment-a", { operation: "redeploy" });
  const receipt = { ...deletion, operation: "redeploy", url: "https://site.example.com", build_log: "" };
  expect(() => decode(receipt)).not.toThrow();
  for (const value of [{ ...receipt, success: false }, { ...receipt, url: "" },
    { ...receipt, url: "javascript:alert(1)" }, { ...receipt, url: "https://secret@site.example.com" },
    { ...receipt, build_log: null }, { ...receipt, error: "failed" }]) {
    expect(() => decode(value)).toThrow();
  }
});

test("malformed, missing and oversized mutation bodies do not acknowledge success", async () => {
  for (const response of [new Response(null, { status: 204 }), new Response("{"), Response.json(null),
    Response.json({}), new Response(new Uint8Array([0xff])),
    new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } })]) {
    await expect(ensureMutationSucceeded(response, "Unconfirmed", decodeDeletion)).rejects.toThrow("Unconfirmed");
    expect(response.body?.locked ?? false).toBe(false);
  }
});

test("invalid hosting scope never starts transport", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; return Response.json(deletion); }, originalFetch);
  for (const project of [undefined, "", "../project-b"]) {
    await expect(runHostingMutation(project, "deployment-a", { operation: "delete_deployment" })).rejects.toThrow();
  }
  await expect(runHostingMutation("project-a", "../deployment-b", { operation: "delete_deployment" })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("an unconfirmed mutation is performed once without automatic replay", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    calls.push({ url: String(input), method: options?.method });
    return Response.json({ ...deletion, deployment_id: "deployment-b" });
  }, originalFetch);
  await expect(runHostingMutation("project-a", "deployment-a", { operation: "delete_deployment" }))
    .rejects.toThrow("could not be confirmed");
  expect(calls).toEqual([{ url: "/v1/projects/project-a/frontend/deployments/deployment-a", method: "DELETE" }]);
});

test("pending requests keep their captured subresource identity", async () => {
  const response = Promise.withResolvers<Response>();
  const mutation = { operation: "delete_token", tokenId: "token-a" } satisfies Parameters<typeof runHostingMutation>[2];
  globalThis.fetch = Object.assign(async () => response.promise, originalFetch);
  const request = runHostingMutation("project-a", "deployment-a", mutation);
  mutation.tokenId = "token-b";
  response.resolve(Response.json({ ...deletion, operation: "delete_token", token_id: "token-a" }));
  await expect(request).resolves.toBeUndefined();
});

test("mutation receipt reads retain cancellation identity after response headers", async () => {
  const reading = Promise.withResolvers<void>();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let cancelled = false;
  globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(deletion))); },
    pull() { reading.resolve(); },
    cancel() { cancelled = true; },
  })), originalFetch);
  const request = runHostingMutation("project-a", "deployment-a", { operation: "delete_deployment" }, options);
  const outcome = request.then(() => null, (error: unknown) => error);
  options.signal = new AbortController().signal;
  await reading.promise;
  controller.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
});

test("a receipt cancelled before reading disposes its body without invoking the decoder", async () => {
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  let decoded = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await expect(ensureMutationSucceeded(response, "Unconfirmed", () => { decoded = true; }, { signal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
  expect(decoded).toBe(false);
});
