import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApplicationPreviewServiceDependencies } from "./application-preview.service";

const PROJECT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const PREVIEW_REF = /^pv[a-f0-9]{18}$/;
const SLUG = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FUNCTIONS = 64;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  return slug;
}

async function realDirectory(rootPath: string): Promise<string> {
  const root = resolve(rootPath);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  }
  return root;
}

function directChild(root: string, name: string): string {
  if (!PROJECT_REF.test(name)) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  const directory = join(root, name);
  if (directory !== resolve(root, name)) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  return directory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Active `slug.js` files and `.versions/slug` directories. Symlinks are refused. */
export async function listPreviewFunctionSlugs(rootPath: string, ref: string): Promise<string[]> {
  const root = await realDirectory(rootPath);
  const directory = directChild(root, ref);
  if (!await exists(directory)) return [];
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  const slugs = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
    if (entry.isFile() && entry.name.endsWith(".js")) {
      const slug = entry.name.slice(0, -3);
      if (SLUG.test(slug)) slugs.add(slug);
    }
  }
  const versions = join(directory, ".versions");
  if (await exists(versions)) {
    const versionStat = await lstat(versions);
    if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) {
      throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
    }
    for (const entry of await readdir(versions, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
      if (entry.isDirectory() && SLUG.test(entry.name)) slugs.add(entry.name);
    }
  }
  return [...slugs].sort();
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  await mkdir(target, { recursive: true, mode: 0o755 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "." || entry.name === ".." || entry.name.includes("..")) {
      throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
    }
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  }
}

async function copySlug(sourceDir: string, targetDir: string, slug: string): Promise<void> {
  const file = join(sourceDir, `${slug}.js`);
  const version = join(sourceDir, ".versions", slug);
  const fileStat = await lstat(file).catch(error => missing(error) ? null : Promise.reject(error));
  const versionStat = await lstat(version).catch(error => missing(error) ? null : Promise.reject(error));
  if (fileStat?.isSymbolicLink() || versionStat?.isSymbolicLink()) {
    throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  }
  if (!fileStat && !versionStat) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  await mkdir(targetDir, { recursive: true, mode: 0o755 });
  if (fileStat?.isFile()) await copyFile(file, join(targetDir, `${slug}.js`));
  else if (fileStat) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  if (versionStat?.isDirectory()) await copyDirectory(version, join(targetDir, ".versions", slug));
  else if (versionStat) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
}

export async function isolatePreviewFunctions(
  rootPath: string, sourceRef: string, targetRef: string, slugs: readonly string[],
): Promise<void> {
  if (!PREVIEW_REF.test(targetRef) || !PROJECT_REF.test(sourceRef) || sourceRef === targetRef) {
    throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  }
  const unique = [...new Set(slugs)];
  if (unique.length !== slugs.length || unique.length > MAX_FUNCTIONS) {
    throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  }
  for (const slug of unique) assertSlug(slug);
  const root = await realDirectory(rootPath);
  const targetDir = directChild(root, targetRef);
  if (unique.length === 0) {
    if (await exists(targetDir) && (await listPreviewFunctionSlugs(root, targetRef)).length > 0) {
      throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
    }
    return;
  }
  const sourceDir = directChild(root, sourceRef);
  for (const slug of unique) await copySlug(sourceDir, targetDir, slug);
}

export async function removePreviewFunctions(
  rootPath: string, targetRef: string, slugs: readonly string[],
): Promise<void> {
  if (!PREVIEW_REF.test(targetRef)) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
  for (const slug of slugs) assertSlug(slug);
  const root = await realDirectory(rootPath);
  const targetDir = directChild(root, targetRef);
  if (!await exists(targetDir)) return;
  const stat = await lstat(targetDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED");
  for (const slug of slugs) {
    await rm(join(targetDir, `${slug}.js`), { force: true });
    await rm(join(targetDir, ".versions", slug), { recursive: true, force: true });
  }
  if ((await listPreviewFunctionSlugs(root, targetRef)).length === 0) {
    await rm(targetDir, { recursive: true, force: false });
  }
}

export function createPreviewFunctionIsolation(
  rootPath: string,
): NonNullable<ApplicationPreviewServiceDependencies["functions"]> {
  return {
    list: ref => listPreviewFunctionSlugs(rootPath, ref),
    isolate: input => isolatePreviewFunctions(rootPath, input.sourceRef, input.targetRef, input.slugs),
    remove: (ref, slugs) => removePreviewFunctions(rootPath, ref, slugs),
    listIsolated: ref => listPreviewFunctionSlugs(rootPath, ref),
  };
}
