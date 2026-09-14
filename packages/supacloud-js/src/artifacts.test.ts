import { describe, expect, mock, spyOn, test } from "bun:test";
import { createSupaCloudClient } from "./index";
import { createClient } from "@supabase/supabase-js";
import { artifactTimestampMicros, decodeArtifactRead } from "./artifact-read";
import { captureArtifactRegister, decodeArtifactRegister } from "./artifact-register";
import { captureArtifactLink, decodeArtifactLink } from "./artifact-link";

function artifactClient(errorStatus = 403) {
  const rpc = mock(async (functionName: string, params: { request: object }): Promise<{ data: unknown; error: unknown }> => ({
    data: functionName === "supacloud_artifact_get" ? null : { functionName, params }, error: null,
  }));
  const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || !("request" in body)
      || body.request === null || typeof body.request !== "object") throw new Error("Invalid artifact request");
    const result = await rpc(new URL(request.url).pathname.split("/").at(-1) ?? "", { request: body.request });
    return Response.json(result.error ?? result.data, { status: result.error ? errorStatus : 200 });
  }, { preconnect: globalThis.fetch.preconnect });
  const supabase = createClient("http://local", "synthetic-key", {
    global: { fetch: transport },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    artifacts: createSupaCloudClient({
      supabase,
      managementApiUrl: "http://management-not-used",
      projectRef: "project-ref",
    }).artifacts,
    rpc,
  };
}

describe("SupaCloud artifact registry client", () => {
  test("maps register, get, and lineage link to RPCs", async () => {
    const { artifacts, rpc } = artifactClient();
    rpc.mockResolvedValueOnce({ data: {
      ...validArtifact(), artifactId: "11111111-1111-4111-8111-111111111111", sizeBytes: "1024", parents: [],
    }, error: null });
    await artifacts.register({
      artifactId: "11111111-1111-4111-8111-111111111111",
      bucketId: "reports",
      objectPath: "2026/report.pdf",
      artifactType: "report.pdf",
      sha256: "a".repeat(64),
      sizeBytes: "1024",
      mimeType: "application/pdf",
    });
    await artifacts.get("11111111-1111-4111-8111-111111111111");
    rpc.mockResolvedValueOnce({ data: {
      ...validArtifact(), artifactId: "11111111-1111-4111-8111-111111111111",
      parents: [{ artifactId: "22222222-2222-4222-8222-222222222222",
        relationType: "rendered_from", metadata: {}, createdAt: validArtifact().createdAt }],
    }, error: null });
    await artifacts.link({
      parentArtifactId: "22222222-2222-4222-8222-222222222222",
      childArtifactId: "11111111-1111-4111-8111-111111111111",
      relationType: "rendered_from",
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]?.[0]).toBe("supacloud_artifact_register");
    expect(rpc.mock.calls[1]?.[0]).toBe("supacloud_artifact_get");
    expect(rpc.mock.calls[2]?.[0]).toBe("supacloud_artifact_link");
  });

  test("captures lineage input and rejects self links, accessors and invalid metadata before dispatch", async () => {
    const { artifacts, rpc } = artifactClient();
    let reads = 0;
    for (const value of [
      {}, null, [], { ...linkRequest(), extra: true },
      ...[
        { parentArtifactId: artifactId.toUpperCase() }, { parentArtifactId: "bad" },
        { childArtifactId: 1 }, { relationType: "" }, { relationType: "bad type" },
        { relationType: "a".repeat(121) }, { metadata: [] },
      ].map(patch => ({ ...linkRequest(), ...patch })),
      Object.defineProperty(linkRequest(), "metadata", { enumerable: true, get() { reads++; return {}; } }),
    ]) {
      await expect(Reflect.apply(artifacts.link, artifacts, [value])).rejects.toMatchObject({
        code: "ARTIFACT_LINK_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(reads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const request = { ...linkRequest(), relationType: " derived_from ", childArtifactId: artifactId.toUpperCase() };
    rpc.mockResolvedValueOnce({ data: validArtifact(), error: null });
    const pending = artifacts.link(request);
    request.metadata.changed = true;
    request.relationType = "other";
    expect(await pending).toEqual(validArtifact());
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: linkRequest() });
  });

  test("binds lineage receipts to both endpoints, relation and captured metadata", () => {
    const request = captureArtifactLink(linkRequest());
    const receipt = validArtifact();
    const parent = receipt.parents[0];
    if (!parent) throw new Error("Expected parent");
    for (const value of [
      null, {}, { ...receipt, artifactId: request.parentArtifactId }, { ...receipt, parents: [] },
      ...[
        { artifactId: "cccccccc-0000-0000-0000-000000000001" },
        { relationType: "other" }, { metadata: { changed: true } },
      ].map(patch => ({ ...receipt, parents: [{ ...parent, ...patch }] })),
      { ...receipt, parents: [parent, parent] },
    ]) {
      expect(() => decodeArtifactLink(value, request)).toThrow("Artifact link could not be validated");
    }
    const replay = { ...receipt, idempotent: true, parents: [parent, { ...parent, relationType: "other" }] };
    expect(decodeArtifactLink(replay, request)).toEqual(replay);
  });

  test("does not retry uncertain links and preserves SQL cycle/conflict rejection", async () => {
    const failed = artifactClient(503);
    failed.rpc.mockResolvedValueOnce({ data: null, error: { message: "private failure" } });
    await expect(failed.artifacts.link(linkRequest())).rejects.toMatchObject({
      code: "ARTIFACT_LINK_UNCONFIRMED", mutationMayHaveApplied: true,
    });
    expect(failed.rpc).toHaveBeenCalledTimes(1);
    for (const code of ["23514", "23505"]) {
      const explicit = artifactClient(409);
      explicit.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "conflict" } });
      await expect(explicit.artifacts.link(linkRequest())).rejects.toMatchObject({ code });
      expect(explicit.rpc).toHaveBeenCalledTimes(1);
    }
  });

  test("bounds all artifact fetch/body waits with operation-specific uncertainty", async () => {
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(
      (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        original(callback, delay === 15000 ? 20 : delay, ...args),
      { __promisify__: original.__promisify__ },
    ));
    try {
      for (const operation of ["get", "register", "link"]) for (const mode of ["fetch", "body"]) {
        let calls = 0;
        let signal: AbortSignal | undefined;
        let deliver: ((response: Response) => void) | undefined;
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          signal = new Request(input, init).signal;
          if (mode === "body") return new Response(new ReadableStream<Uint8Array>({
            start(controller) { body = controller; },
          }), { headers: { "content-type": "application/json" } });
          return new Promise<Response>(resolve => { deliver = resolve; });
        }, { preconnect: globalThis.fetch.preconnect });
        const supabase = createClient("http://local", "synthetic-key", {
          global: { fetch: transport },
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const artifacts = createSupaCloudClient({
          supabase, managementApiUrl: "http://management-not-used", projectRef: "fixture",
        }).artifacts;
        try {
          const pending = operation === "get" ? artifacts.get(artifactId)
            : operation === "register" ? artifacts.register(registerRequest()) : artifacts.link(linkRequest());
          await expect(pending).rejects.toMatchObject({
            code: operation === "get" ? "ARTIFACT_READ_INVALID"
              : operation === "register" ? "ARTIFACT_REGISTER_UNCONFIRMED" : "ARTIFACT_LINK_UNCONFIRMED",
            mutationMayHaveApplied: operation !== "get",
          });
          expect(calls).toBe(1);
          expect(signal?.aborted).toBe(true);
        } finally {
          deliver?.(Response.json(null));
          body?.enqueue(new TextEncoder().encode("null"));
          body?.close();
          await new Promise(resolve => original(resolve, 0));
        }
      }
    } finally { timers.mockRestore(); }
  });

  test("captures registration inputs and rejects unsafe sizes, paths and metadata without dispatch", async () => {
    const { artifacts, rpc } = artifactClient();
    let reads = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      null, [], {}, { ...registerRequest(), extra: true },
      ...[
        { artifactId: "bad" }, { bucketId: " " }, { objectPath: "../report.pdf" },
        { objectPath: "/report.pdf" }, { objectPath: "a\\b" }, { artifactType: "bad type" },
        { sha256: "x".repeat(64) }, { mimeType: "" }, { mimeType: "a".repeat(256) },
        { metadata: [] }, { metadata: cyclic }, { createdBy: null }, { createdBy: "bad" },
        { retentionUntil: "2026-02-30T00:00:00Z" }, { retentionUntil: null },
        ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "00", "-1", "9223372036854775808"]
          .map(sizeBytes => ({ sizeBytes })),
      ].map(patch => ({ ...registerRequest(), ...patch })),
      Object.defineProperty(registerRequest(), "metadata", { enumerable: true, get() { reads++; return {}; } }),
    ]) {
      await expect(Reflect.apply(artifacts.register, artifacts, [value])).rejects.toMatchObject({
        code: "ARTIFACT_REGISTER_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(reads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const request = {
      ...registerRequest(), artifactId: artifactId.toUpperCase(), bucketId: " reports ",
      objectPath: " 2026/report.pdf ", sha256: " " + "A".repeat(64) + " ",
      mimeType: " APPLICATION/PDF ", sizeBytes: 1024,
    };
    rpc.mockResolvedValueOnce({ data: { ...validArtifact(), parents: [], sizeBytes: "1024" }, error: null });
    const pending = artifacts.register(request);
    request.metadata.changed = true;
    request.objectPath = "changed";
    expect(await pending).toMatchObject({ objectPath: "2026/report.pdf", sizeBytes: "1024" });
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      request: { ...registerRequest(), sizeBytes: "1024", retentionUntil: null, createdBy: null },
    });
  });

  test("binds all registered fields and permits idempotent replay with later lineage", () => {
    const receipt = { ...validArtifact(), parents: [] };
    const request = captureArtifactRegister(registerRequest());
    expect(decodeArtifactRegister(receipt, request)).toEqual(receipt);
    expect(decodeArtifactRegister({ ...validArtifact(), idempotent: true }, request))
      .toEqual({ ...validArtifact(), idempotent: true });
    for (const patch of [
      { bucketId: "other" }, { objectPath: "other.pdf" }, { artifactType: "other" },
      { sha256: "b".repeat(64) }, { sizeBytes: "1" }, { mimeType: "text/plain" },
      { createdBy: "bbbbbbbb-0000-0000-0000-000000000001" }, { metadata: { changed: true } },
      { retentionUntil: "2030-01-01T00:00:00Z" }, { parents: validArtifact().parents },
    ]) {
      expect(() => decodeArtifactRegister({ ...receipt, ...patch }, request))
        .toThrow("Artifact registration could not be validated");
    }
    expect(() => decodeArtifactRegister(null, request)).toThrow();
  });

  test("compares retention instants with microsecond precision and timezone equivalence", () => {
    const request = captureArtifactRegister({
      ...registerRequest(), retentionUntil: "2030-01-01T08:00:00.123456+08:00",
    });
    const receipt = { ...validArtifact(), parents: [], retentionUntil: "2030-01-01T00:00:00.123456Z" };
    expect(decodeArtifactRegister(receipt, request)).toEqual(receipt);
    expect(() => decodeArtifactRegister({
      ...receipt, retentionUntil: "2030-01-01T00:00:00.123457Z",
    }, request)).toThrow();
    expect(() => decodeArtifactRead({
      ...receipt, createdAt: "2030-01-01T00:00:00.123457Z",
    }, artifactId)).toThrow();
    expect(decodeArtifactRead({ ...receipt, createdAt: receipt.retentionUntil }, artifactId)).not.toBeNull();
    expect(artifactTimestampMicros("1969-12-31T23:59:59.999999Z")).toBe(-1n);
    expect(artifactTimestampMicros("1970-01-01T00:00:00.000001Z")).toBe(1n);
  });

  test("does not retry failed registrations and preserves explicit conflicts", async () => {
    const { artifacts, rpc } = artifactClient(503);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "private failure", code: "private" } });
    await expect(artifacts.register(registerRequest())).rejects.toMatchObject({
      code: "ARTIFACT_REGISTER_UNCONFIRMED", mutationMayHaveApplied: true,
      message: "Artifact registration could not be validated",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const conflict = artifactClient(409);
    conflict.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "conflict" } });
    await expect(conflict.artifacts.register(registerRequest())).rejects.toMatchObject({ code: "23505" });
    expect(conflict.rpc).toHaveBeenCalledTimes(1);
  });

  test("validates IDs without dispatch and preserves full PostgreSQL UUID and size ranges", async () => {
    const { artifacts, rpc } = artifactClient();
    for (const value of ["bad", "", 1, null, {}, " " + artifactId]) {
      await expect(Reflect.apply(artifacts.get, artifacts, [value])).rejects.toMatchObject({
        code: "ARTIFACT_READ_INPUT_INVALID", mutationMayHaveApplied: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(await artifacts.get(artifactId.toUpperCase())).toBeNull();
    expect(rpc.mock.calls[0]?.[1]).toEqual({ request: { artifactId } });
    for (const sizeBytes of ["0", "9007199254740993", "9223372036854775807"]) {
      const receipt = { ...validArtifact(), sizeBytes };
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      expect(await artifacts.get(artifactId)).toEqual(receipt);
    }
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(artifacts.get(artifactId)).rejects.toMatchObject({ code: "42501" });
  });

  test("rejects malformed artifact fields and invalid lineage", async () => {
    const { artifacts, rpc } = artifactClient();
    const receipt = validArtifact(), parent = receipt.parents[0];
    for (const value of [
      {}, [], false,
      ...[
        { artifactId: "11111111-1111-4111-8111-111111111111" }, { idempotent: true },
        { bucketId: "" }, { objectPath: "/absolute" }, { objectPath: "a/../b" },
        { objectPath: "a/./b" }, { objectPath: "a\\b" }, { objectVersion: null },
        { artifactType: "bad type" }, { sha256: "A".repeat(64) }, { sha256: "a".repeat(63) },
        ...[0, 9007199254740992, "-1", "00", "01", "1.0", "9223372036854775808"]
          .map(sizeBytes => ({ sizeBytes })),
        { mimeType: "" }, { mimeType: "a".repeat(256) }, { metadata: [] },
        { metadata: null }, { createdBy: undefined }, { createdBy: "invalid" },
        { createdAt: "2026-02-30T00:00:00Z" }, { retentionUntil: undefined },
        { parents: null }, { parents: [parent, parent] },
        { parents: [{ ...parent, artifactId }] },
        { parents: [{ ...parent, relationType: "bad relation" }] },
        { parents: [{ ...parent, metadata: [] }] },
        { parents: [{ ...parent, createdAt: null }] },
      ].map(patch => ({ ...receipt, ...patch })),
    ]) {
      rpc.mockResolvedValueOnce({ data: value, error: null });
      await expect(artifacts.get(artifactId)).rejects.toMatchObject({
        code: "ARTIFACT_READ_INVALID", mutationMayHaveApplied: false,
      });
    }
  });

  test("detaches metadata, strips extras, and permits multiple relation types for one parent", () => {
    const receipt = validArtifact();
    const parent = receipt.parents[0];
    if (!parent) throw new Error("Expected parent fixture");
    receipt.parents.push({ ...parent, relationType: "source" });
    const decoded = decodeArtifactRead({ ...receipt, ignored: true }, artifactId);
    expect(decoded).toEqual(receipt);
    receipt.metadata.changed = true;
    parent.metadata.changed = true;
    expect(decoded?.metadata).toEqual({});
    expect(decoded?.parents[0]?.metadata).toEqual({});
    let reads = 0;
    const accessor = Object.defineProperty({}, "artifactId", { enumerable: true, get() { reads++; return artifactId; } });
    expect(() => decodeArtifactRead(accessor, artifactId)).toThrow();
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => decodeArtifactRead({ ...receipt, metadata: cyclic }, artifactId)).toThrow();
  });
});

const artifactId = "aaaaaaaa-0000-0000-0000-000000000001";
function linkRequest() {
  const metadata: Record<string, unknown> = {};
  return {
    parentArtifactId: "bbbbbbbb-0000-0000-0000-000000000001", childArtifactId: artifactId,
    relationType: "derived_from", metadata,
  };
}
function registerRequest() {
  const metadata: Record<string, unknown> = {};
  return {
    artifactId, bucketId: "reports", objectPath: "2026/report.pdf", artifactType: "report.pdf",
    sha256: "a".repeat(64), sizeBytes: "9007199254740993", mimeType: "application/pdf", metadata,
  };
}
function validArtifact() {
  const metadata: Record<string, unknown> = {}, parentMetadata: Record<string, unknown> = {};
  return {
    artifactId, bucketId: "reports", objectPath: "2026/report.pdf", objectVersion: "v1",
    artifactType: "report.pdf", sha256: "a".repeat(64), sizeBytes: "9007199254740993",
    mimeType: "application/pdf", metadata, retentionUntil: null, createdBy: null,
    createdAt: "2026-09-10T00:00:00.123456Z", idempotent: false,
    parents: [{
      artifactId: "bbbbbbbb-0000-0000-0000-000000000001", relationType: "derived_from",
      metadata: parentMetadata, createdAt: "2026-09-10T00:00:01Z",
    }],
  };
}
