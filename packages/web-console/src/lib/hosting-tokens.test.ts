import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import {
  createHostingToken, HostingTokenCreationError, loadHostingTokens, parseCreatedHostingToken, parseHostingTokens,
} from "./hosting-tokens";

const token = { id: "token-a", name: "CI", created_at: "2026-09-10T00:00:00.000Z" };

test("token lists capture typed metadata and support empty and unused tokens", () => {
  const input = { ...token, last_used_at: "2026-09-10T01:00:00.000Z" };
  const parsed = parseHostingTokens({ tokens: [input] });
  expect(parsed).toEqual([input]);
  input.name = "changed";
  expect(parsed[0]?.name).toBe("CI");
  expect(parseHostingTokens({ tokens: [token] })).toEqual([token]);
  expect(parseHostingTokens({ tokens: [] })).toEqual([]);
});

test("token lists reject malformed records, duplicates and secret-bearing responses", () => {
  for (const value of [
    null, [], {}, { tokens: null }, { tokens: [token, token] }, { tokens: new Array(1) },
    { tokens: [], extra: true },
    ...[
      { id: "../other" }, { name: 1 }, { name: "" }, { name: "x".repeat(1025) },
      { created_at: "2026-02-30T00:00:00.000Z" }, { created_at: null },
      { last_used_at: null }, { last_used_at: "invalid" },
      { token: "private" }, { token_encrypted: "private" },
    ].map(change => ({ tokens: [{ ...token, ...change }] })),
  ]) expect(() => parseHostingTokens(value)).toThrow("Invalid hosting token list response");
  let accessed = 0;
  const row = Object.defineProperty({ ...token }, "name", { get() { accessed++; return "CI"; }, enumerable: true });
  const array = Object.defineProperty([token], "0", { get() { accessed++; return token; }, enumerable: true });
  expect(() => parseHostingTokens({ tokens: [row] })).toThrow();
  expect(() => parseHostingTokens({ tokens: array })).toThrow();
  expect(accessed).toBe(0);
});

test("token reads capture valid scope, reject errors and bound the response", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const request = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("/v1/projects/a/frontend/deployments/dep-a/tokens");
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    return Response.json({ project_ref: "a", deployment_id: "dep-a", tokens: [token] });
  };
  await expect(loadHostingTokens("../a", "dep-a", request, signal)).rejects.toThrow();
  await expect(loadHostingTokens("a", "../dep-a", request, signal)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await loadHostingTokens("a", "dep-a", request, signal)).toEqual([token]);
  for (const response of [
    Response.json({ tokens: [] }, { status: 500 }),
    Response.json({ tokens: [] }, { status: 404 }),
    Response.json({ tokens: [] }, { status: 201 }),
    Response.json({ tokens: false }),
    new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } }),
  ]) await expect(loadHostingTokens("a", "dep-a", async () => response, signal)).rejects.toThrow();
});

test("token reads cancel the response stream instead of returning an empty list", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const pending = loadHostingTokens("a", "dep-a", async () => {
    started.resolve();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, controller.signal);
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("hosting page compiles with typed token rows and a visible failure state", () => {
  const filename = new URL("../routes/project/[ref]/hosting/[id]/+page.svelte", import.meta.url);
  const source = readFileSync(filename, "utf8");
  expect(() => compile(source, { filename: filename.pathname, generate: "client" })).not.toThrow();
  expect(source).toContain("loadHostingTokens(ref, id, apiClient, signal)");
  expect(source).toContain("tokensQuery.isError");
  expect(source).not.toContain("token as Record<string, unknown>");
  expect(source).toContain("retry: false");
  expect(source).toContain("input.scope !== tokenScope");
  expect(source).toContain("createdToken?.scope === tokenScope");
});

const creationReceipt = {
  operation: "create_token", project_ref: "a", deployment_id: "dep-a", name: "ci", id: "token-a",
  token: `supa_deploy_${"a".repeat(32)}`,
};

test("created token receipts bind operation, identity, name and secret format", () => {
  expect(parseCreatedHostingToken(creationReceipt, "a", "dep-a", "ci")).toEqual({
    project_ref: "a", deployment_id: "dep-a", name: "ci", id: "token-a", token: creationReceipt.token,
  });
  for (const value of [
    null, {}, { id: "token-a", token: creationReceipt.token },
    ...[
      { operation: "get_token" }, { project_ref: "b" }, { deployment_id: "dep-b" },
      { name: "other" }, { id: "../other" }, { token: null }, { token: "private" },
      { token: `${creationReceipt.token}\n` }, { extra: "private" },
    ].map(change => ({ ...creationReceipt, ...change })),
  ]) expect(() => parseCreatedHostingToken(value, "a", "dep-a", "ci")).toThrow();
});

test("token creation sends one bounded request and treats invalid receipts as uncertain mutations", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const request = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("/v1/projects/a/frontend/deployments/dep-a/tokens");
    expect(options.method).toBe("POST");
    expect(options.body).toBe(JSON.stringify({ name: "ci" }));
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    return Response.json(creationReceipt);
  };
  await expect(createHostingToken("../a", "dep-a", "ci", request, signal)).rejects.toThrow();
  await expect(createHostingToken("a", "dep-a", "", request, signal)).rejects.toThrow();
  expect(calls).toBe(0);
  expect((await createHostingToken("a", "dep-a", "ci", request, signal)).token).toBe(creationReceipt.token);
  expect(calls).toBe(1);
  for (const response of [
    Response.json({ ...creationReceipt, deployment_id: "other" }),
    new Response('{"token":"private-marker'),
    Response.json({ private: "private-marker" }, { status: 500 }),
    new Response("{}", { headers: { "content-length": String(16 * 1024 + 1) } }),
  ]) {
    let attempts = 0;
    const pending = createHostingToken("a", "dep-a", "ci", async () => { attempts++; return response; }, signal);
    await expect(pending).rejects.toBeInstanceOf(HostingTokenCreationError);
    await expect(pending).rejects.toMatchObject({
      mutationMayHaveApplied: true, message: "Hosting token creation could not be confirmed",
    });
    expect(attempts).toBe(1);
  }
});

test("token creation respects preabort and marks cancellation after dispatch uncertain", async () => {
  const aborted = new AbortController();
  const reason = { cancelled: true };
  aborted.abort(reason);
  let calls = 0;
  await expect(createHostingToken("a", "dep-a", "ci", async () => {
    calls++;
    return Response.json(creationReceipt);
  }, aborted.signal)).rejects.toBe(reason);
  expect(calls).toBe(0);
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const pending = createHostingToken("a", "dep-a", "ci", async () => {
    calls++;
    started.resolve();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, controller.signal);
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ mutationMayHaveApplied: true });
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});
