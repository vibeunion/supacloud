import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDeliveryBuildManifest, type DeliveryObject } from "./delivery-build-schema";
import { canonical, digest, noLinks, readBoundedOwned } from "./delivery-files";
import type { DeliveryTarget } from "./delivery-schema";

const JSON_LIMIT = 1_048_576;

export async function readDeliveryManifest(manifestPath: string) {
  const selected = resolve(manifestPath);
  const root = await realpath(dirname(selected));
  const manifest = parseDeliveryBuildManifest(JSON.parse(
    (await readBoundedOwned(root, join(root, basename(selected)), JSON_LIMIT)).toString("utf8"),
  ));
  return { root, manifest };
}

export async function readDeliverySelection(manifestPath: string, target: string) {
  const { root, manifest } = await readDeliveryManifest(manifestPath);
  const object = manifest.objects.find(item => item.name === target);
  const planned = manifest.plan.targets.find(item => item.name === target);
  return { root, object, planned };
}

/** Verify the entire inventory; retain only requested bytes from the verified reads. */
export async function readVerifiedDeliveryFiles(
  root: string, object: DeliveryObject, target: DeliveryTarget, selectedPaths: ReadonlySet<string>,
): Promise<Map<string, Buffer>> {
  if (object.files.length > 1024 || object.files.some(file => file.bytes > 64 * 1024 * 1024)
    || object.files.reduce((bytes, file) => bytes + file.bytes, 0) > 128 * 1024 * 1024) {
    throw new Error("Artifact inventory exceeds limits.");
  }
  const objectRoot = join(root, "objects", object.objectId);
  await noLinks(root, objectRoot);
  const files = new Set(object.files.map(file => file.path));
  const directories = new Set([""]);
  for (const path of files) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"));
  }
  for (const directory of directories) {
    for (const entry of await readdir(join(objectRoot, directory), { withFileTypes: true })) {
      const path = directory ? directory + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink() || (entry.isDirectory() ? !directories.has(path) : !files.has(path))) {
        throw new Error("Unexpected artifact entry.");
      }
    }
  }
  const retained = new Map<string, Buffer>();
  let targetMetadata: unknown;
  for (const item of object.files) {
    const content = await readBoundedOwned(objectRoot, join(objectRoot, item.path), item.bytes);
    if (content.length !== item.bytes || digest(content) !== item.sha256) throw new Error("Artifact hash mismatch.");
    if (selectedPaths.has(item.path)) retained.set(item.path, content);
    if (item.path === "bundle/target.json") {
      if (item.bytes > JSON_LIMIT) throw new Error("Target metadata too large.");
      targetMetadata = JSON.parse(content.toString("utf8"));
    }
  }
  if (canonical(targetMetadata) !== canonical({ target, entryKind: object.entryKind, deploymentReady: false })) {
    throw new Error("Manifest target differs from the hashed object target.");
  }
  return retained;
}
