import { resolve } from "node:path";
import { canonical, digest, inside, readBoundedOwned } from "./delivery-files";
import type { DeliveryOptions } from "./delivery-schema";

type MigrationInput = NonNullable<NonNullable<DeliveryOptions["build"]>["migrations"]>[number];

/** Archive declared SQL, without interpreting compatibility or authorizing execution. */
export async function prepareDeliveryMigrations(
  project: string, generatedRoot: string, declarations: readonly MigrationInput[] = [],
) {
  const entries: Array<{
    version: string; name: string; executor: MigrationInput["executor"];
    path: string; sha256: string; bytes: number;
  }> = [];
  const files = new Map<string, Uint8Array>();
  const inputs = new Map<string, string>();
  let totalBytes = 0;
  for (const declaration of [...declarations].sort((a, b) =>
    BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0)) {
    const source = resolve(project, declaration.source);
    if (!inside(project, source) || inside(generatedRoot, source)) throw new Error("Invalid migration source.");
    const bytes = await readBoundedOwned(project, source, 1_048_576);
    totalBytes += bytes.length;
    if (totalBytes > 16 * 1_048_576 || !new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()) {
      throw new Error("Invalid migration content or byte budget.");
    }
    const hash = digest(bytes);
    const path = `bundle/migrations/${declaration.executor}/${declaration.version}_${declaration.name}.sql`;
    entries.push({
      version: declaration.version, name: declaration.name, executor: declaration.executor,
      path: path.slice("bundle/".length), sha256: hash, bytes: bytes.length,
    });
    files.set(path, bytes);
    inputs.set(source, hash);
  }
  if (entries.length) {
    files.set("bundle/migrations.json", new TextEncoder().encode(canonical({
      version: 1, digestScope: "raw-sql-bytes", compatibility: "not-proven", executionPerformed: false,
      dataRecovery: "separate-required", migrations: entries,
    })));
  }
  return { entries, files, inputs };
}
