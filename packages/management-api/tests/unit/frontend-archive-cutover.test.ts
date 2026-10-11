// @supacloud-test-isolate - exercises real archive files and a CLI subprocess.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";
import { readFrontendTarZstd } from "@supacloud/delivery/frontend-archive-reader";
import {
  decodeLegacyFrontendZip, planFrontendArchiveCutover, prepareFrontendArchiveCutover,
} from "../../scripts/lib/frontend-archive-cutover";
import { stableSha256 } from "../../src/utils/stable-json";

const scope = { projectRef: "demo", deploymentId: "web" };
const oldId = "11234567-89ab-4def-8123-456789abcdef";
const currentId = "21234567-89ab-4def-8123-456789abcdef";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const timestamp = "2026-10-10T00:00:00.000Z";
const script = new URL("../../scripts/frontend-archive-cutover.ts", import.meta.url).pathname;

function zip(
  entries: Array<[string, string]>,
  fault?: "crc" | "encrypted" | "symlink" | "oversized",
  stored = false,
) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const path = Buffer.from(name), source = Buffer.from(content), compressed = stored ? source : deflateRawSync(source);
    const crc = fault === "crc" ? 0 : Bun.hash.crc32(source);
    const size = fault === "oversized" ? 301 * 1024 * 1024 : source.byteLength;
    const flags = fault === "encrypted" ? 0x801 : 0x800;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.byteLength, 18);
    header.writeUInt32LE(size, 22); header.writeUInt16LE(path.byteLength, 26);
    local.push(header, path, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(stored ? 0 : 8, 10);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.byteLength, 20);
    directory.writeUInt32LE(size, 24); directory.writeUInt16LE(path.byteLength, 28);
    directory.writeUInt32LE(((fault === "symlink" ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, path);
    offset += header.byteLength + path.byteLength + compressed.byteLength;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function treeHash(files: Array<[string, string]>) {
  const tree = createHash("sha256");
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const name = Buffer.from(path), bytes = Buffer.from(text), frame = Buffer.alloc(12);
    frame.writeUInt32BE(name.byteLength, 0); frame.writeBigUInt64BE(BigInt(bytes.byteLength), 4);
    tree.update(frame).update(name).update(Buffer.from(sha256(bytes), "hex"));
  }
  return tree.digest("hex");
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "frontend-cutover-")));
  const sourceDirectory = join(root, "snapshot");
  await mkdir(join(sourceDirectory, "releases"), { recursive: true });
  await Bun.write(join(sourceDirectory, "deployment.json"), JSON.stringify({
    id: scope.deploymentId, project_ref: scope.projectRef, framework: "static",
    env_vars: { PRIVATE_VALUE: "must-not-escape" },
  }));
  const release = async (text: string) => {
    const files: Array<[string, string]> = [["index.html", text], ["assets/app.js", "console.log('ok');"]];
    const bytes = zip(files), id = sha256(bytes);
    const metadata = {
      schema: "supacloud.frontend-release.v1", project_ref: scope.projectRef, deployment_id: scope.deploymentId,
      release_id: id, sha256: id, tree_sha256: treeHash(files),
      size_bytes: bytes.byteLength, file_count: files.length, created_at: timestamp, kind: "prebuilt_static",
    };
    const path = join(sourceDirectory, "releases", id);
    await mkdir(join(path, "build", "assets"), { recursive: true });
    await Bun.write(join(path, "release.json"), JSON.stringify(metadata));
    await Bun.write(join(path, "archive.zip"), bytes);
    for (const [name, contents] of files) await Bun.write(join(path, "build", name), contents);
    return metadata;
  };
  const old = await release("old"), current = await release("current");
  const authority = (artifact: typeof old, activationId: string) => ({
    schema: "supacloud.frontend-active-release.v1" as const,
    project_ref: scope.projectRef, deployment_id: scope.deploymentId,
    release_id: artifact.release_id, sha256: artifact.sha256, tree_sha256: artifact.tree_sha256,
    activation_id: activationId, mutation_id: activationId, activated_at: timestamp,
  });
  const previous = authority(old, oldId), active = authority(current, currentId);
  const mutation = (value: typeof active, before: typeof previous | null) => ({
    projectRef: scope.projectRef, mutationId: value.mutation_id, operation: "frontend.release.activate",
    resourceKey: `v1/frontend_release/${Buffer.from(scope.deploymentId).toString("base64url")}`,
    principal: { type: "project", id: "private-principal" },
    status: "succeeded", responseStatus: 200,
    requestFingerprint: stableSha256({
      project_ref: scope.projectRef, deployment_id: scope.deploymentId, release_id: value.release_id,
      expected_active_release_id: before?.release_id ?? "absent",
      activation_id: value.activation_id, expected_activation_id: before?.activation_id ?? "absent",
    }),
    checkpoint: {
      schema: "supacloud.frontend-release-activation.v1", phase: "route_applied",
      deployment_id: scope.deploymentId, release_id: value.release_id,
      expected_active_release_id: before?.release_id ?? "absent",
      expected_activation_id: before?.activation_id ?? "absent", previous_authority: before,
      previous_route: before ? "release" : "absent", activation_id: value.activation_id, activated_at: timestamp,
    },
    receipt: {
      project_ref: scope.projectRef, deployment_id: scope.deploymentId,
      active_release_id: value.release_id, release_id: value.release_id,
      sha256: value.sha256, tree_sha256: value.tree_sha256, activation_id: value.activation_id,
    },
  });
  const mutations = [mutation(previous, null), mutation(active, previous)];
  await Bun.write(join(sourceDirectory, "active-release.json"), JSON.stringify(active));
  const writeJournal = () => Bun.write(join(sourceDirectory, "project-mutations.json"), JSON.stringify(mutations));
  await writeJournal();
  return { root, sourceDirectory, input: { ...scope, sourceDirectory }, old, current, previous, active, mutations, writeJournal };
}

async function snapshot(root: string) {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(files.filter(file => file.isFile()).map(async file => {
    const path = join(file.parentPath, file.name);
    return [relative(root, path), sha256(new Uint8Array(await Bun.file(path).arrayBuffer()))];
  })).then(entries => entries.sort(([a], [b]) => a!.localeCompare(b!)));
}

test("plans all retained ZIPs with journal-selected current/previous and no writes or secrets", async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.sourceDirectory);
    const plan = await planFrontendArchiveCutover(f.input);
    expect(plan).toEqual(await planFrontendArchiveCutover(f.input));
    expect(plan.current).toEqual(f.active);
    expect(plan.previous).toEqual(f.previous);
    expect(plan.mappings).toHaveLength(2);
    const mapped = (id: string) => plan.mappings.find(item => item.old_release_id === id)!;
    expect(plan.activation_order).toEqual([mapped(f.old.release_id).release_id, mapped(f.current.release_id).release_id]);
    expect(plan.cutover_completed).toBe(false);
    expect(plan.live_routing_verified).toBe(false);
    expect(plan.old_platform_recovery_verified).toBe(false);
    expect(JSON.stringify(plan)).not.toContain("must-not-escape");
    expect(JSON.stringify(plan)).not.toContain("private-principal");
    expect(await snapshot(f.sourceDirectory)).toEqual(before);
    expect(await readdir(f.root)).toEqual(["snapshot"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("prepares a separate approved upload bundle and does not invent active authority or receipts", async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.sourceDirectory);
    const plan = await planFrontendArchiveCutover(f.input), outputDirectory = join(f.root, "prepared");
    expect(await prepareFrontendArchiveCutover({ ...f.input, outputDirectory, approvedDigest: plan.plan_digest })).toEqual(plan);
    expect(await Bun.file(join(outputDirectory, "cutover-plan.json")).json()).toEqual(plan);
    expect((await readdir(outputDirectory)).sort()).toEqual(["archives", "cutover-plan.json", "releases"]);
    for (const mapping of plan.mappings) {
      const bytes = new Uint8Array(await Bun.file(join(outputDirectory, mapping.archive_path)).arrayBuffer());
      expect(sha256(bytes)).toBe(mapping.release_id);
      expect(bytes.byteLength).toBe(mapping.size_bytes);
      expect(await Bun.file(join(outputDirectory, "releases", mapping.release_id, "release.json")).json())
        .toEqual(mapping.release_metadata);
      const target = await mkdtemp(join(f.root, "decoded-"));
      const entries = await readFrontendTarZstd((async function* () { yield bytes; })(), target);
      expect(entries.length).toBe(mapping.file_count);
      expect(await Bun.file(join(target, "index.html")).text())
        .toBe(mapping.old_release_id === f.old.release_id ? "old" : "current");
    }
    expect(await snapshot(f.sourceDirectory)).toEqual(before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("equivalent legacy ZIPs share one deterministic candidate record without losing source mappings", async () => {
  const f = await fixture();
  try {
    const files: Array<[string, string]> = [["index.html", "current"], ["assets/app.js", "console.log('ok');"]];
    const bytes = zip(files, undefined, true), id = sha256(bytes);
    const path = join(f.sourceDirectory, "releases", id);
    await mkdir(join(path, "build", "assets"), { recursive: true });
    await Bun.write(join(path, "archive.zip"), bytes);
    await Bun.write(join(path, "release.json"), JSON.stringify({
      ...f.current, release_id: id, sha256: id, size_bytes: bytes.byteLength, created_at: "2025-01-01T00:00:00.000Z",
    }));
    for (const [name, content] of files) await Bun.write(join(path, "build", name), content);
    const plan = await planFrontendArchiveCutover(f.input);
    const current = plan.mappings.find(item => item.old_release_id === f.current.release_id)!;
    const equivalent = plan.mappings.find(item => item.old_release_id === id)!;
    expect(equivalent.release_id).toBe(current.release_id);
    expect(equivalent.release_metadata).toEqual(current.release_metadata);
    expect(current.release_metadata.created_at).toBe("2025-01-01T00:00:00.000Z");
    const outputDirectory = join(f.root, "prepared");
    await prepareFrontendArchiveCutover({ ...f.input, outputDirectory, approvedDigest: plan.plan_digest });
    expect(await readdir(join(outputDirectory, "archives"))).toHaveLength(2);
    expect(await readdir(join(outputDirectory, "releases"))).toHaveLength(2);
    expect(await Bun.file(join(outputDirectory, "releases", current.release_id, "release.json")).json())
      .toEqual(current.release_metadata);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test.each(["crc", "encrypted", "symlink", "oversized"] as const)("offline ZIP reader rejects %s entries", async fault => {
  await expect(decodeLegacyFrontendZip(zip([["index.html", "ok"]], fault))).rejects.toThrow();
});

test.each(["../index.html", "/index.html", "C:/index.html", "a\\index.html"])("offline ZIP reader rejects unsafe path %s", async path => {
  await expect(decodeLegacyFrontendZip(zip([[path, "bad"]]))).rejects.toThrow();
});

test("offline ZIP reader rejects duplicate paths and non-ZIP input", async () => {
  await expect(decodeLegacyFrontendZip(zip([["index.html", "old"], ["index.html", "new"]]))).rejects.toThrow();
  await expect(decodeLegacyFrontendZip(Buffer.alloc(100))).rejects.toThrow();
});

test.each(["scope", "fingerprint", "receipt", "unresolved", "previous-failed"] as const)(
  "does not guess rollback targets with invalid %s evidence", async fault => {
    const f = await fixture();
    try {
      const current = f.mutations[1]!;
      if (fault === "scope") current.projectRef = "other";
      if (fault === "fingerprint") current.requestFingerprint = "f".repeat(64);
      if (fault === "receipt") current.receipt.activation_id = oldId;
      if (fault === "unresolved") current.status = "outcome_unknown";
      if (fault === "previous-failed") f.mutations[0]!.status = "failed_terminal";
      await f.writeJournal();
      await expect(planFrontendArchiveCutover(f.input)).rejects.toThrow();
      expect(await readdir(f.root)).toEqual(["snapshot"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  },
);

test("tree mismatch and extra files prevent preparation", async () => {
  const f = await fixture();
  try {
    const path = join(f.sourceDirectory, "releases", f.old.release_id, "build", "index.html");
    await Bun.write(path, "bad");
    await expect(planFrontendArchiveCutover(f.input)).rejects.toThrow("retained tree");
    await Bun.write(path, "old");
    await Bun.write(join(f.sourceDirectory, "releases", f.old.release_id, "build", "extra.txt"), "extra");
    await expect(planFrontendArchiveCutover(f.input)).rejects.toThrow("retained tree");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("approval drift and existing output are rejected without changing the source or output", async () => {
  const f = await fixture();
  try {
    const plan = await planFrontendArchiveCutover(f.input), outputDirectory = join(f.root, "existing");
    await mkdir(outputDirectory);
    await Bun.write(join(outputDirectory, "owned.txt"), "preserve");
    await expect(prepareFrontendArchiveCutover({ ...f.input, outputDirectory, approvedDigest: plan.plan_digest })).rejects.toThrow();
    expect(await Bun.file(join(outputDirectory, "owned.txt")).text()).toBe("preserve");
    f.mutations[0]!.principal.id = "changed-but-private";
    await f.writeJournal();
    await expect(prepareFrontendArchiveCutover({
      ...f.input, outputDirectory: join(f.root, "new"), approvedDigest: plan.plan_digest,
    })).rejects.toThrow("plan digest mismatch");
    expect(await Bun.file(join(f.root, "new", "cutover-plan.json")).exists()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("self-referential successful checkpoints never select their own activation as previous", async () => {
  const f = await fixture();
  try {
    const current = f.mutations[1]!;
    current.checkpoint.previous_authority = f.active;
    current.checkpoint.expected_active_release_id = f.active.release_id;
    current.checkpoint.expected_activation_id = f.active.activation_id;
    current.requestFingerprint = stableSha256({
      project_ref: scope.projectRef, deployment_id: scope.deploymentId, release_id: f.active.release_id,
      expected_active_release_id: f.active.release_id, activation_id: f.active.activation_id,
      expected_activation_id: f.active.activation_id,
    });
    await f.writeJournal();
    await expect(planFrontendArchiveCutover(f.input)).rejects.toThrow("activation cannot be verified");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("refuses output within source and snapshot symlinks", async () => {
  const f = await fixture();
  try {
    const plan = await planFrontendArchiveCutover(f.input);
    await expect(prepareFrontendArchiveCutover({
      ...f.input, outputDirectory: join(f.sourceDirectory, "output"), approvedDigest: plan.plan_digest,
    })).rejects.toThrow("separate");
    const path = join(f.sourceDirectory, "releases", f.old.release_id, "build", "index.html");
    await rm(path);
    await symlink(join(f.sourceDirectory, "deployment.json"), path);
    await expect(planFrontendArchiveCutover(f.input)).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("actual CLI plans without optional write flags and rejects ambiguous arguments", async () => {
  const f = await fixture();
  const args = ["--source", f.sourceDirectory, "--project-ref", scope.projectRef, "--deployment-id", scope.deploymentId];
  const run = async (extra: string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args, ...extra], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const result = await run([]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).cutover_completed).toBe(false);
    for (const extra of [["--output", join(f.root, "new")], ["--project-ref", "other"], ["--unknown"]]) {
      expect((await run(extra)).code).toBe(1);
    }
    expect(await readdir(f.root)).toEqual(["snapshot"]);
    const output = join(f.root, "prepared");
    const prepared = await run(["--prepare", "--plan-digest", JSON.parse(result.stdout).plan_digest, "--output", output]);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(await Bun.file(join(output, "cutover-plan.json")).json()).toEqual(JSON.parse(prepared.stdout));
    expect(JSON.parse(prepared.stdout).live_routing_verified).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
