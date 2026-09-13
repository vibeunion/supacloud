import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { DeliveryFilePathSchema } from "./delivery-schema";
import type { DeliveryObject } from "./delivery-build-schema";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item);
}

export function inside(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** The anchor must already be canonical; reject links in every descendant component. */
export async function noLinks(anchor: string, path: string): Promise<void> {
  if (!inside(anchor, path)) throw new Error("Delivery path escapes its owned root.");
  let current = anchor;
  for (const part of relative(anchor, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!await exists(current)) continue;
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Delivery paths cannot contain symbolic links.");
  }
}

export async function readOwned(anchor: string, path: string): Promise<Uint8Array> {
  await noLinks(anchor, path);
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error("Expected a regular delivery input or artifact.");
  return readFile(path);
}

export async function reserveOutput(project: string, requested: string) {
  if (!inside(project, requested)) throw new Error("Delivery output must be inside the application project.");
  const base = await realpath(project);
  const path = resolve(base, relative(project, requested));
  if (relative(base, path).split(sep).some((part) => part === ".git" || part === "node_modules")) {
    throw new Error("Delivery output cannot use repository or dependency internals.");
  }
  await noLinks(base, path);
  await mkdir(path, { recursive: true });
  const marker = join(path, "owner.json");
  const owner = canonical({ producer: "@supacloud/compiler/delivery-build-v1", project: base });
  if (!await exists(marker)) {
    if ((await readdir(path)).length > 0) throw new Error("Refusing to adopt an unowned delivery directory.");
    await writeFile(marker, owner, { flag: "wx" });
  } else if (new TextDecoder().decode(await readOwned(base, marker)) !== owner) {
    throw new Error("Delivery output is owned by a different project or producer.");
  }
  const lockPath = join(path, "build.lock");
  await noLinks(base, lockPath);
  const lock = await open(lockPath, "wx");
  return {
    path,
    async release(): Promise<void> {
      await lock.close();
      await rm(lockPath);
    },
  };
}

export async function writeArtifact(root: string, path: string, content: string | Uint8Array): Promise<void> {
  if (!Value.Check(DeliveryFilePathSchema, path)) throw new Error("Invalid artifact path.");
  const destination = join(root, path);
  await noLinks(root, destination);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { flag: "wx" });
}

export async function artifactInventory(root: string): Promise<DeliveryObject["files"]> {
  const files: DeliveryObject["files"] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Artifact contains a symbolic link.");
      if (entry.isDirectory()) await visit(path);
      else {
        const content = await readOwned(root, path);
        files.push({ path: relative(root, path).split(sep).join("/"), sha256: digest(content), bytes: content.length });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Snapshot application sources before graph analysis, excluding generated output. */
export async function sourceInventory(root: string, output: string): Promise<Map<string, string>> {
  const inputs = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (inside(output, path) || entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) {
        inputs.set(path, digest(await readOwned(root, path)));
      }
    }
  }
  await visit(root);
  return inputs;
}

export async function publishPointer(root: string, content: string): Promise<boolean> {
  const path = join(root, "delivery.manifest.json");
  if (await exists(path) && new TextDecoder().decode(await readOwned(root, path)) === content) return false;
  const temporary = join(root, "delivery.manifest.pending");
  await noLinks(root, path);
  await noLinks(root, temporary);
  await writeFile(temporary, content, { flag: "wx" });
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
  return true;
}
