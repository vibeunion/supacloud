import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { controlPlaneUpgradeSafetyInternals } from "../../src/control-plane-upgrade-safety";

const databaseUrl = process.env.CONTROL_PLANE_SNAPSHOT_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "keeps an exported snapshot importable without retaining inspection locks during DDL",
  async () => {
    const writer = new SQL({ url: databaseUrl!, max: 1 });
    const column = `snapshot_lock_probe_${randomUUID().replaceAll("-", "")}`;

    try {
      await controlPlaneUpgradeSafetyInternals.withControlPlaneSnapshot(databaseUrl!, async (snapshotId) => {
        const inspection = await controlPlaneUpgradeSafetyInternals.inspectControlPlaneSnapshot(
          databaseUrl!,
          "k".repeat(32),
          snapshotId,
        );
        expect(inspection.snapshotId).toBe(snapshotId);

        await writer.begin(async (transaction) => {
          await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          await transaction.unsafe(`SET TRANSACTION SNAPSHOT '${snapshotId}'`);
          await transaction.unsafe("SET LOCAL lock_timeout = '1s'");
          await transaction.unsafe(`ALTER TABLE public.project_secrets ADD COLUMN ${column} integer`);
          const [added] = await transaction<{ present: boolean }[]>`
            SELECT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'project_secrets'
                AND column_name = ${column}
            ) AS present
          `;
          expect(added?.present).toBe(true);
          await transaction.unsafe(`ALTER TABLE public.project_secrets DROP COLUMN ${column}`);
        });
      });
    } finally {
      await writer.close({ timeout: 1 });
    }
  },
  10_000,
);
