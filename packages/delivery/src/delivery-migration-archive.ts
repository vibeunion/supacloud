import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { readDeliverySelection, readVerifiedDeliveryFiles } from "./delivery-artifact";
import { digest } from "./delivery-files";

const entrySchema = Type.Object({
  version: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }),
  name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,127}$" }),
  executor: Type.Union([Type.Literal("project-migration"), Type.Literal("operator-provisioning")]),
  path: Type.String(),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
}, { additionalProperties: false });
const archiveSchema = Type.Object({
  version: Type.Literal(1),
  digestScope: Type.Literal("raw-sql-bytes"),
  compatibility: Type.Literal("not-proven"),
  executionPerformed: Type.Literal(false),
  dataRecovery: Type.Literal("separate-required"),
  migrations: Type.Array(entrySchema, { minItems: 1, maxItems: 128 }),
}, { additionalProperties: false });

export interface DeliveryMigrationArchive {
  target: string;
  objectId: string;
  artifactVerified: true;
  migrations: Array<Static<typeof entrySchema> & { sql: string }>;
}

/** Read verified bytes only; does not execute SQL or attest environment compatibility. */
export async function readDeliveryMigrationArchive(
  manifestPath: string, target: string,
): Promise<DeliveryMigrationArchive> {
  try {
    const { root, object, planned } = await readDeliverySelection(manifestPath, target);
    if (!object || !planned) throw new Error();
    const metadataPath = "bundle/migrations.json";
    const selected = object.files.filter(item => item.path === metadataPath || item.path.startsWith("bundle/migrations/"));
    if (selected.some(item => item.bytes > 1_048_576)
      || selected.reduce((sum, item) => sum + item.bytes, 0) > 17 * 1_048_576) throw new Error();
    const files = await readVerifiedDeliveryFiles(root, object, planned, new Set(selected.map(item => item.path)));
    const metadata = files.get(metadataPath);
    if (!metadata) {
      if (files.size) throw new Error();
      return { target, objectId: object.objectId, artifactVerified: true, migrations: [] };
    }
    const archive: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
    if (!Value.Check(archiveSchema, archive) || files.size !== archive.migrations.length + 1) throw new Error();
    const versions = new Set<string>();
    let previous = 0n, total = 0;
    const migrations = archive.migrations.map(entry => {
      const version = BigInt(entry.version);
      if (version <= previous || version > 9_223_372_036_854_775_807n || versions.has(entry.version)
        || entry.path !== `migrations/${entry.executor}/${entry.version}_${entry.name}.sql`) throw new Error();
      previous = version;
      versions.add(entry.version);
      const content = files.get("bundle/" + entry.path);
      if (!content || content.length !== entry.bytes || digest(content) !== entry.sha256) throw new Error();
      total += content.length;
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (!sql.trim() || total > 16 * 1_048_576) throw new Error();
      return { ...entry, sql };
    });
    return { target, objectId: object.objectId, artifactVerified: true, migrations };
  } catch {
    throw new Error("Invalid delivery migration archive.");
  }
}
