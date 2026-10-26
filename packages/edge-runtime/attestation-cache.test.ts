import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearFunctionFileDigestCache,
  readFunctionFile,
  readFunctionFileDigest,
} from "./trusted-function-files";
import { projectReleaseFunctionManifest } from "./project-release";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), ".supacloud-attestation-cache-"));
  clearFunctionFileDigestCache();
  try {
    return await run(root);
  } finally {
    clearFunctionFileDigestCache();
    await rm(root, { recursive: true, force: true });
  }
}

describe("Function artifact digest cache", () => {
  test("serves a cached digest without materialising the artifact bytes", async () => {
    await withTempRoot(async (root) => {
      const artifactPath = join(root, "index.js");
      const body = "export default { fetch: () => new Response('hi') }";
      await writeFile(artifactPath, body);

      const first = await readFunctionFileDigest(artifactPath);
      expect(first.bytes?.toString()).toBe(body);
      expect(first.sha256).toBe(sha256(body));

      const second = await readFunctionFileDigest(artifactPath);
      expect(second.bytes).toBeUndefined();
      expect(second.sha256).toBe(first.sha256);
      expect(second.metadata.mtimeMs).toBe(first.metadata.mtimeMs);
      expect(second.metadata.size).toBe(first.metadata.size);
    });
  });

  test("re-reads and re-hashes after the artifact changes identity", async () => {
    await withTempRoot(async (root) => {
      const artifactPath = join(root, "index.js");
      await writeFile(artifactPath, "first body");
      const first = await readFunctionFileDigest(artifactPath);

      await writeFile(artifactPath, "second body, longer than the first one");
      const second = await readFunctionFileDigest(artifactPath);
      expect(second.sha256).toBe(sha256("second body, longer than the first one"));
      expect(second.sha256).not.toBe(first.sha256);
      expect(second.bytes?.toString()).toBe("second body, longer than the first one");
    });
  });

  test("honours the byte limit on cached identities", async () => {
    await withTempRoot(async (root) => {
      const artifactPath = join(root, "index.js");
      await writeFile(artifactPath, "0123456789");
      expect((await readFunctionFileDigest(artifactPath, { maxBytes: 10 })).sha256).toBe(sha256("0123456789"));
      await expect(readFunctionFileDigest(artifactPath, { maxBytes: 9 })).rejects.toThrow("byte limit");
    });
  });

  test("readFunctionFile still returns the bytes it just hashed", async () => {
    await withTempRoot(async (root) => {
      const artifactPath = join(root, "index.js");
      await writeFile(artifactPath, "materialised");
      await readFunctionFileDigest(artifactPath);
      const file = await readFunctionFile(artifactPath);
      expect(file.bytes.toString()).toBe("materialised");
      expect(file.sha256).toBe(sha256("materialised"));
    });
  });
});

describe("project release manifest cache", () => {
  function releaseDocument(members: Record<string, { version: string; body: string }>, mutationId: string) {
    const rendered = Object.fromEntries(Object.entries(members).map(([slug, member]) => [slug, {
      config: { verify_jwt: false, version: member.version },
      authority: {
        schema: "supacloud.edge-function-activation.v1",
        activation_id: mutationId,
        activation_generation: 1,
        previous_activation_id: null,
        target_state: "active",
        artifact_sha256: sha256(member.body),
      },
    }]));
    const release = {
      schema: "supacloud.project-function-release.v1",
      project_ref: "cache_project",
      mutation_id: mutationId,
      request_fingerprint: "a".repeat(64),
      members: rendered,
    };
    const canonical = (value: unknown): string => value === null || typeof value !== "object"
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return {
      ...release,
      _supacloud_activation: {
        ...rendered[Object.keys(rendered)[0]!]!.authority,
        artifact_sha256: sha256(canonical(release)),
      },
    };
  }

  test("reuses the parsed members and picks up rewrites", async () => {
    await withTempRoot(async (root) => {
      const projectRoot = join(root, "cache_project");
      await mkdir(projectRoot, { recursive: true });
      const releasePath = join(projectRoot, ".project-release.json");
      const firstMutation = "11111111-1111-4111-8111-111111111111";
      await writeFile(releasePath, JSON.stringify(releaseDocument({ hello: { version: "1", body: "one" } }, firstMutation)));

      const first = await projectReleaseFunctionManifest(projectRoot, "hello");
      expect(first?.config.version).toBe("1");
      const repeat = await projectReleaseFunctionManifest(projectRoot, "hello");
      expect(repeat).toBe(first);

      const secondMutation = "22222222-2222-4222-8222-222222222222";
      await writeFile(releasePath, JSON.stringify(releaseDocument({ hello: { version: "2", body: "two" } }, secondMutation)));
      const rewritten = await projectReleaseFunctionManifest(projectRoot, "hello");
      expect(rewritten?.config.version).toBe("2");
      expect(rewritten?.authority?.activation_id).toBe(secondMutation);
      expect(rewritten).not.toBe(first);
    });
  });

  test("returns null for projects without a release manifest", async () => {
    await withTempRoot(async (root) => {
      expect(await projectReleaseFunctionManifest(root, "hello")).toBeNull();
    });
  });
});