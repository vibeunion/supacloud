import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  canonicalPostgrestConfig,
  postgrestConfigRevision,
  revisionHex,
} from "./runtime-revision";

const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,64}$/;
const GENERATION_TARGET_PATTERN = /^([a-z0-9-]{1,64})_postgrest\.d\/([a-f0-9]{64})\.conf$/;
const MANAGED_POSTGREST_CONFIG_PREFIX = "# Managed by SupaCloud Management API.";

export interface PostgrestGenerationLayout {
  generationDirectory: string;
  generationPath: string;
  pointerPath: string;
  pointerTarget: string;
}

export interface ActivatePostgrestGenerationRequest {
  tenantDirectory: string;
  projectRef: string;
  content: string;
  expectedPreviousPointerTarget?: string | null;
  controlOwnerUid: number;
  runtimeGroupGid: number;
  setControlOwnership: (path: string) => Promise<void>;
}

export interface ActivatedPostgrestGeneration {
  revision: string;
  layout: PostgrestGenerationLayout;
  previousPointerTarget: string | null;
  ownership: PostgrestControlOwnership;
}

export interface PostgrestControlOwnership {
  controlOwnerUid: number;
  runtimeGroupGid: number;
}

export interface RemovePostgrestPointerRequest {
  layout: PostgrestGenerationLayout;
  projectRef: string;
  expectedPointerTarget: string;
  ownership: PostgrestControlOwnership;
}

export interface ReadCurrentPostgrestGenerationRequest {
  tenantDirectory: string;
  projectRef: string;
  controlOwnerUid: number;
  runtimeOwnerUid: number;
  runtimeGroupGid: number;
  setControlOwnership: (path: string) => Promise<void>;
}

function assertProjectRef(projectRef: string): void {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error("Invalid PostgREST project reference");
  }
}

export function postgrestGenerationLayout(
  tenantDirectory: string,
  projectRef: string,
  revision: string,
): PostgrestGenerationLayout {
  assertProjectRef(projectRef);
  const digest = revisionHex(revision);
  const generationDirectory = join(tenantDirectory, `${projectRef}_postgrest.d`);
  const pointerTarget = `${projectRef}_postgrest.d/${digest}.conf`;
  return {
    generationDirectory,
    generationPath: join(generationDirectory, `${digest}.conf`),
    pointerPath: join(tenantDirectory, `${projectRef}_postgrest.current`),
    pointerTarget,
  };
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function syncPath(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function assertControlMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  mode: number,
  ownership: PostgrestControlOwnership,
  label: string,
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== ownership.controlOwnerUid
    || metadata.gid !== ownership.runtimeGroupGid
    || (Number(metadata.mode) & 0o7777) !== mode) {
    throw new Error(`${label} has unsafe metadata`);
  }
}

function assertControlDirectoryMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  ownership: PostgrestControlOwnership,
): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== ownership.controlOwnerUid
    || metadata.gid !== ownership.runtimeGroupGid
    || (Number(metadata.mode) & 0o7777) !== 0o750) {
    throw new Error("PostgREST generation directory has unsafe metadata");
  }
}

async function assertImmutableGeneration(
  path: string,
  expectedContent: string,
  ownership: PostgrestControlOwnership,
): Promise<void> {
  const [metadata, content] = await Promise.all([lstat(path), readFile(path, "utf8")]);
  assertControlMetadata(metadata, 0o440, ownership, "Existing PostgREST generation");
  if (content !== expectedContent) {
    throw new Error("Existing PostgREST generation does not match its revision");
  }
}

function assertLegacyGenerationMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  runtimeOwnerUid: number,
  runtimeGroupGid: number,
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== runtimeOwnerUid
    || metadata.gid !== runtimeGroupGid
    || (Number(metadata.mode) & 0o7777) !== 0o600) {
    throw new Error("Legacy PostgREST generation has unsafe metadata");
  }
}

async function createImmutableGeneration(
  layout: PostgrestGenerationLayout,
  content: string,
  ownership: PostgrestControlOwnership,
  setControlOwnership: (path: string) => Promise<void>,
): Promise<void> {
  const temporaryPath = join(
    layout.generationDirectory,
    `.${basename(layout.generationPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o440, flag: "wx" });
    await chmod(temporaryPath, 0o440);
    await setControlOwnership(temporaryPath);
    await syncPath(temporaryPath);
    try {
      await link(temporaryPath, layout.generationPath);
      await syncPath(layout.generationDirectory);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      await assertImmutableGeneration(layout.generationPath, content, ownership);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function validatedPostgrestPointerTarget(
  projectRef: string,
  pointerContent: string,
): string | null {
  if (!pointerContent.endsWith("\n") || pointerContent.endsWith("\n\n")) return null;
  const target = pointerContent.slice(0, -1);
  const match = target.match(GENERATION_TARGET_PATTERN);
  return match && match[1] === projectRef ? target : null;
}

function validRawPointerTarget(projectRef: string, pointerTarget: string): boolean {
  return validatedPostgrestPointerTarget(projectRef, `${pointerTarget}\n`) === pointerTarget;
}

export async function validatePostgrestGenerationTarget(
  tenantDirectory: string,
  projectRef: string,
  pointerTarget: string,
  ownership: PostgrestControlOwnership,
): Promise<{ path: string; revision: string }> {
  if (!validRawPointerTarget(projectRef, pointerTarget)) {
    throw new Error("Invalid PostgREST generation pointer target");
  }
  const generationDirectory = resolve(tenantDirectory, `${projectRef}_postgrest.d`);
  const generationPath = resolve(tenantDirectory, pointerTarget);
  const [directoryMetadata, generationMetadata, resolvedDirectory, resolvedPath] = await Promise.all([
    lstat(generationDirectory),
    lstat(generationPath),
    realpath(generationDirectory),
    realpath(generationPath),
  ]);
  assertControlDirectoryMetadata(directoryMetadata, ownership);
  assertControlMetadata(generationMetadata, 0o440, ownership, "PostgREST generation");
  if (resolvedDirectory !== generationDirectory
    || resolvedPath !== generationPath
    || dirname(resolvedPath) !== resolvedDirectory) {
    throw new Error("PostgREST generation escapes its trusted directory");
  }
  const digest = basename(resolvedPath).match(/^([a-f0-9]{64})\.conf$/)?.[1];
  if (!digest) throw new Error("PostgREST generation filename is invalid");
  const revision = postgrestConfigRevision(projectRef, await readFile(resolvedPath, "utf8"));
  if (revision !== `hmac-sha256:${digest}`) {
    throw new Error("PostgREST generation content does not match its filename");
  }
  return { path: resolvedPath, revision };
}

export async function readPostgrestPointerTarget(
  pointerPath: string,
  projectRef: string,
  ownership: PostgrestControlOwnership,
): Promise<string | null> {
  try {
    const metadata = await lstat(pointerPath);
    assertControlMetadata(metadata, 0o440, ownership, "PostgREST generation pointer");
    const target = validatedPostgrestPointerTarget(projectRef, await readFile(pointerPath, "utf8"));
    if (!target) throw new Error("PostgREST generation pointer has invalid content");
    return target;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function replacePostgrestPointer(
  layout: PostgrestGenerationLayout,
  pointerTarget: string,
  ownership: PostgrestControlOwnership,
  setControlOwnership: (path: string) => Promise<void>,
): Promise<void> {
  if (!validRawPointerTarget(
    basename(layout.pointerPath).replace(/_postgrest\.current$/, ""),
    pointerTarget,
  )) {
    throw new Error("Invalid PostgREST generation pointer target");
  }
  const temporaryPath = `${layout.pointerPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${pointerTarget}\n`, {
      encoding: "utf8",
      mode: 0o440,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o440);
    await setControlOwnership(temporaryPath);
    assertControlMetadata(
      await lstat(temporaryPath),
      0o440,
      ownership,
      "PostgREST generation pointer",
    );
    await syncPath(temporaryPath);
    await rename(temporaryPath, layout.pointerPath);
    await syncPath(dirname(layout.pointerPath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function removePostgrestPointerIfCurrent(
  request: RemovePostgrestPointerRequest,
): Promise<void> {
  const before = await lstat(request.layout.pointerPath);
  assertControlMetadata(before, 0o440, request.ownership, "PostgREST generation pointer");
  const pointerTarget = validatedPostgrestPointerTarget(
    request.projectRef,
    await readFile(request.layout.pointerPath, "utf8"),
  );
  if (pointerTarget !== request.expectedPointerTarget) {
    throw new Error("PostgREST generation pointer changed before cleanup");
  }
  const after = await lstat(request.layout.pointerPath);
  assertControlMetadata(after, 0o440, request.ownership, "PostgREST generation pointer");
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("PostgREST generation pointer identity changed before cleanup");
  }
  await rm(request.layout.pointerPath);
  await syncPath(dirname(request.layout.pointerPath));
  try {
    await lstat(request.layout.pointerPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("PostgREST generation pointer reappeared during cleanup");
}

export async function readCurrentPostgrestGeneration(
  request: ReadCurrentPostgrestGenerationRequest,
): Promise<{ content: string; pointerTarget: string; revision: string }> {
  const pointerPath = join(request.tenantDirectory, `${request.projectRef}_postgrest.current`);
  const pointerTarget = await readPostgrestPointerTarget(
    pointerPath,
    request.projectRef,
    {
      controlOwnerUid: request.controlOwnerUid,
      runtimeGroupGid: request.runtimeGroupGid,
    },
  );
  if (pointerTarget) {
    const validated = await validatePostgrestGenerationTarget(
      request.tenantDirectory,
      request.projectRef,
      pointerTarget,
      {
        controlOwnerUid: request.controlOwnerUid,
        runtimeGroupGid: request.runtimeGroupGid,
      },
    );
    return {
      content: await readFile(validated.path, "utf8"),
      pointerTarget,
      revision: validated.revision,
    };
  }
  const legacyPath = join(request.tenantDirectory, `${request.projectRef}.conf`);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(legacyPath);
  } catch (legacyError: unknown) {
    if (legacyError instanceof Error && "code" in legacyError && legacyError.code === "ENOENT") {
      throw new Error(`PostgREST generation is unavailable for ${request.projectRef}`);
    }
    throw legacyError;
  }
  assertLegacyGenerationMetadata(metadata, request.runtimeOwnerUid, request.runtimeGroupGid);
  const legacyContent = await readFile(legacyPath, "utf8");
  if (!legacyContent.startsWith(MANAGED_POSTGREST_CONFIG_PREFIX)) {
    throw new Error(`PostgREST generation is unavailable for ${request.projectRef}`);
  }
  await activatePostgrestGeneration({
    tenantDirectory: request.tenantDirectory,
    projectRef: request.projectRef,
    content: legacyContent,
    controlOwnerUid: request.controlOwnerUid,
    runtimeGroupGid: request.runtimeGroupGid,
    setControlOwnership: request.setControlOwnership,
  });
  const activatedPointerTarget = await readPostgrestPointerTarget(
    join(request.tenantDirectory, `${request.projectRef}_postgrest.current`),
    request.projectRef,
    {
      controlOwnerUid: request.controlOwnerUid,
      runtimeGroupGid: request.runtimeGroupGid,
    },
  );
  if (!activatedPointerTarget) {
    throw new Error(`PostgREST generation is unavailable for ${request.projectRef}`);
  }
  const validated = await validatePostgrestGenerationTarget(
    request.tenantDirectory,
    request.projectRef,
    activatedPointerTarget,
    {
      controlOwnerUid: request.controlOwnerUid,
      runtimeGroupGid: request.runtimeGroupGid,
    },
  );
  return {
    content: await readFile(validated.path, "utf8"),
    pointerTarget: activatedPointerTarget,
    revision: validated.revision,
  };
}

async function restorePointerAfterActivationFailure(
  layout: PostgrestGenerationLayout,
  previousPointerTarget: string | null,
  ownership: PostgrestControlOwnership,
  setControlOwnership: (path: string) => Promise<void>,
): Promise<void> {
  if (previousPointerTarget) {
    await validatePostgrestGenerationTarget(
      dirname(layout.pointerPath),
      basename(layout.pointerPath).replace(/_postgrest\.current$/, ""),
      previousPointerTarget,
      ownership,
    );
    await replacePostgrestPointer(
      layout,
      previousPointerTarget,
      ownership,
      setControlOwnership,
    );
    return;
  }
  await rm(layout.pointerPath, { force: true });
  await syncPath(dirname(layout.pointerPath));
}

export async function activatePostgrestGeneration(
  request: ActivatePostgrestGenerationRequest,
): Promise<ActivatedPostgrestGeneration> {
  const canonicalContent = canonicalPostgrestConfig(request.content);
  const revision = postgrestConfigRevision(request.projectRef, canonicalContent);
  const layout = postgrestGenerationLayout(
    request.tenantDirectory,
    request.projectRef,
    revision,
  );
  let directoryMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryMetadata = await lstat(layout.generationDirectory);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(layout.generationDirectory, { mode: 0o750 });
    await chmod(layout.generationDirectory, 0o750);
    await request.setControlOwnership(layout.generationDirectory);
    await syncPath(dirname(layout.generationDirectory));
    directoryMetadata = await lstat(layout.generationDirectory);
  }
  const ownership = {
    controlOwnerUid: request.controlOwnerUid,
    runtimeGroupGid: request.runtimeGroupGid,
  };
  assertControlDirectoryMetadata(directoryMetadata, ownership);
  const previousPointerTarget = await readPostgrestPointerTarget(
    layout.pointerPath,
    request.projectRef,
    ownership,
  );
  if (request.expectedPreviousPointerTarget !== undefined
    && previousPointerTarget !== request.expectedPreviousPointerTarget) {
    throw new Error("PostgREST generation changed before activation");
  }
  await createImmutableGeneration(
    layout,
    canonicalContent,
    ownership,
    request.setControlOwnership,
  );
  await assertImmutableGeneration(layout.generationPath, canonicalContent, ownership);
  try {
    await replacePostgrestPointer(
      layout,
      layout.pointerTarget,
      ownership,
      request.setControlOwnership,
    );
  } catch (activationError: unknown) {
    try {
      await restorePointerAfterActivationFailure(
        layout,
        previousPointerTarget,
        ownership,
        request.setControlOwnership,
      );
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [activationError, rollbackError],
        "PostgREST generation pointer activation and rollback both failed",
      );
    }
    throw activationError;
  }
  return { revision, layout, previousPointerTarget, ownership };
}
