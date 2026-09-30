import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryObjectDigest, type DeliveryBuildManifest, type DeliveryObject } from "./delivery-build-schema";
import { canonical, digest } from "./delivery-files";
import type { DeliveryTarget } from "./delivery-schema";
import { createReleaseEvidence, formatReleaseEvidence } from "./release-evidence";

async function fixture(metadata: Buffer | undefined, run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-integrity-"));
  try {
    const target: DeliveryTarget = {
      name: "api", kind: "api", isolation: "process", roots: ["api"],
      modules: [{ name: "api", reason: "owner", importedBy: [] }], routes: [], jobs: [], externalTokens: [],
      requirements: { processIsolation: true, durableQueue: false, capabilities: [] },
      runtimeStatus: "declared-compatible",
    };
    const entryKind = "bun-http-application" as const;
    const contents = new Map<string, Buffer>([
      ["bundle/index.js", Buffer.from("throw new Error('must not execute');\n")],
      ["bundle/target.json", Buffer.from(canonical({ target, entryKind, deploymentReady: false }))],
    ]);
    if (metadata !== undefined) contents.set("bundle/application-development.json", metadata);
    const object: Omit<DeliveryObject, "objectId"> = {
      name: "api", inputDigest: digest("fixture"), entrypoint: "bundle/index.js", entryKind, runtimeImports: [],
      files: [...contents].map(([path, bytes]) => ({ path, sha256: digest(bytes), bytes: bytes.length }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    const objectId = deliveryObjectDigest(object);
    const manifest: DeliveryBuildManifest = {
      schemaVersion: 1, producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false,
      plan: { schemaVersion: 1, policyVersion: "module-workload-v1", digestScope: "topology-only",
        topologyDigest: digest("topology"), deploymentReady: false, targets: [target] },
      objects: [{ ...object, objectId }], routes: [], jobs: [],
    };
    await mkdir(join(root, "objects", objectId, "bundle"), { recursive: true });
    for (const [path, bytes] of contents) await writeFile(join(root, "objects", objectId, path), bytes);
    const path = join(root, "delivery.manifest.json");
    await writeFile(path, canonical(manifest));
    await run(path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("only an unlisted optional development document is absent", async () => {
  await fixture(undefined, async path => {
    const evidence = await createReleaseEvidence(path, "api");
    expect(evidence.contract.status).toBe("absent");
    expect(formatReleaseEvidence(evidence)).toContain(evidence.rollback.storage);
  });
});

for (const [name, bytes] of [
  ["malformed JSON", Buffer.from("{invalid-private-value")],
  ["invalid nested contract", Buffer.from(JSON.stringify({ schema: "supacloud.application-development.v1", modules: [null] }))],
  ["invalid UTF-8", Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
  ["oversized contract", Buffer.alloc(524_289, 0x20)],
] as const) {
  test(`hash-consistent ${name} is invalid, not absent`, async () => {
    await fixture(bytes, async path => {
      await expect(createReleaseEvidence(path, "api")).rejects.toMatchObject({ code: "RELEASE_EVIDENCE_INVALID" });
    });
  });
}

test("manifest failures expose only the stable error code", async () => {
  await expect(createReleaseEvidence("/not-present/private-value/delivery.manifest.json", "api"))
    .rejects.toMatchObject({ message: "RELEASE_EVIDENCE_INVALID", code: "RELEASE_EVIDENCE_INVALID" });
});
