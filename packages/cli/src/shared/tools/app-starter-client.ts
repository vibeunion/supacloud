/** Framework-neutral reference state, shared by Svelte/SVAdmin or other view adapters. */
export const STARTER_REVIEW_CLIENT = String.raw`export interface ReviewRow { id: string; state: "draft" | "approved"; version: number }
export interface ReviewOperation {
  kind: "approve" | "upload";
  reviewId: string;
  expectedVersion: number;
  operationId: string;
}
export type ReviewWriteResult =
  | { status: "confirmed"; operationId: string; reviewId: string }
  | { status: "denied" | "conflict" | "unknown" };
export interface ReviewTransport {
  list(): Promise<ReviewRow[]>;
  approve(operation: ReviewOperation): Promise<ReviewWriteResult>;
  upload(operation: ReviewOperation, file: Blob): Promise<ReviewWriteResult>;
  // Read-only receipt lookup, bound to current identity. A current row alone is not a receipt.
  lookup?(operation: ReviewOperation): Promise<ReviewWriteResult>;
}
export interface ReviewClientState {
  list: { status: "idle" | "loading" | "ready" | "empty" | "error" | "denied"; rows: ReviewRow[] };
  mutation: {
    status: "idle" | "submitting" | "confirmed" | "denied" | "conflict" | "unknown";
    operation: ReviewOperation | null;
  };
}

export function createReviewClient(transport: ReviewTransport) {
  let state: ReviewClientState = { list: { status: "idle", rows: [] }, mutation: { status: "idle", operation: null } };
  let generation = 0, closed = false, recovering = false;
  const listeners = new Set<() => void>();
  const snapshot = (): ReviewClientState => structuredClone(state);
  const notify = () => { for (const listener of listeners) listener(); };
  function finish(operation: ReviewOperation, result: ReviewWriteResult) {
    if (closed) return;
    const status = result.status === "confirmed"
      && (result.operationId !== operation.operationId || result.reviewId !== operation.reviewId)
      ? "unknown" : result.status;
    state = { ...state, mutation: { status, operation } };
    notify();
  }
  async function load() {
    if (closed) return;
    const request = ++generation;
    state = { ...state, list: { status: "loading", rows: [] } };
    notify();
    try {
      const rows = await transport.list();
      if (closed || request !== generation) return;
      state = { ...state, list: { status: rows.length ? "ready" : "empty", rows: structuredClone(rows) } };
    } catch (error) {
      if (closed || request !== generation) return;
      state = { ...state, list: { status: error instanceof ReviewAccessDenied ? "denied" : "error", rows: [] } };
    }
    notify();
  }
  async function submit(kind: ReviewOperation["kind"], row: ReviewRow, file?: Blob) {
    if (closed || recovering || state.mutation.status === "submitting" || state.mutation.status === "unknown") return;
    if (row.state !== "draft" || !Number.isSafeInteger(row.version) || row.version < 1 || !row.id.trim()) return;
    if (kind === "upload" && (!file || file.size < 1 || file.size > 1048576
      || file.type.split(";")[0]?.trim().toLowerCase() !== "text/plain")) return;
    const operation: ReviewOperation = {
      kind, reviewId: row.id, expectedVersion: row.version, operationId: crypto.randomUUID(),
    };
    state = { ...state, mutation: { status: "submitting", operation } };
    notify();
    let result: ReviewWriteResult;
    try {
      result = kind === "approve" ? await transport.approve(operation) : await transport.upload(operation, file!);
    } catch {
      result = { status: "unknown" };
    }
    finish(operation, result);
    if (state.mutation.status === "confirmed" || state.mutation.status === "conflict") await load();
  }
  return {
    snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    approve: (row: ReviewRow) => submit("approve", row),
    upload: (row: ReviewRow, file: Blob) => submit("upload", row, file),
    async reconcile() {
      const operation = state.mutation.operation;
      if (closed || recovering || state.mutation.status !== "unknown" || !operation || !transport.lookup) return;
      recovering = true;
      try {
        const result = await transport.lookup(structuredClone(operation));
        finish(operation, result);
        if (snapshot().mutation.status === "confirmed") await load();
      } catch {
        finish(operation, { status: "unknown" });
      } finally { recovering = false; }
    },
    // Dispose on logout/identity change; do not reuse rows or results across sessions.
    dispose() { closed = true; generation++; listeners.clear(); },
  };
}

export class ReviewAccessDenied extends Error {}
`;

export const STARTER_REVIEW_TRANSPORT = String.raw`import type { SupabaseClient } from "@supabase/supabase-js";
import type { SingleAttemptFetch } from "@supacloud/js/contracts";
import { ReviewAccessDenied, type ReviewOperation, type ReviewRow, type ReviewTransport, type ReviewWriteResult } from "./reviews";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  return value as Record<string, unknown>;
}
function row(value: unknown): ReviewRow {
  const item = record(value);
  if (typeof item["id"] !== "string" || (item["state"] !== "draft" && item["state"] !== "approved")
    || typeof item["version"] !== "number" || !Number.isSafeInteger(item["version"]) || item["version"] < 1) throw new Error("Invalid row");
  return { id: item["id"], state: item["state"], version: item["version"] };
}
function rejected(status: number, body: unknown): ReviewWriteResult {
  const code = record(body)["code"];
  if ((status === 401 || status === 403) && [
    "AUTHENTICATION_REQUIRED", "REVIEW_PERMISSION_DENIED", "COMMAND_REJECTED", "UPLOAD_DENIED",
  ].includes(String(code))) return { status: "denied" };
  if (status === 409 && ["REVIEW_CONFLICT", "FEATURE_TRANSITION_CONFLICT", "COMMAND_IDEMPOTENCY_CONFLICT"]
    .includes(String(code))) return { status: "conflict" };
  return { status: "unknown" };
}

/** Use the same user-scoped Supabase client and createAuthenticatedFetch session supplier. */
export function createReviewTransport(options: {
  supabase: SupabaseClient;
  authenticatedFetch: SingleAttemptFetch;
  apiOrigin: string;
  lookup?: ReviewTransport["lookup"];
}): ReviewTransport {
  const origin = new URL(options.apiOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== "/") throw new Error("A fixed trusted HTTPS origin is required");
  async function request(path: string, body: unknown, operationId: string) {
    const response = await options.authenticatedFetch(new URL(path, origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", "idempotency-key": operationId, "x-request-id": operationId },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() as unknown };
  }
  return {
    ...(options.lookup ? { lookup: options.lookup } : {}),
    async list() {
      const { data, error, status } = await options.supabase.from("starter_reviews")
        .select("id,state,version").order("id").limit(100);
      if (error) {
        if (status === 401 || status === 403) throw new ReviewAccessDenied();
        throw new Error("Review read failed");
      }
      if (!Array.isArray(data)) throw new Error("Invalid list");
      return data.map(row);
    },
    async approve(operation: ReviewOperation) {
      const result = await request("/reviews/" + encodeURIComponent(operation.reviewId) + "/approve",
        { expectedVersion: operation.expectedVersion }, operation.operationId);
      if (!result.response.ok) return rejected(result.response.status, result.body);
      const value = record(result.body);
      if (value["state"] !== "approved" || value["version"] !== operation.expectedVersion + 1) return { status: "unknown" };
      return { status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId };
    },
    async upload(operation: ReviewOperation, file: Blob) {
      const input = { artifactId: operation.operationId, expectedVersion: operation.expectedVersion };
      const base = "/reviews/" + encodeURIComponent(operation.reviewId);
      const preview = await request(base + "/attachment-upload", input, operation.operationId);
      if (!preview.response.ok) return rejected(preview.response.status, preview.body);
      const location = record(preview.body);
      if (location["artifactId"] !== operation.operationId || location["bucketId"] !== "review-attachments"
        || typeof location["objectPath"] !== "string"
        || !location["objectPath"].endsWith("/" + operation.reviewId + "/" + operation.operationId + ".txt")) {
        return { status: "unknown" };
      }
      // Never overwrite an object or repeat this upload after a network failure.
      const stored = await options.supabase.storage.from("review-attachments")
        .upload(location["objectPath"], file, { upsert: false, contentType: "text/plain" });
      if (stored.error) return { status: "unknown" };
      const registered = await request(base + "/attachment-registration", input, operation.operationId);
      if (!registered.response.ok) return rejected(registered.response.status, registered.body);
      const value = record(registered.body);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
        byte => byte.toString(16).padStart(2, "0")).join("");
      if (value["artifactId"] !== operation.operationId || value["objectPath"] !== location["objectPath"]
        || typeof value["runId"] !== "string" || value["sha256"] !== sha256
        || value["bytes"] !== file.size) return { status: "unknown" };
      return { status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId };
    },
  };
}
`;

export const STARTER_REVIEW_CLIENT_TEST = String.raw`import { expect, test } from "bun:test";
import { createReviewClient, ReviewAccessDenied, type ReviewTransport, type ReviewRow, type ReviewWriteResult } from "../src/client/reviews";
import { createReviewTransport } from "../src/client/review-transport";

const draft: ReviewRow = { id: "review-one", state: "draft", version: 1 };
function transport(overrides: Partial<ReviewTransport> = {}): ReviewTransport {
  return {
    list: async () => [draft],
    approve: async op => ({ status: "confirmed", operationId: op.operationId, reviewId: op.reviewId }),
    upload: async op => ({ status: "confirmed", operationId: op.operationId, reviewId: op.reviewId }),
    ...overrides,
  };
}
test("list has loading, empty, permission and failure states; old results cannot replace new reads", async () => {
  let resolve: (rows: ReviewRow[]) => void = () => {};
  let calls = 0;
  const client = createReviewClient(transport({ list: () => ++calls === 1
    ? new Promise(done => { resolve = done; }) : Promise.resolve([]) }));
  const loading = client.load();
  expect(client.snapshot().list.status).toBe("loading");
  await client.load();
  resolve([draft]); await loading;
  expect(client.snapshot().list.status).toBe("empty");
  for (const [error, status] of [[new ReviewAccessDenied(), "denied"], [new Error("private"), "error"]] as const) {
    const failed = createReviewClient(transport({ list: async () => { throw error; } }));
    await failed.load();
    expect(failed.snapshot().list).toEqual({ status, rows: [] });
    expect(JSON.stringify(failed.snapshot())).not.toContain("private");
  }
});
test("double submit sends one write; unknown retains its identity and only a lookup can confirm it", async () => {
  let sends = 0, lookups = 0, resolve: (result: ReviewWriteResult) => void = () => {};
  const client = createReviewClient(transport({
    approve: () => { sends++; return new Promise(done => { resolve = done; }); },
    lookup: async op => { lookups++; return { status: "confirmed", operationId: op.operationId, reviewId: op.reviewId }; },
  }));
  const pending = client.approve(draft);
  const operation = client.snapshot().mutation.operation;
  await client.approve(draft);
  resolve({ status: "unknown" }); await pending;
  await client.approve(draft);
  expect(sends).toBe(1);
  expect(client.snapshot().mutation).toEqual({ status: "unknown", operation });
  await client.reconcile();
  expect(sends).toBe(1); expect(lookups).toBe(1);
  expect(client.snapshot().mutation.status).toBe("confirmed");
});
test("conflict refreshes but does not retry the write; wrong receipt remains unknown", async () => {
  let writes = 0, reads = 0;
  const client = createReviewClient(transport({
    list: async () => { reads++; return []; },
    approve: async () => { writes++; return { status: "conflict" }; },
  }));
  await client.approve(draft);
  expect(writes).toBe(1); expect(reads).toBe(1);
  expect(client.snapshot().mutation.status).toBe("conflict");
  const wrong = createReviewClient(transport({
    approve: async () => ({ status: "confirmed", operationId: "foreign", reviewId: draft.id }),
  }));
  await wrong.approve(draft);
  expect(wrong.snapshot().mutation.status).toBe("unknown");
});
test("upload validates size/type, retains failure identity, and disposal drops late results", async () => {
  let uploads = 0;
  const client = createReviewClient(transport({ upload: async () => { uploads++; throw new Error("private"); } }));
  await client.upload(draft, new Blob(["bad"], { type: "application/pdf" }));
  expect(uploads).toBe(0);
  await client.upload(draft, new Blob(["ok"], { type: "text/plain" }));
  expect(uploads).toBe(1);
  expect(client.snapshot().mutation.status).toBe("unknown");
  await client.reconcile();
  expect(uploads).toBe(1);
  client.dispose();
  await client.upload(draft, new Blob(["ok"], { type: "text/plain" }));
  expect(uploads).toBe(1);
});

test("HTTP approval makes one authenticated request and preserves denied, conflict and unknown results", async () => {
  const operation = { kind: "approve" as const, reviewId: draft.id, expectedVersion: 1, operationId: crypto.randomUUID() };
  for (const [httpStatus, body, expected] of [
    [200, { state: "approved", version: 2 }, "confirmed"],
    [403, { code: "REVIEW_PERMISSION_DENIED" }, "denied"],
    [409, { code: "COMMAND_IDEMPOTENCY_CONFLICT" }, "conflict"],
    [500, { code: "INTERNAL_ERROR" }, "unknown"],
    [200, { state: "approved", version: 99 }, "unknown"],
  ] as const) {
    let calls = 0;
    const adapter = createReviewTransport({
      supabase: {} as Parameters<typeof createReviewTransport>[0]["supabase"],
      apiOrigin: "https://reviews.example.test",
      authenticatedFetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://reviews.example.test/reviews/review-one/approve");
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(operation.operationId);
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 1 });
        return Response.json(body, { status: httpStatus });
      },
    });
    expect((await adapter.approve(operation)).status).toBe(expected);
    expect(calls).toBe(1);
  }
});

test("private upload verifies its binding and checksum; a lost registration response is never replayed", async () => {
  const operationId = crypto.randomUUID();
  const file = new Blob(["hello"], { type: "text/plain" });
  const path = "owner/" + draft.id + "/" + operationId + ".txt";
  let uploads = 0, requests = 0;
  const supabase = {
    storage: { from(bucket: string) {
      expect(bucket).toBe("review-attachments");
      return { async upload(objectPath: string, body: Blob, options: { upsert: boolean }) {
        uploads++;
        expect(objectPath).toBe(path); expect(body).toBe(file); expect(options.upsert).toBe(false);
        return { error: null };
      } };
    } },
  } as unknown as Parameters<typeof createReviewTransport>[0]["supabase"];
  const adapter = createReviewTransport({
    supabase, apiOrigin: "https://reviews.example.test",
    authenticatedFetch: async url => {
      requests++;
      if (String(url).endsWith("/attachment-upload")) {
        return Response.json({ artifactId: operationId, bucketId: "review-attachments", objectPath: path });
      }
      throw new Error("Registration response lost");
    },
  });
  const operation = { kind: "upload" as const, reviewId: draft.id, expectedVersion: 1, operationId };
  await expect(adapter.upload(operation, file)).rejects.toThrow("Registration response lost");
  expect(uploads).toBe(1); expect(requests).toBe(2);
  const confirmed = createReviewTransport({
    supabase, apiOrigin: "https://reviews.example.test",
    authenticatedFetch: async url => String(url).endsWith("/attachment-upload")
      ? Response.json({ artifactId: operationId, bucketId: "review-attachments", objectPath: path })
      : Response.json({ artifactId: operationId, objectPath: path, runId: "run-one", bytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }),
  });
  expect((await confirmed.upload(operation, file)).status).toBe("confirmed");
});
`;
