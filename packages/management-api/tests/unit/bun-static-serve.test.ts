import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFetchHandler } from "../../src/utils/bun-static-serve";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-static-test-"));
  roots.push(root);
  return root;
}

describe("bun-static-serve", () => {
  test("prefers flat route html over a directory collision", async () => {
    const root = await createRoot();
    await writeFile(join(root, "index.html"), "index");
    await mkdir(join(root, "dashboard"), { recursive: true });
    await writeFile(join(root, "dashboard.html"), "dashboard");

    const handler = createFetchHandler(root);
    const response = await handler(new Request("http://localhost/dashboard"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dashboard");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("falls back to directory index when flat html is absent", async () => {
    const root = await createRoot();
    await writeFile(join(root, "index.html"), "index");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "index.html"), "docs");

    const handler = createFetchHandler(root);
    const response = await handler(new Request("http://localhost/docs"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("docs");
  });

  test("serves spa fallback when no route file exists", async () => {
    const root = await createRoot();
    await writeFile(join(root, "index.html"), "index");

    const handler = createFetchHandler(root);
    const response = await handler(new Request("http://localhost/settings"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("index");
  });

  test("rejects malformed percent-encoded paths", async () => {
    const root = await createRoot();
    await writeFile(join(root, "index.html"), "index");

    const handler = createFetchHandler(root);
    const response = await handler(new Request("http://localhost/%E0%A4%A"));

    expect(response.status).toBe(400);
  });

  test("returns headers without a body for static file HEAD requests", async () => {
    const root = await createRoot();
    await writeFile(join(root, "asset.txt"), "asset");

    const handler = createFetchHandler(root);
    const response = await handler(new Request("http://localhost/asset.txt", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("");
  });

  test("returns headers without a body for SPA fallback HEAD requests", async () => {
    const root = await createRoot();
    await writeFile(join(root, "index.html"), "index");

    const handler = createFetchHandler(root);
    const response = await handler(new Request("http://localhost/settings", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("");
  });
});
