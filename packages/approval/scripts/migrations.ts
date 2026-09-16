import { createHash } from 'node:crypto';
import { renderDurableApprovalMigration, renderApprovalSubjectMigration, renderApprovalTaskMigration, renderApprovalGraphMigration } from '../src/durable.js';

export interface ApprovalMigration {
  version: string;
  sql: string;
}

export async function loadApprovalMigrations(): Promise<readonly ApprovalMigration[]> {
  return [
    { version: '001', sql: renderDurableApprovalMigration(
      await Bun.file(new URL('../sql/001-durable.sql', import.meta.url)).text()) },
    { version: '002', sql: await Bun.file(new URL('../sql/002-operations.sql', import.meta.url)).text() },
    { version: '003', sql: await Bun.file(new URL('../sql/003-recovery-guards.sql', import.meta.url)).text() },
    { version: '004', sql: await Bun.file(new URL('../sql/004-operator-queue.sql', import.meta.url)).text() },
    { version: '005', sql: renderDurableApprovalMigration(
      await Bun.file(new URL('../sql/005-dynamic-assignment.sql', import.meta.url)).text(), '005') },
    { version: '006', sql: renderApprovalSubjectMigration(
      await Bun.file(new URL('../sql/006-business-snapshot.sql', import.meta.url)).text()) },
    { version: '007', sql: await Bun.file(new URL('../sql/007-review-rounds.sql', import.meta.url)).text() },
    { version: '008', sql: renderApprovalTaskMigration(
      await Bun.file(new URL('../sql/008-task-lifecycle.sql', import.meta.url)).text()) },
    { version: '009', sql: await Bun.file(new URL('../sql/009-reminders.sql', import.meta.url)).text() },
    { version: '010', sql: await Bun.file(new URL('../sql/010-workbench.sql', import.meta.url)).text() },
    { version: '011', sql: renderApprovalGraphMigration(
      await Bun.file(new URL('../sql/011-approval-graphs.sql', import.meta.url)).text()) },
    { version: '012', sql: await Bun.file(new URL('../sql/012-graph-bootstrap-fix.sql', import.meta.url)).text() },
    { version: '013', sql: await Bun.file(new URL('../sql/013-controlled-migration.sql', import.meta.url)).text() },
    { version: '014', sql: await Bun.file(new URL('../sql/014-graph-notifications.sql', import.meta.url)).text() },
  ];
}

/** Generates a psql script; fixed migration transaction boundaries are verified before wrapping. */
export function migrationScript(migrations: readonly ApprovalMigration[], adoptBaseline = false): string {
  if (migrations.length===0) throw new Error('APPROVAL_MIGRATION_ORDER');
  let previous = '';
  const parts = migrations.map(migration => {
    if (!/^\d{3}$/.test(migration.version) || migration.version <= previous) throw new Error('APPROVAL_MIGRATION_ORDER');
    previous = migration.version;
    if ((migration.sql.match(/^BEGIN;$/gm) ?? []).length !== 1
      || (migration.sql.match(/^COMMIT;$/gm) ?? []).length !== 1
      || !migration.sql.trimEnd().endsWith('COMMIT;')) throw new Error('APPROVAL_MIGRATION_BOUNDARY');
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const body = migration.sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    return `
BEGIN;
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM approval_migrations.applied WHERE version='${migration.version}' AND sha256<>'${checksum}') THEN
    RAISE EXCEPTION 'APPROVAL_MIGRATION_CHECKSUM_MISMATCH ${migration.version}';
  END IF;
END $check$;
SELECT NOT EXISTS (SELECT 1 FROM approval_migrations.applied WHERE version='${migration.version}') AS approval_apply
\\gset
\\if :approval_apply
${body}
RESET ROLE;
INSERT INTO approval_migrations.applied(version,sha256) VALUES('${migration.version}','${checksum}');
\\endif
COMMIT;`;
  });
  return `\\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtextextended('approval-migrations',0));
DO $baseline$
BEGIN
  IF ${adoptBaseline ? 'false' : 'true'} AND to_regclass('approval.runs') IS NOT NULL THEN
    IF to_regclass('approval_migrations.applied') IS NULL THEN
      RAISE EXCEPTION 'APPROVAL_UNTRACKED_BASELINE: review before explicit adoption';
    ELSIF NOT EXISTS(SELECT 1 FROM approval_migrations.applied WHERE version='001') THEN
      RAISE EXCEPTION 'APPROVAL_UNTRACKED_BASELINE: missing initial migration receipt';
    END IF;
  END IF;
END $baseline$;
CREATE SCHEMA IF NOT EXISTS approval_migrations;
REVOKE ALL ON SCHEMA approval_migrations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS approval_migrations.applied(
  version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON approval_migrations.applied FROM PUBLIC;
DO $supported$
BEGIN
  IF EXISTS (SELECT 1 FROM approval_migrations.applied WHERE version NOT IN (
    ${migrations.map(m => `'${m.version}'`).join(',')}
  )) THEN RAISE EXCEPTION 'APPROVAL_NEWER_DATABASE_SCHEMA'; END IF;
END $supported$;
${parts.join('\n')}
SELECT pg_advisory_unlock(hashtextextended('approval-migrations',0));
`;
}
