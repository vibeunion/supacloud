import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fromBufferPromise } from "yauzl";
import { readBoundedCutoverFile } from "./frontend-cutover-file";
import {
  assertFrontendArchivePath, createFrontendTarZstd,
  FRONTEND_ARCHIVE_MAX_BYTES, FRONTEND_ARCHIVE_MAX_FILES, FRONTEND_ARCHIVE_MAX_SOURCE_BYTES,
} from "@supacloud/delivery/frontend-archive";
import {
  assertFrontendIdentity, parseActiveRelease, parseActivationCheckpoint, parseReleaseRecord,
  RELEASE_ID_PATTERN, type FrontendActiveReleaseRecord, type FrontendReleaseRecord,
} from "../../src/services/frontend-release-contract";
import { stableSha256, stableStringify } from "../../src/utils/stable-json";

type LegacyRecord = Omit<FrontendReleaseRecord, "schema" | "archive_format"> & {
  schema: "supacloud.frontend-release.v1";
};
interface Scope { projectRef: string; deploymentId: string }
export interface CutoverInput extends Scope { sourceDirectory: string }
interface Mapping {
  old_release_id: string;
  release_id: string;
  tree_sha256: string;
  file_count: number;
  size_bytes: number;
  archive_format: "tar.zst";
  release_metadata: FrontendReleaseRecord;
  archive_path: string;
}
export interface FrontendCutoverPlan {
  schema: "supacloud.frontend-cutover-plan.v1";
  project_ref: string;
  deployment_id: string;
  source_digest: string;
  plan_digest: string;
  current: FrontendActiveReleaseRecord;
  previous: FrontendActiveReleaseRecord | null;
  mappings: Mapping[];
  activation_order: string[];
  cutover_completed: false;
  live_routing_verified: false;
  old_platform_recovery_verified: false;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cutover evidence");
  return value as Record<string, unknown>;
}

function legacyRecord(value: unknown): LegacyRecord {
  const source = record(value);
  if (source.schema !== "supacloud.frontend-release.v1" || Object.keys(source).length !== 10) {
    throw new Error("Cutover source requires exact v1 release metadata");
  }
  parseReleaseRecord({ ...source, schema: "supacloud.frontend-release.v2", archive_format: "tar.zst" });
  return source as unknown as LegacyRecord;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function treeDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort((a, b) => a.localeCompare(b))) {
    const bytes = files.get(path)!;
    const name = Buffer.from(path);
    const frame = Buffer.alloc(12);
    frame.writeUInt32BE(name.byteLength, 0);
    frame.writeBigUInt64BE(BigInt(bytes.byteLength), 4);
    hash.update(frame).update(name).update(Buffer.from(sha256(bytes), "hex"));
  }
  return hash.digest("hex");
}

/** 旧格式只在离线工具中解码，不导入线上上传或存储路径。 */
export async function decodeLegacyFrontendZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.byteLength < 22 || bytes.byteLength > FRONTEND_ARCHIVE_MAX_BYTES) {
    throw new Error("Legacy ZIP exceeds archive limits");
  }
  const zip = await fromBufferPromise(Buffer.from(bytes), { strictFileNames: true, validateEntrySizes: true });
  const files = new Map<string, Uint8Array>();
  const paths = new Set<string>();
  let total = 0;
  try {
    if (zip.entryCount > FRONTEND_ARCHIVE_MAX_FILES) throw new Error("Legacy ZIP exceeds entry limits");
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith("/");
      const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      assertFrontendArchivePath(path);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)
        || ![0, directory ? 0o040000 : 0o100000].includes(type)
        || paths.has(path) || (directory && entry.uncompressedSize !== 0)) {
        throw new Error("Legacy ZIP contains unsupported entries");
      }
      paths.add(path);
      if (directory) continue;
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > FRONTEND_ARCHIVE_MAX_SOURCE_BYTES) {
        throw new Error("Legacy ZIP exceeds source limits");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const stream = await zip.openReadStreamPromise(entry);
      try {
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Invalid ZIP output");
          size += chunk.byteLength;
          if (size > entry.uncompressedSize) throw new Error("Legacy ZIP entry exceeds declared size");
          chunks.push(Buffer.from(chunk));
        }
      } finally { stream.destroy(); }
      if (size !== entry.uncompressedSize) throw new Error("Legacy ZIP entry is truncated");
      const content = Buffer.concat(chunks, size);
      if (Bun.hash.crc32(content) !== entry.crc32) throw new Error("Legacy ZIP CRC mismatch");
      files.set(path, content);
    }
    if (!files.has("index.html")) throw new Error("Legacy ZIP requires index.html");
    return files;
  } finally { zip.close(); }
}

class SnapshotReader {
  readonly observations = new Map<string, string>();
  constructor(readonly root: string) {}

  async bytes(path: string, maximum: number): Promise<Buffer> {
    const absolute = join(this.root, path);
    if (await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error("Snapshot path is not bound");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(maximum)) throw new Error("Snapshot file exceeds limits");
      // 冻结副本也可能漂移；绑定 FD 和已验证的字节上限，不使用可随文件增长的 readFile。
      const bytes = await readBoundedCutoverFile(handle, before.size, maximum);
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || BigInt(bytes.byteLength) !== before.size) throw new Error("Snapshot file changed");
      this.observations.set(`file:${path}`, sha256(bytes));
      return bytes;
    } finally { await handle.close(); }
  }

  async json(path: string): Promise<unknown> {
    return JSON.parse((await this.bytes(path, 8 * 1024 * 1024)).toString("utf8"));
  }

  async entries(path: string) {
    const absolute = join(this.root, path);
    const metadata = await lstat(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(absolute) !== absolute) {
      throw new Error("Snapshot contains an unsafe directory");
    }
    const entries = await readdir(absolute, { withFileTypes: true });
    if (entries.length > FRONTEND_ARCHIVE_MAX_FILES) throw new Error("Snapshot directory exceeds entry limits");
    this.observations.set(`directory:${path}`, stableSha256(entries.map(entry => ({
      name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsafe",
    })).sort((a, b) => a.name.localeCompare(b.name))));
    return entries;
  }

  async verifyUnchanged(): Promise<void> {
    const expected = [...this.observations];
    for (const [key] of expected) {
      const path = key.slice(key.indexOf(":") + 1);
      if (key.startsWith("directory:")) await this.entries(path);
      else await this.bytes(path, FRONTEND_ARCHIVE_MAX_SOURCE_BYTES);
    }
    if (stableStringify([...this.observations].sort()) !== stableStringify(expected.sort())) {
      throw new Error("Snapshot changed during preparation");
    }
  }
}

async function verifyTree(reader: SnapshotReader, path: string, files: ReadonlyMap<string, Uint8Array>) {
  const found = new Set<string>();
  const walk = async (directory: string) => {
    for (const entry of await reader.entries(directory)) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const name = relative(path, child).split(sep).join("/");
        const expected = files.get(name);
        if (!expected || found.size >= FRONTEND_ARCHIVE_MAX_FILES
          || !Buffer.from(expected).equals(await reader.bytes(child, expected.byteLength))) {
          throw new Error("Legacy ZIP content does not match the retained tree");
        }
        found.add(name);
      } else throw new Error("Snapshot tree contains non-regular entries");
    }
  };
  await walk(path);
  if (found.size !== files.size) throw new Error("Legacy ZIP content does not match the retained tree");
}

function successfulCheckpoint(
  scope: Scope, authority: FrontendActiveReleaseRecord, mutations: Record<string, unknown>[],
) {
  const state = mutations.find(item => item.mutationId === authority.mutation_id);
  const checkpoint = state ? parseActivationCheckpoint(state.checkpoint) : null;
  if (!state || !checkpoint || state.projectRef !== scope.projectRef
    || state.operation !== "frontend.release.activate"
    || state.resourceKey !== `v1/frontend_release/${Buffer.from(scope.deploymentId).toString("base64url")}`
    || state.status !== "succeeded" || state.responseStatus !== 200 || checkpoint.phase !== "route_applied"
    || checkpoint.previous_authority?.activation_id === authority.activation_id
    || checkpoint.activation_id !== authority.activation_id || checkpoint.release_id !== authority.release_id
    || checkpoint.deployment_id !== scope.deploymentId || checkpoint.activated_at !== authority.activated_at
    || authority.project_ref !== scope.projectRef || authority.deployment_id !== scope.deploymentId
    || state.requestFingerprint !== stableSha256({
      project_ref: scope.projectRef, deployment_id: scope.deploymentId, release_id: authority.release_id,
      expected_active_release_id: checkpoint.expected_active_release_id,
      activation_id: authority.mutation_id, expected_activation_id: checkpoint.expected_activation_id,
    }) || stableStringify(state.receipt) !== stableStringify({
      project_ref: scope.projectRef, deployment_id: scope.deploymentId, active_release_id: authority.release_id,
      release_id: authority.release_id, sha256: authority.sha256, tree_sha256: authority.tree_sha256,
      activation_id: authority.activation_id,
    })) throw new Error("Successful legacy activation cannot be verified");
  return checkpoint;
}

async function inspect(
  input: CutoverInput,
  archive?: (mapping: Mapping, bytes: Uint8Array) => Promise<void>,
): Promise<{ plan: FrontendCutoverPlan; reader: SnapshotReader }> {
  assertFrontendIdentity(input.projectRef, input.deploymentId);
  const root = resolve(input.sourceDirectory);
  const reader = new SnapshotReader(root);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Cutover source is not a bound directory");
  }
  await reader.entries(".");
  const deployment = record(await reader.json("deployment.json"));
  if (deployment.project_ref !== input.projectRef || deployment.id !== input.deploymentId) {
    throw new Error("Snapshot deployment scope mismatch");
  }
  const current = parseActiveRelease(await reader.json("active-release.json"));
  const rawMutations = await reader.json("project-mutations.json");
  if (!Array.isArray(rawMutations)) throw new Error("Snapshot mutation export is invalid");
  const mutations = rawMutations.map(record);
  if (new Set(mutations.map(state => `${state.projectRef}:${state.mutationId}`)).size !== mutations.length) {
    throw new Error("Snapshot mutation export contains duplicate identities");
  }
  for (const state of mutations) {
    const checkpoint = record(state.checkpoint);
    if (state.projectRef === input.projectRef && state.operation === "frontend.release.activate"
      && (checkpoint.deployment_id === input.deploymentId
        || state.resourceKey === `v1/frontend_release/${Buffer.from(input.deploymentId).toString("base64url")}`)
      && !["succeeded", "failed_terminal"].includes(String(state.status))) {
      throw new Error("Legacy activation remains unresolved");
    }
  }
  const previous = successfulCheckpoint(input, current, mutations).previous_authority;
  if (previous) successfulCheckpoint(input, previous, mutations);
  const mappings: Mapping[] = [];
  const records = new Map<string, LegacyRecord>();
  for (const entry of (await reader.entries("releases")).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".staging" && entry.isDirectory()) {
      if ((await reader.entries("releases/.staging")).length !== 0) throw new Error("Legacy staging is not quiescent");
      continue;
    }
    if (!entry.isDirectory() || !RELEASE_ID_PATTERN.test(entry.name)) throw new Error("Invalid legacy inventory");
    const path = `releases/${entry.name}`;
    const metadata = legacyRecord(await reader.json(`${path}/release.json`));
    if (metadata.project_ref !== input.projectRef || metadata.deployment_id !== input.deploymentId
      || metadata.release_id !== entry.name) throw new Error("Legacy release scope mismatch");
    const bytes = await reader.bytes(`${path}/archive.zip`, FRONTEND_ARCHIVE_MAX_BYTES);
    if (metadata.size_bytes !== bytes.byteLength || metadata.sha256 !== sha256(bytes)) {
      throw new Error("Legacy ZIP digest mismatch");
    }
    const files = await decodeLegacyFrontendZip(bytes);
    if (files.size !== metadata.file_count || treeDigest(files) !== metadata.tree_sha256) {
      throw new Error("Legacy release tree digest mismatch");
    }
    await verifyTree(reader, `${path}/build`, files);
    const candidate = await createFrontendTarZstd(files);
    const releaseId = sha256(candidate);
    const mapping: Mapping = {
      old_release_id: entry.name, release_id: releaseId, tree_sha256: metadata.tree_sha256,
      size_bytes: candidate.byteLength, file_count: files.size, archive_format: "tar.zst",
      release_metadata: {
        schema: "supacloud.frontend-release.v2",
        project_ref: input.projectRef, deployment_id: input.deploymentId,
        release_id: releaseId, sha256: releaseId, tree_sha256: metadata.tree_sha256,
        size_bytes: candidate.byteLength, file_count: files.size, created_at: metadata.created_at,
        kind: "prebuilt_static", archive_format: "tar.zst",
      },
      archive_path: `archives/${releaseId}.tar.zst`,
    };
    records.set(entry.name, metadata);
    mappings.push(mapping);
    await archive?.(mapping, candidate);
  }
  for (const authority of [current, previous]) {
    if (!authority) continue;
    const release = records.get(authority.release_id);
    if (!release || release.sha256 !== authority.sha256 || release.tree_sha256 !== authority.tree_sha256) {
      throw new Error("Legacy authority does not match the retained inventory");
    }
  }
  // 多个旧 ZIP 可归并到同一内容地址；候选记录统一保留最早的源创建时间。
  const candidates = new Map<string, FrontendReleaseRecord>();
  for (const mapping of mappings) {
    const existing = candidates.get(mapping.release_id);
    if (!existing || mapping.release_metadata.created_at < existing.created_at) {
      candidates.set(mapping.release_id, mapping.release_metadata);
    }
  }
  for (const mapping of mappings) mapping.release_metadata = candidates.get(mapping.release_id)!;
  await reader.verifyUnchanged();
  const content = {
    schema: "supacloud.frontend-cutover-plan.v1" as const,
      project_ref: input.projectRef, deployment_id: input.deploymentId,
    source_digest: stableSha256([...reader.observations].sort()),
    current, previous, mappings,
    activation_order: [previous, current].filter((value): value is FrontendActiveReleaseRecord => value !== null)
      .map(value => mappings.find(mapping => mapping.old_release_id === value.release_id)!.release_id),
    cutover_completed: false as const, live_routing_verified: false as const,
    old_platform_recovery_verified: false as const,
  };
  return { plan: { ...content, plan_digest: stableSha256(content) }, reader };
}

export async function planFrontendArchiveCutover(input: CutoverInput): Promise<FrontendCutoverPlan> {
  return (await inspect(input)).plan;
}

export async function prepareFrontendArchiveCutover(
  input: CutoverInput & { approvedDigest: string; outputDirectory: string },
): Promise<FrontendCutoverPlan> {
  const plan = await planFrontendArchiveCutover(input);
  if (input.approvedDigest !== plan.plan_digest) throw new Error("Approved cutover plan digest mismatch");
  const source = resolve(input.sourceDirectory), output = resolve(input.outputDirectory);
  if ([relative(source, output), relative(output, source)].some(path => path === "" || (!path.startsWith(`..${sep}`) && path !== ".."))) {
    throw new Error("Cutover output must be separate from its source");
  }
  const outputParent = dirname(output);
  if (await realpath(outputParent) !== outputParent) throw new Error("Cutover output parent is not bound");
  const parent = await lstat(outputParent);
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0
    || ![0, process.geteuid?.()].includes(parent.uid)) {
    throw new Error("Cutover output requires a trusted private parent");
  }
  // mkdir 独占保留输出，不覆盖已有目录；失败保留不含完成清单的候选文件供排查。
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, "archives"), { mode: 0o700 });
  const prepared = await inspect(input, async (mapping, bytes) => {
    const path = join(output, mapping.archive_path);
    await Bun.write(path, bytes);
    if (sha256(new Uint8Array(await Bun.file(path).arrayBuffer())) !== mapping.release_id) {
      throw new Error("Cutover archive readback mismatch");
    }
  });
  if (prepared.plan.plan_digest !== input.approvedDigest) throw new Error("Snapshot changed after plan approval");
  const written = new Set<string>();
  for (const mapping of prepared.plan.mappings) {
    if (written.has(mapping.release_id)) continue;
    const releaseDirectory = join(output, "releases", mapping.release_id);
    await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
    await Bun.write(join(releaseDirectory, "release.json"), `${JSON.stringify(mapping.release_metadata, null, 2)}\n`);
    written.add(mapping.release_id);
  }
  await prepared.reader.verifyUnchanged();
  await Bun.write(join(output, "cutover-plan.json"), `${JSON.stringify(prepared.plan, null, 2)}\n`);
  return prepared.plan;
}
