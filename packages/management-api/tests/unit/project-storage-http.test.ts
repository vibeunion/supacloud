import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { S3Client } from "bun";
import { createProjectStorageConfigRoutes, type ProjectStorageRouteDependencies } from "../../src/routes/project-storage-config";
import { parseProjectS3Settings, publicProjectStorage, type ProjectS3Configuration } from "../../src/services/project-storage-contract";
import { ProjectS3Driver } from "../../src/services/project-s3-driver";

const credentials = { accessKeyId: "project-key", secretAccessKey: "not-for-responses" };
const configuration: ProjectS3Configuration = {
  ...parseProjectS3Settings({ ...credentials, endpoint: "https://storage.example.test", region: "us-east-2", bucket: "project-assets" }),
  version: 1, projectRef: "projecta", revision: crypto.randomUUID(),
};

function managementFixture(allowed = true) {
  const calls: string[] = [];
  const dependencies: ProjectStorageRouteDependencies = {
    authorize: async () => allowed ? undefined : { status: 403, body: { error: "Forbidden" } },
    storage: {
      async get(ref) { calls.push(`get:${ref}`); return publicProjectStorage(configuration); },
      async put(ref, _settings, _expected) { calls.push(`put:${ref}`); return publicProjectStorage(configuration); },
      async probe(ref) { calls.push(`probe:${ref}`); return { backend: "s3", reachable: true, listable: true, writable: "not_tested" }; },
    },
  };
  const app = new Elysia().use(createProjectStorageConfigRoutes(dependencies))
    .get("/unrelated", () => "unrelated");
  return { app, dependencies, calls };
}

const configUrl = "http://localhost/v1/projects/projecta/storage/config";

test("project storage config requires admin before processing credential JSON or probing", async () => {
  const { app, calls } = managementFixture(false);
  for (const [url, method] of [[configUrl, "GET"], [configUrl, "PUT"], [`${configUrl}/probe`, "POST"]] as const) {
    const response = await app.handle(new Request(url, { method, ...(method === "PUT" ? { body: '{"secret":"not-for-responses"' } : {}) }));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("not-for-responses");
  }
  expect(calls).toEqual([]);
  const unrelated = await app.handle(new Request("http://localhost/unrelated"));
  expect(unrelated.status).toBe(200);
});

test("project storage config rejects malformed and oversized bodies without reflecting credentials", async () => {
  const { app, calls } = managementFixture();
  for (const body of ['{"secret":"not-for-responses"', JSON.stringify({ settings: credentials }), "x".repeat(32769)]) {
    const response = await app.handle(new Request(configUrl, { method: "PUT", body }));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify({ code: "STORAGE_CONFIG_INVALID", message: "STORAGE_CONFIG_INVALID" }));
  }
  expect(calls).toEqual([]);
});

test("project storage summaries and unexpected failures never expose credentials", async () => {
  const { app, dependencies } = managementFixture();
  const response = await app.handle(new Request(configUrl, { method: "PUT", body: JSON.stringify({ expected_revision: null, settings: configuration }) }));
  expect(response.status).toBe(200);
  const summary = await response.text();
  expect(summary).not.toContain(credentials.secretAccessKey);
  expect(summary).not.toContain(credentials.accessKeyId);
  dependencies.storage.get = async () => { throw new Error(`secret=${credentials.secretAccessKey}`); };
  const failure = await app.handle(new Request(configUrl));
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain(credentials.secretAccessKey);
});

function s3Fixture(accessKey: string) {
  const objects = new Map<string, Uint8Array>();
  const contentTypes = new Map<string, string>();
  const authorizations: string[] = [];
  const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const authorization = request.headers.get("authorization") ?? "";
    authorizations.push(authorization);
    if (!authorization.includes(`Credential=${accessKey}/`)) return new Response("AccessDenied", { status: 403 });
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname).replace(/^\/project-assets\//, "");
    if (request.method === "PUT") {
      objects.set(key, new Uint8Array(await request.arrayBuffer()));
      contentTypes.set(key, request.headers.get("content-type") ?? "application/octet-stream");
      return new Response(null, { headers: { ETag: '"fixture"' } });
    }
    if (request.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((item) => item.startsWith(prefix));
      return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>project-assets</Name><IsTruncated>false</IsTruncated>${keys.map((item) => `<Contents><Key>${xml(item)}</Key><Size>${objects.get(item)!.byteLength}</Size><ETag>"fixture"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`).join("")}</ListBucketResult>`, { headers: { "Content-Type": "application/xml" } });
    }
    const bytes = objects.get(key);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(request.method === "HEAD" ? null : Uint8Array.from(bytes), { headers: { "Content-Type": contentTypes.get(key)!, "Content-Length": String(bytes.byteLength), ETag: '"fixture"', "Last-Modified": "Thu, 01 Jan 2026 00:00:00 GMT" } });
  } });
  return { server, objects, authorizations };
}

test("real Bun S3 clients keep concurrent projects on separate signed HTTP backends", async () => {
  const a = s3Fixture("key-a"), b = s3Fixture("key-b");
  try {
    const driver = (ref: string, fixture: typeof a, key: string) => {
      const cfg: ProjectS3Configuration = { ...configuration, projectRef: ref, endpoint: fixture.server.url.origin, accessKeyId: key };
      return new ProjectS3Driver(cfg, new S3Client({ endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region,
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: "", virtualHostedStyle: false }));
    };
    const da = driver("projecta", a, "key-a"), db = driver("projectb", b, "key-b");
    await Promise.all([da.uploadFile("projecta", "avatars", "same.txt", new TextEncoder().encode("A"), "text/plain"),
      db.uploadFile("projectb", "avatars", "same.txt", new TextEncoder().encode("B"), "text/plain")]);
    const downloaded = await da.getDownloadResponse("projecta", "avatars", "same.txt");
    expect(downloaded!.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await downloaded!.text()).toBe("A");
    await da.copyFile("projecta", "avatars", "same.txt", "copies", "copied.bin");
    const copied = await da.getDownloadResponse("projecta", "copies", "copied.bin");
    expect(copied!.headers.get("content-type")).toBe(downloaded!.headers.get("content-type"));
    expect(await copied!.text()).toBe("A");
    expect(await (await db.getDownloadResponse("projectb", "avatars", "same.txt"))!.text()).toBe("B");
    expect((await da.listFiles("projecta", "avatars")).map((entry) => entry.name)).toEqual(["same.txt"]);
    await da.emptyBucket("projecta", "avatars");
    await da.emptyBucket("projecta", "copies");
    expect(a.objects.size).toBe(0);
    expect(b.objects.size).toBe(1);
    expect(a.authorizations.every((value) => value.includes("Credential=key-a/"))).toBe(true);
    expect(b.authorizations.every((value) => value.includes("Credential=key-b/"))).toBe(true);
  } finally { await a.server.stop(true); await b.server.stop(true); }
});
