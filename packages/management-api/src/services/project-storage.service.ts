import { S3Client } from "bun";
import { AwsClient } from "aws4fetch";
import { sql, getProjectDb } from "../db";
import { config } from "../config";
import { decryptSecret, encryptSecret } from "../utils/secret-crypto";
import type { StorageDriver } from "./storage.adapter";
import { ProjectS3Driver } from "./project-s3-driver";
import { createProjectStorageRegistry } from "./project-storage-registry";
import { migrateProjectObjects } from "./project-storage-migration";
import { createProjectStorageInventory } from "./project-storage-inventory";
import {
  ProjectStorageError,
  type ProjectS3Configuration,
  type ProjectStorageAdoptionPlan,
} from "./project-storage-contract";

export function createConfiguredProjectS3Driver(configuration: ProjectS3Configuration): StorageDriver {
  const client = new S3Client({
    endpoint: configuration.endpoint, region: configuration.region, bucket: configuration.bucket,
    accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey,
    sessionToken: configuration.sessionToken ?? "", virtualHostedStyle: configuration.virtualHostedStyle,
  });
  return new ProjectS3Driver(configuration, client);
}

export const projectStorageService = createProjectStorageRegistry({
  database: sql, getProjectDb, decryptSecret, encryptSecret,
  allowedOrigins: () => process.env.SUPACLOUD_PROJECT_S3_ALLOWED_ORIGINS ?? "",
  defaultBackend: () => config.storageType || "s3",
  createDriver: createConfiguredProjectS3Driver,
  inventory: createProjectStorageInventory({ database: sql, getProjectDb }),
  migrate: migrateProjectObjects,
  async probe(configuration) {
    const url = new URL(configuration.endpoint);
    if (configuration.virtualHostedStyle) url.hostname = `${configuration.bucket}.${url.hostname}`;
    else url.pathname = `/${configuration.bucket}`;
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', configuration.prefix);
    url.searchParams.set('max-keys', '1');
    const signer = new AwsClient({ accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey,
      ...(configuration.sessionToken ? { sessionToken: configuration.sessionToken } : {}), region: configuration.region, service: 's3' });
    const request = await signer.sign(url.toString(), { method: 'GET' });
    const response = await fetch(request, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    if (!response.ok) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    return { backend: 's3', reachable: true, listable: true, writable: 'not_tested' };
  },
});

export function withProjectStorageDriver<T>(ref: string, fallback: StorageDriver, operation: (driver: StorageDriver) => Promise<T>): Promise<T> {
  return projectStorageService.withDriver(ref, fallback, operation);
}

/** Plan an adoption against the project's current (platform) backend. */
export async function planProjectStorage(ref: string): Promise<ProjectStorageAdoptionPlan> {
  const { getLegacyStorageDriver } = await import("./storage.adapter");
  return projectStorageService.plan(ref, getLegacyStorageDriver());
}

/** Copy + verify then bind an already-used project to its own backend. */
export async function adoptProjectStorage(ref: string, settings: unknown, expectedRevision: string | null) {
  const { getLegacyStorageDriver } = await import("./storage.adapter");
  return projectStorageService.adopt(ref, settings, expectedRevision, getLegacyStorageDriver());
}
