import { chown, lstat, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { config } from "../config";
import { renderPostgrestSystemdTemplate } from "./postgrest-systemd-template";
import { installManagedSystemdUnit, removeManagedSystemdUnit } from "./systemd-unit-broker";
import { logger } from "../utils/logger";

const LEGACY_UNIT_TEMPLATE = "supacloud-pgrst@.service";
const CANONICAL_UNIT_TEMPLATE = "supacloud-postrust@.service";
const LEGACY_UNIT_PATTERN = /^(supacloud-pgrst@[a-z0-9-]{1,64}\.service)$/;
const canonicalUnit = (ref: string): string => `supacloud-postrust@${ref}.service`;
const legacyUnit = (ref: string): string => `supacloud-pgrst@${ref}.service`;
const LEGACY_DIRECTORY_PATTERN = /^([a-z0-9-]{1,64})_postgrest\.d$/;
const LEGACY_POINTER_SUFFIX = "_postgrest.current";
const CANONICAL_POINTER_SUFFIX = "_postrust.current";
const SYSTEMD_UNIT_DIRECTORY = "/etc/systemd/system";

type LegacyService = { ref: string; active: boolean; enabled: boolean };

export function parseLegacyServiceList(stdout: string): Array<{ ref: string; active: boolean }> {
  const services: Array<{ ref: string; active: boolean }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const unit = columns[0] ?? "";
    const loadState = columns[1] ?? "";
    const match = unit.match(LEGACY_UNIT_PATTERN);
    if (!match || loadState !== "loaded") continue;
    const ref = match[1].slice("supacloud-pgrst@".length, -".service".length);
    // systemctl's ACTIVE column is third: UNIT LOAD ACTIVE SUB DESCRIPTION.
    const state = columns[2] ?? "";
    services.push({ ref, active: state === "active" || state === "activating" });
  }
  return services;
}

async function runSystemctl(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn({
    cmd: ["systemctl", ...args],
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function listEnabledLegacyRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(join(SYSTEMD_UNIT_DIRECTORY, "multi-user.target.wants"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return refs;
    throw error;
  }
  for (const entry of entries) {
    const match = entry.match(/^supacloud-pgrst@([a-z0-9-]{1,64})\.service$/);
    if (match) refs.add(match[1]);
  }
  return refs;
}

async function listLegacyServices(): Promise<LegacyService[]> {
  const child = Bun.spawn({
    cmd: ["systemctl", "list-units", "--all", "--plain", "--no-legend", "supacloud-pgrst@*.service"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Unable to inspect legacy PostgREST units: ${stderr.trim().slice(0, 300)}`);
  }
  const enabledRefs = await listEnabledLegacyRefs();
  return parseLegacyServiceList(stdout).map((service) => ({
    ...service,
    enabled: service.active || enabledRefs.has(service.ref),
  }));
}

async function stopLegacyService(unit: string): Promise<void> {
  const result = await runSystemctl(["stop", unit]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to stop ${unit}: ${result.stderr.trim().slice(0, 300)}`);
  }
}

async function disableLegacyService(unit: string): Promise<void> {
  const result = await runSystemctl(["disable", unit]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to retire ${unit}: ${result.stderr.trim().slice(0, 300)}`);
  }
}

async function reloadSystemd(): Promise<void> {
  const result = await runSystemctl(["daemon-reload"]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to reload systemd after Postrust naming migration: ${result.stderr.trim().slice(0, 300)}`);
  }
}

async function installCanonicalTemplate(): Promise<boolean> {
  const path = join(SYSTEMD_UNIT_DIRECTORY, CANONICAL_UNIT_TEMPLATE);
  if (await pathExists(path)) return false;
  const unit = renderPostgrestSystemdTemplate({
    postgrestRts: config.postgrestRts,
    postgrestBinary: config.postgrestBin,
    tenantConfigDir: config.tenantConfigDir,
    memoryMax: config.postgrestMemoryMax,
    cpuWeight: config.postgrestCpuWeight,
  });
  await installManagedSystemdUnit(CANONICAL_UNIT_TEMPLATE, unit);
  return true;
}

async function replacePointer(file: string, projectRef: string): Promise<boolean> {
  const oldTarget = (await readFile(file, "utf8")).trimEnd();
  const legacyTarget = new RegExp(`^${projectRef}_postgrest\\.d/([a-f0-9]{64}\\.conf)$`);
  const match = oldTarget.match(legacyTarget);
  if (!match) return false;
  const metadata = await stat(file);
  const nextTarget = `${projectRef}_postrust.d/${basename(match[1])}`;
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${nextTarget}\n`, { encoding: "utf8", mode: Number(metadata.mode) & 0o7777, flag: "wx" });
  await chown(temporary, metadata.uid, metadata.gid);
  await rename(temporary, file);
  await rm(temporary, { force: true });
  return true;
}


async function copyTree(source: string, target: string): Promise<void> {
  const child = Bun.spawn({
    cmd: ["cp", "-a", source, target],
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Unable to copy ${source}: ${stderr.trim().slice(0, 300)}`);
  }
}

async function snapshotTenantConfig(tenantConfigDir: string): Promise<string | null> {
  if (!(await pathExists(tenantConfigDir))) return null;
  const root = await mkdtemp(join(dirname(tenantConfigDir), ".postrust-migration-"));
  await copyTree(tenantConfigDir, join(root, "tenants"));
  return root;
}

async function restoreTenantConfig(tenantConfigDir: string, snapshotRoot: string): Promise<void> {
  await rm(tenantConfigDir, { recursive: true, force: true });
  await copyTree(join(snapshotRoot, "tenants"), tenantConfigDir);
}

export async function migratePostrustTenantConfig(
  tenantConfigDir = config.tenantConfigDir,
): Promise<number> {
  let moved = 0;
  let entries: string[];
  try {
    entries = await readdir(tenantConfigDir);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const directoryMatch = entry.match(LEGACY_DIRECTORY_PATTERN);
    if (!directoryMatch) continue;
    const projectRef = directoryMatch[1];
    const legacyDirectory = join(tenantConfigDir, entry);
    const canonicalDirectory = join(tenantConfigDir, `${projectRef}_postrust.d`);
    const canonicalDirectoryExists = await pathExists(canonicalDirectory);
    if (await pathExists(legacyDirectory)) {
      if (!canonicalDirectoryExists) {
        await rename(legacyDirectory, canonicalDirectory);
        moved += 1;
      }
    }
    const legacyPointer = join(tenantConfigDir, `${projectRef}${LEGACY_POINTER_SUFFIX}`);
    const canonicalPointer = join(tenantConfigDir, `${projectRef}${CANONICAL_POINTER_SUFFIX}`);
    const canonicalPointerExists = await pathExists(canonicalPointer);
    if (await pathExists(legacyPointer)) {
      if (!canonicalPointerExists) {
        await rename(legacyPointer, canonicalPointer);
        await replacePointer(canonicalPointer, projectRef);
        moved += 1;
      } else {
        await rm(legacyPointer, { force: true });
        moved += 1;
      }
    }
  }

  for (const entry of entries) {
    if (!entry.endsWith(LEGACY_POINTER_SUFFIX)) continue;
    const projectRef = entry.slice(0, -LEGACY_POINTER_SUFFIX.length);
    if (!/^[a-z0-9-]{1,64}$/.test(projectRef)) continue;
    const legacyPointer = join(tenantConfigDir, entry);
    if (!(await pathExists(legacyPointer))) continue;
    const canonicalPointer = join(tenantConfigDir, `${projectRef}${CANONICAL_POINTER_SUFFIX}`);
    if (await pathExists(canonicalPointer)) {
      await rm(legacyPointer, { force: true });
      moved += 1;
      continue;
    }
    await rename(legacyPointer, canonicalPointer);
    await replacePointer(canonicalPointer, projectRef);
    moved += 1;
  }
  return moved;
}

export async function migratePostrustNaming(): Promise<{ changed: boolean; services: number; paths: number }> {
  const services = await listLegacyServices();
  const legacyTemplateExists = await pathExists(join(SYSTEMD_UNIT_DIRECTORY, LEGACY_UNIT_TEMPLATE));
  if (services.length === 0 && !legacyTemplateExists) {
    const paths = await migratePostrustTenantConfig();
    if (paths > 0) logger.info("[postrust-migration] Migrated tenant config paths", { paths });
    return { changed: paths > 0, services: 0, paths };
  }

  const snapshotRoot = await snapshotTenantConfig(config.tenantConfigDir);
  let templateInstalled = false;
  let paths = 0;
  try {
    // Install the canonical unit before touching the live runtime. A broker or
    // systemd failure must leave the legacy units and tenant config untouched.
    templateInstalled = await installCanonicalTemplate();
    await reloadSystemd();
  } catch (error: unknown) {
    if (snapshotRoot) await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }

  const active = services.filter((service) => service.active);
  const enabled = services.filter((service) => service.enabled);
  const started: string[] = [];
  const configured: string[] = [];
  try {
    for (const service of active) {
      await stopLegacyService(legacyUnit(service.ref));
    }
    paths = await migratePostrustTenantConfig();
    for (const service of active) {
      const result = await runSystemctl(["enable", "--now", canonicalUnit(service.ref)]);
      if (result.exitCode !== 0) {
        throw new Error(`Unable to start canonical Postrust unit for ${service.ref}: ${result.stderr.trim().slice(0, 300)}`);
      }
      started.push(service.ref);
      configured.push(service.ref);
    }
    for (const service of enabled.filter((candidate) => !candidate.active)) {
      const result = await runSystemctl(["enable", canonicalUnit(service.ref)]);
      if (result.exitCode !== 0) {
        throw new Error(`Unable to enable canonical Postrust unit for ${service.ref}: ${result.stderr.trim().slice(0, 300)}`);
      }
      configured.push(service.ref);
    }
  } catch (error: unknown) {
    for (const ref of started) {
      await runSystemctl(["stop", canonicalUnit(ref)]).catch(() => undefined);
    }
    for (const ref of configured) {
      await runSystemctl(["disable", canonicalUnit(ref)]).catch(() => undefined);
    }
    if (snapshotRoot) {
      await restoreTenantConfig(config.tenantConfigDir, snapshotRoot);
    }
    await reloadSystemd().catch(() => undefined);
    // Preserve the old runtime when activation of the canonical unit fails.
    for (const service of active) {
      await runSystemctl(["start", legacyUnit(service.ref)]).catch(() => undefined);
    }
    if (snapshotRoot) await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }

  for (const service of services) {
    await disableLegacyService(legacyUnit(service.ref))
      .catch((error: unknown) => {
        logger.warn("[postrust-migration] Legacy unit was already unloaded", {
          service: service.ref,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  await removeManagedSystemdUnit(LEGACY_UNIT_TEMPLATE).catch((error: unknown) => {
    logger.warn("[postrust-migration] Legacy unit template was not removed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await reloadSystemd();
  if (snapshotRoot) await rm(snapshotRoot, { recursive: true, force: true });
  logger.warn("[postrust-migration] Retired legacy PostgREST runtime names", {
    services: services.length,
    paths,
    templateInstalled,
  });
  return { changed: true, services: services.length, paths };
}
