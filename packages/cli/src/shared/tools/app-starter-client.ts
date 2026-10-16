/** Framework-neutral reference state, shared by Svelte/SVAdmin or other view adapters. */
export const STARTER_REVIEW_CLIENT = String.raw`import type { ReviewOperation, ReviewReceipt } from "../review/contracts";
import { REVIEW_VERSION_MAX } from "../review/limits";
export type { ReviewOperation } from "../review/contracts";

export interface ReviewRow { id: string; state: "draft" | "approved"; version: number }
export type ReviewWriteResult =
  | (ReviewReceipt & { status: "confirmed" })
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

export interface ReviewPendingStore {
  load(): ReviewOperation | null;
  save(operation: ReviewOperation): void;
  clear(operation: ReviewOperation): void;
}

/** Keep operation identity, not tokens, file bytes or row data. Storage is not authorization. */
export function createReviewPendingStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  scope: { projectId: string; tenantId: string; applicationId: string; subject: string }): ReviewPendingStore {
  const identity = [scope.projectId, scope.tenantId, scope.applicationId, scope.subject];
  if (identity.some(value => !value.trim())) throw new Error("Explicit recovery scope required");
  const key = "supacloud.review.pending.v1:" + JSON.stringify(identity);
  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function decode(value: unknown): ReviewOperation {
    if (!isRecord(value)) throw new Error("Invalid pending operation");
    const item = value;
    if ((item["kind"] !== "approve" && item["kind"] !== "upload")
      || typeof item["reviewId"] !== "string" || !item["reviewId"].trim()
      || typeof item["operationId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item["operationId"])
      || typeof item["expectedVersion"] !== "number" || !Number.isSafeInteger(item["expectedVersion"])
      || item["expectedVersion"] < 1 || item["expectedVersion"] > REVIEW_VERSION_MAX) {
      throw new Error("Invalid pending operation");
    }
    return { kind: item["kind"], reviewId: item["reviewId"], operationId: item["operationId"], expectedVersion: item["expectedVersion"] };
  }
  const load = () => {
    const value = storage.getItem(key);
    if (value === null) return null;
    const parsed: unknown = JSON.parse(value);
    return decode(parsed);
  };
  return {
    load,
    save(operation) {
      const previous = load();
      if (previous && JSON.stringify(previous) !== JSON.stringify(decode(operation))) {
        throw new Error("Another unresolved operation exists");
      }
      storage.setItem(key, JSON.stringify(decode(operation)));
    },
    clear(operation) {
      const previous = load();
      if (previous && JSON.stringify(previous) !== JSON.stringify(decode(operation))) {
        throw new Error("Pending operation identity changed");
      }
      storage.removeItem(key);
    },
  };
}

export function createReviewClient(transport: ReviewTransport, pending?: ReviewPendingStore) {
  let state: ReviewClientState = { list: { status: "idle", rows: [] }, mutation: { status: "idle", operation: null } };
  try {
    const operation = pending?.load();
    if (operation) state.mutation = { status: "unknown", operation };
  } catch { state.mutation = { status: "unknown", operation: null }; }
  let generation: number = 0, closed: boolean = false, recovering: boolean = false;
  const listeners = new Set<() => void>();
  const snapshot = (): ReviewClientState => structuredClone(state);
  const notify = () => {
    for (const listener of listeners) {
      // A view subscriber cannot interrupt persistence or change a write outcome.
      try { listener(); } catch {}
    }
  };
  function outcome(operation: ReviewOperation, result: unknown): ReviewWriteResult["status"] {
    try {
      if (result === null || typeof result !== "object" || Array.isArray(result) || !("status" in result)) return "unknown";
      const status = result.status;
      if (status === "denied" || status === "conflict") return status;
      if (status === "confirmed" && "operationId" in result && "reviewId" in result
        && result.operationId === operation.operationId && result.reviewId === operation.reviewId) return "confirmed";
    } catch { /* Invalid adapters must not discard recovery evidence. */ }
    return "unknown";
  }
  function finish(operation: ReviewOperation, result: unknown) {
    if (closed) return;
    let status = outcome(operation, result);
    if (status !== "unknown") {
      try {
        if (pending) {
          pending.clear(structuredClone(operation));
          if (pending.load() !== null) throw new Error("Pending operation was not cleared");
        }
      } catch { status = "unknown"; }
    }
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
    if (row.version > REVIEW_VERSION_MAX || (kind === "approve" && row.version === REVIEW_VERSION_MAX)) return;
    // Upload contracts are narrower than approval/list IDs and PostgreSQL-safe versions.
    // Reject locally before creating an unresolved operation for an impossible request.
    if (kind === "upload" && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
      || !file || file.size < 1 || file.size > 1048576
      || file.type.split(";")[0]?.trim().toLowerCase() !== "text/plain")) return;
    const operation: ReviewOperation = {
      kind, reviewId: row.id, expectedVersion: row.version, operationId: crypto.randomUUID(),
    };
    try {
      if (pending) {
        pending.save(structuredClone(operation));
        const stored = pending.load();
        if (!stored || stored.kind !== operation.kind || stored.reviewId !== operation.reviewId
          || stored.expectedVersion !== operation.expectedVersion || stored.operationId !== operation.operationId) {
          throw new Error("Pending operation was not persisted");
        }
      }
    } catch {
      let original: ReviewOperation | null = null;
      try { original = pending?.load() ?? null; } catch {}
      state = { ...state, mutation: { status: "unknown", operation: original } };
      notify();
      return;
    }
    state = { ...state, mutation: { status: "submitting", operation } };
    notify();
    if (closed) return;
    let result: ReviewWriteResult;
    try {
      result = kind === "approve" ? await transport.approve(structuredClone(operation))
        : file ? await transport.upload(structuredClone(operation), file) : { status: "unknown" };
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
        // Denial or conflict during lookup does not prove the original write did not commit.
        // Normalize once: custom adapter accessors may change between reads.
        finish(operation, outcome(operation, result) === "confirmed"
          ? { status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId }
          : { status: "unknown" });
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

export const STARTER_REVIEW_TRANSPORT = String.raw`import type { SingleAttemptFetch } from "@supacloud/js/contracts";
import { ReviewAccessDenied, type ReviewOperation, type ReviewRow, type ReviewTransport, type ReviewWriteResult } from "./reviews";

/** Structural SDK boundary: application data is decoded, never propagated as SDK generics. */
export interface ReviewSupabaseClient {
  from(table: "starter_reviews"): {
    select(columns: "id,state,version"): {
      order(column: "id"): { limit(count: number): PromiseLike<{ data: unknown; error: unknown; status: number }> };
    };
  };
  storage: {
    from(bucket: string): {
      upload(path: string, file: Blob, options: { upsert: boolean; contentType: string }): Promise<{ error: unknown }>;
    };
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid response");
  return value;
}
function isList(value: unknown): value is unknown[] { return Array.isArray(value); }
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
  supabase: ReviewSupabaseClient;
  authenticatedFetch: SingleAttemptFetch;
  apiOrigin: string;
  lookup?: ReviewTransport["lookup"];
}): ReviewTransport {
  const origin = new URL(options.apiOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== "/") throw new Error("A fixed trusted HTTPS origin is required");
  async function request(path: string, body: unknown, operationId: string): Promise<{ response: Response; body: unknown }> {
    const response = await options.authenticatedFetch(new URL(path, origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", "idempotency-key": operationId, "x-request-id": operationId },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    return { response, body: result };
  }
  return {
    lookup: options.lookup ?? (async operation => {
      const url = new URL("/reviews/" + encodeURIComponent(operation.reviewId)
        + "/operations/" + encodeURIComponent(operation.operationId), origin);
      url.searchParams.set("kind", operation.kind);
      url.searchParams.set("expectedVersion", String(operation.expectedVersion));
      const response = await options.authenticatedFetch(url, {
        method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
        headers: { "x-request-id": operation.operationId },
      });
      if (!response.ok) return { status: "unknown" };
      const body: unknown = await response.json();
      const receipt = record(body);
      if (receipt["status"] !== "confirmed" || receipt["operationId"] !== operation.operationId
        || receipt["reviewId"] !== operation.reviewId) return { status: "unknown" };
      return { status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId };
    }),
    async list() {
      const { data, error, status } = await options.supabase.from("starter_reviews")
        .select("id,state,version").order("id").limit(100);
      if (error) {
        if (status === 401 || status === 403) throw new ReviewAccessDenied();
        throw new Error("Review read failed");
      }
      if (!isList(data)) throw new Error("Invalid list");
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
      if (!preview.response.ok) {
        // These explicit preview rejections happen before any object or registration write.
        const code = record(preview.body)["code"];
        if ((preview.response.status === 501 && code === "UPLOADS_UNAVAILABLE")
          || (preview.response.status === 400 && code === "UPLOAD_INPUT_INVALID")) return { status: "denied" };
        return rejected(preview.response.status, preview.body);
      }
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
      // The object is already stored. A rejection cannot roll back that side effect.
      if (!registered.response.ok) return { status: "unknown" };
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
import { createReviewClient, createReviewPendingStore, ReviewAccessDenied, type ReviewOperation, type ReviewTransport, type ReviewRow, type ReviewWriteResult } from "../src/client/reviews";
import { createReviewTransport } from "../src/client/review-transport";

const draft: ReviewRow = { id: "review-one", state: "draft", version: 1 };
const uploadDraft: ReviewRow = { ...draft, id: "11111111-1111-4111-8111-111111111111" };
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

test("malformed adapter outcomes preserve pending evidence across writes and recovery", async () => {
  const malformed: unknown[] = [
    null, undefined, false, [], "confirmed", {}, { status: "complete" }, { status: 200 },
    { status: "confirmed" }, { status: "confirmed", operationId: "foreign", reviewId: draft.id },
    { get status() { throw new Error("private adapter detail"); } },
  ];
  for (const kind of ["approve", "upload"] as const) {
    for (const value of malformed) {
      let saved: ReviewOperation | null = null, sends = 0, clears = 0, reads = 0, recovered = false;
      const readSaved = (): ReviewOperation | null => saved;
      // Simulate an untyped/custom adapter crossing the public TypeScript boundary.
      const invalid = value as ReviewWriteResult;
      const send = async () => { sends++; return invalid; };
      const client = createReviewClient(transport({
        approve: send, upload: send,
        list: async () => { reads++; return []; },
        lookup: async op => recovered
          ? { status: "confirmed", operationId: op.operationId, reviewId: op.reviewId } : invalid,
      }), {
        load: () => saved, save: op => { saved = op; },
        clear: () => { clears++; saved = null; },
      });
      const submit = () => kind === "approve" ? client.approve(draft)
        : client.upload(uploadDraft, new Blob(["hello"], { type: "text/plain" }));
      await submit();
      const original = client.snapshot().mutation.operation;
      expect(original).not.toBeNull();
      expect(readSaved()).toEqual(original);
      expect(client.snapshot().mutation).toEqual({ status: "unknown", operation: original });
      await client.reconcile();
      await submit();
      expect(client.snapshot().mutation).toEqual({ status: "unknown", operation: original });
      expect(readSaved()).toEqual(original);
      expect(sends).toBe(1); expect(clears).toBe(0); expect(reads).toBe(0);
      expect(JSON.stringify(client.snapshot())).not.toContain("private adapter detail");
      recovered = true;
      await client.reconcile();
      expect(client.snapshot().mutation.status).toBe("confirmed");
      expect(readSaved()).toBeNull();
      expect(sends).toBe(1); expect(clears).toBe(1); expect(reads).toBe(1);
    }
  }
});
test("recovery validates adapter accessors once before clearing pending evidence", async () => {
  let saved: ReviewOperation | null = null, reads = 0, sends = 0, clears = 0;
  const client = createReviewClient(transport({
    approve: async () => { sends++; return { status: "unknown" }; },
    lookup: async operation => ({
      get status() { return ++reads === 1 ? "confirmed" as const : "denied" as const; },
      operationId: operation.operationId, reviewId: operation.reviewId,
    }),
  }), {
    load: () => saved, save: operation => { saved = operation; },
    clear: () => { clears++; saved = null; },
  });
  await client.approve(draft);
  expect(client.snapshot().mutation.status).toBe("unknown");
  await client.reconcile();
  expect(reads).toBe(1);
  expect(client.snapshot().mutation.status).toBe("confirmed");
  expect(saved).toBeNull();
  expect(clears).toBe(1);
  expect(sends).toBe(1);
});

test("upload validates size/type, retains failure identity, and disposal drops late results", async () => {
  let uploads = 0;
  const client = createReviewClient(transport({ upload: async () => { uploads++; throw new Error("private"); } }));
  await client.upload(uploadDraft, new Blob(["bad"], { type: "application/pdf" }));
  expect(uploads).toBe(0);
  await client.upload(uploadDraft, new Blob(["ok"], { type: "text/plain" }));
  expect(uploads).toBe(1);
  expect(client.snapshot().mutation.status).toBe("unknown");
  await client.reconcile();
  expect(uploads).toBe(1);
  client.dispose();
  await client.upload(uploadDraft, new Blob(["ok"], { type: "text/plain" }));
  expect(uploads).toBe(1);
});

test("upload-only input constraints never persist or dispatch an impossible request or block approval", async () => {
  let saves = 0, uploads = 0, approvals = 0, saved: ReviewOperation | null = null;
  const client = createReviewClient(transport({
    upload: async () => { uploads++; return { status: "unknown" }; },
    approve: async op => { approvals++; return { status: "confirmed", operationId: op.operationId, reviewId: op.reviewId }; },
  }), {
    load: () => saved, save: op => { saves++; saved = op; }, clear: () => { saved = null; },
  });
  await client.load();
  expect(client.snapshot().list.rows).toEqual([draft]);
  const file = new Blob(["hello"], { type: "text/plain" });
  await client.upload(draft, file);
  await client.upload({ ...uploadDraft, version: 2147483648 }, file);
  expect(uploads).toBe(0); expect(saves).toBe(0); expect(saved).toBeNull();
  expect(client.snapshot().mutation).toEqual({ status: "idle", operation: null });
  await client.approve(draft);
  expect(approvals).toBe(1); expect(saves).toBe(1);
  expect(client.snapshot().mutation.status).toBe("confirmed");
});

test("explicit upload preview rejection clears pending before side effects, without retrying", async () => {
  for (const [status, code] of [[501, "UPLOADS_UNAVAILABLE"], [400, "UPLOAD_INPUT_INVALID"]] as const) {
    let requests = 0, uploads = 0, saved: ReviewOperation | null = null;
    const adapter = createReviewTransport({
      supabase: {
        storage: { from: () => ({ upload: async () => { uploads++; return { error: null }; } }) },
      } as unknown as Parameters<typeof createReviewTransport>[0]["supabase"],
      apiOrigin: "https://reviews.example.test",
      authenticatedFetch: async url => {
        requests++;
        return String(url).endsWith("/attachment-upload")
          ? Response.json({ code }, { status }) : Response.json({ state: "approved", version: 2 });
      },
    });
    const client = createReviewClient({ ...adapter, list: async () => [uploadDraft] }, {
      load: () => saved, save: op => { saved = op; }, clear: () => { saved = null; },
    });
    await client.upload(uploadDraft, new Blob(["hello"], { type: "text/plain" }));
    expect(client.snapshot().mutation.status).toBe("denied");
    expect(saved).toBeNull(); expect(uploads).toBe(0); expect(requests).toBe(1);
    await client.reconcile();
    expect(requests).toBe(1);
    await client.approve(uploadDraft);
    expect(client.snapshot().mutation.status).toBe("confirmed");
    expect(requests).toBe(2);
  }
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
  const path = "owner/" + uploadDraft.id + "/" + operationId + ".txt";
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
  const operation = { kind: "upload" as const, reviewId: uploadDraft.id, expectedVersion: 1, operationId };
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

test("reload restores pending identity, denies replay and resolves only a matching durable receipt", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const scope = { projectId: "p", tenantId: "t", applicationId: "reviews", subject: "owner" };
  const pending = createReviewPendingStore(storage, scope);
  let writes = 0;
  const first = createReviewClient(transport({ approve: async () => { writes++; return { status: "unknown" }; } }), pending);
  await first.approve(draft);
  const operation = first.snapshot().mutation.operation!;
  first.dispose();
  const reloaded = createReviewClient(transport({
    approve: async () => { writes++; return { status: "unknown" }; },
    lookup: async op => ({ status: "confirmed", operationId: op.operationId, reviewId: op.reviewId }),
  }), createReviewPendingStore(storage, scope));
  expect(reloaded.snapshot().mutation).toEqual({ status: "unknown", operation });
  await reloaded.approve(draft);
  expect(writes).toBe(1);
  expect(createReviewPendingStore(storage, { ...scope, subject: "other" }).load()).toBeNull();
  expect(createReviewPendingStore(storage, { ...scope, projectId: "other" }).load()).toBeNull();
  await reloaded.reconcile();
  expect(reloaded.snapshot().mutation.status).toBe("confirmed");
  expect(pending.load()).toBeNull();
});

test("denied or conflicting recovery never unlocks an unknown operation", async () => {
  for (const status of ["denied", "conflict"] as const) {
    let writes = 0;
    const client = createReviewClient(transport({
      approve: async () => { writes++; return { status: "unknown" }; },
      lookup: async () => ({ status }),
    }));
    await client.approve(draft);
    const original = client.snapshot().mutation.operation;
    await client.reconcile(); await client.approve(draft);
    expect(writes).toBe(1);
    expect(client.snapshot().mutation).toEqual({ status: "unknown", operation: original });
  }
});

test("unavailable recovery storage prevents dispatch, and disposal leaves pending evidence", async () => {
  let writes = 0;
  const client = createReviewClient(transport({ approve: async () => { writes++; return { status: "unknown" }; } }), {
    load: () => null, save: () => { throw new Error("Storage unavailable"); }, clear: () => {},
  });
  await client.approve(draft);
  expect(writes).toBe(0);
  expect(client.snapshot().mutation.status).toBe("unknown");
  let saved: ReviewOperation | null = null, cleared = 0, resolve: (result: ReviewWriteResult) => void = () => {};
  const closed = createReviewClient(transport({ approve: () => new Promise(done => { resolve = done; }) }), {
    load: () => saved, save: op => { saved = op; }, clear: () => { cleared++; },
  });
  const request = closed.approve(draft);
  const op = closed.snapshot().mutation.operation!;
  closed.dispose();
  resolve({ status: "confirmed", operationId: op.operationId, reviewId: op.reviewId }); await request;
  expect<ReviewOperation | null>(saved).toEqual(op); expect(cleared).toBe(0);
});

test("default recovery transport performs one read without body or mutation retry", async () => {
  let calls = 0;
  const operation = { kind: "approve" as const, reviewId: draft.id, expectedVersion: 1, operationId: crypto.randomUUID() };
  const adapter = createReviewTransport({
    supabase: {} as Parameters<typeof createReviewTransport>[0]["supabase"],
    apiOrigin: "https://reviews.example.test",
    authenticatedFetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.pathname).toBe("/reviews/" + draft.id + "/operations/" + operation.operationId);
      expect(url.searchParams.get("expectedVersion")).toBe("1");
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
      expect(init?.cache).toBe("no-store");
      return Response.json({ status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId });
    },
  });
  expect((await adapter.lookup!(operation)).status).toBe("confirmed");
  expect(calls).toBe(1);
});

test("corrupt pending records fail closed and cannot be overwritten by another operation", async () => {
  let value: string | null = "{broken", writes = 0;
  const pending = createReviewPendingStore({
    getItem: () => value, setItem: (_key, next) => { value = next; }, removeItem: () => { value = null; },
  }, { projectId: "p", tenantId: "t", applicationId: "a", subject: "s" });
  const blocked = createReviewClient(transport({ approve: async () => { writes++; return { status: "unknown" }; } }), pending);
  await blocked.approve(draft);
  expect(writes).toBe(0);
  expect(blocked.snapshot().mutation).toEqual({ status: "unknown", operation: null });
  expect(value).toBe("{broken");
  value = null;
  const original = { kind: "approve" as const, reviewId: draft.id, expectedVersion: 1, operationId: crypto.randomUUID() };
  pending.save(original);
  const other = { ...original, operationId: crypto.randomUUID() };
  expect(() => pending.save(other)).toThrow("Another unresolved operation");
  expect(() => pending.clear(other)).toThrow("identity changed");
  expect(pending.load()).toEqual(original);
});

test("a competing pending operation is recovered instead of the undispatched attempt", async () => {
  let value: string | null = null, writes = 0, lookedUp: unknown;
  const pending = createReviewPendingStore({
    getItem: () => value, setItem: (_key, next) => { value = next; }, removeItem: () => { value = null; },
  }, { projectId: "p", tenantId: "t", applicationId: "a", subject: "s" });
  const client = createReviewClient(transport({
    approve: async () => { writes++; return { status: "unknown" }; },
    lookup: async op => {
      lookedUp = op;
      return { status: "confirmed", operationId: op.operationId, reviewId: op.reviewId };
    },
  }), pending);
  const original = { kind: "upload" as const, reviewId: uploadDraft.id, expectedVersion: 1, operationId: crypto.randomUUID() };
  pending.save(original);
  await client.approve(draft);
  expect(writes).toBe(0);
  expect(client.snapshot().mutation).toEqual({ status: "unknown", operation: original });
  await client.reconcile();
  expect(lookedUp).toEqual(original);
  expect(pending.load()).toBeNull();
});

test("disposal during submitting notification prevents dispatch and preserves pending identity", async () => {
  let writes = 0, saved: ReviewOperation | null = null;
  const client = createReviewClient(transport({
    approve: async () => { writes++; return { status: "unknown" }; },
  }), { load: () => saved, save: op => { saved = op; }, clear: () => { saved = null; } });
  client.subscribe(() => { if (client.snapshot().mutation.status === "submitting") client.dispose(); });
  await client.approve(draft);
  expect(writes).toBe(0);
  expect(client.snapshot().mutation.operation).toEqual(saved);
  expect(saved).not.toBeNull();
});

test("registration rejection after object upload retains pending identity and never submits a replacement", async () => {
  for (const [status, code] of [[403, "UPLOAD_DENIED"], [409, "COMMAND_IDEMPOTENCY_CONFLICT"]] as const) {
    let uploads = 0, requests = 0, saved: ReviewOperation | null = null;
    const adapter = createReviewTransport({
      supabase: {
        storage: { from: () => ({ upload: async () => { uploads++; return { error: null }; } }) },
      } as unknown as Parameters<typeof createReviewTransport>[0]["supabase"],
      apiOrigin: "https://reviews.example.test",
      authenticatedFetch: async (input, init) => {
        requests++;
        if (String(input).endsWith("/attachment-upload")) {
          const operationId = new Headers(init?.headers).get("idempotency-key")!;
          return Response.json({ artifactId: operationId, bucketId: "review-attachments",
            objectPath: "owner/" + uploadDraft.id + "/" + operationId + ".txt" });
        }
        return Response.json({ code }, { status });
      },
    });
    const client = createReviewClient(adapter, {
      load: () => saved, save: op => { saved = op; }, clear: () => { saved = null; },
    });
    const file = new Blob(["hello"], { type: "text/plain" });
    await client.upload(uploadDraft, file);
    expect(client.snapshot().mutation.status).toBe("unknown");
    expect(client.snapshot().mutation.operation).toEqual(saved);
    expect(saved).not.toBeNull();
    await client.upload(uploadDraft, file);
    expect(uploads).toBe(1);
    expect(requests).toBe(2);
  }
});


for (const kind of ["approve", "upload"] as const) {
  const submit = (client: ReturnType<typeof createReviewClient>) => kind === "approve"
    ? client.approve(draft) : client.upload(uploadDraft, new Blob(["hello"], { type: "text/plain" }));
  for (const failure of ["silent", "read-error", "operation", "version", "kind"] as const) {
    test(kind + " verifies pending readback before any transport: " + failure, async () => {
      let saved: ReviewOperation | null = null, attempted = false, sends = 0;
      const client = createReviewClient(transport({
        approve: async () => { sends++; return { status: "unknown" }; },
        upload: async () => { sends++; return { status: "unknown" }; },
      }), {
        load() {
          if (attempted && failure === "read-error") throw new Error("private storage failure");
          return saved;
        },
        save(operation) {
          attempted = true;
          if (failure === "silent") return;
          saved = { ...operation };
          if (failure === "operation") saved.operationId = crypto.randomUUID();
          if (failure === "version") saved.expectedVersion++;
          if (failure === "kind") saved.kind = kind === "approve" ? "upload" : "approve";
        },
        clear() { throw new Error("Must not clear an unconfirmed operation"); },
      });
      await submit(client);
      await submit(client);
      expect(sends).toBe(0);
      expect(client.snapshot().mutation.status).toBe("unknown");
      expect(JSON.stringify(client.snapshot())).not.toContain("private storage failure");
      expect(client.snapshot().mutation.operation).toEqual(failure === "read-error" ? null : saved);
    });
  }
  for (const resultStatus of ["confirmed", "denied", "conflict"] as const) {
    test(kind + " retains pending after silent cleanup: " + resultStatus, async () => {
      let saved: ReviewOperation | null = null, sends = 0, clears = 0;
      const send = async (operation: ReviewOperation): Promise<ReviewWriteResult> => {
        sends++;
        return resultStatus === "confirmed"
          ? { status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId }
          : { status: resultStatus };
      };
      const client = createReviewClient(transport({ approve: send, upload: send }), {
        load: () => saved, save: operation => { saved = operation; }, clear: () => { clears++; },
      });
      await submit(client);
      expect(client.snapshot().mutation).toEqual({ status: "unknown", operation: saved });
      await submit(client);
      expect(sends).toBe(1);
      expect(clears).toBe(1);
      expect(saved).not.toBeNull();
    });
  }
  test(kind + " accepts exact JSON readback and recovers once without another write", async () => {
    const values = new Map<string, string>();
    const pending = createReviewPendingStore({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); },
    }, { projectId: "project", tenantId: "tenant", applicationId: "reviews", subject: "owner" });
    let sends = 0, reads = 0;
    const send = async (operation: ReviewOperation): Promise<ReviewWriteResult> => {
      sends++;
      // Stored field ordering differs from the newly created operation.
      expect(pending.load()).toEqual(operation);
      return { status: "unknown" };
    };
    const client = createReviewClient(transport({
      approve: send, upload: send,
      lookup: async operation => {
        reads++;
        return { status: "confirmed", operationId: operation.operationId, reviewId: operation.reviewId };
      },
    }), pending);
    await submit(client);
    await submit(client);
    expect(sends).toBe(1);
    await client.reconcile();
    expect(client.snapshot().mutation.status).toBe("confirmed");
    expect(pending.load()).toBeNull();
    expect(sends).toBe(1);
    expect(reads).toBe(1);
  });
}
`;
