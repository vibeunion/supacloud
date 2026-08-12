import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  PROJECT_MUTATION_JOURNAL_MIGRATION_KEY,
  PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY,
  migrateProjectMutationJournal,
} from "../../src/db/project-mutation-migration";

type MigrationFixtureOptions = {
  markers?: string[];
  constraints?: Record<string, boolean>;
  backfilledRows?: number;
  invalidResourceKeys?: number;
};

function migrationFixture(options: MigrationFixtureOptions = {}) {
  const markers = new Set(options.markers ?? []);
  const constraints = new Map(Object.entries(options.constraints ?? {}));
  const taggedQueries: string[] = [];
  const unsafeQueries: string[] = [];
  const transaction = Object.assign(
    async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const query = strings.join("?").replaceAll(/\s+/g, " ").trim();
      taggedQueries.push(query);
      if (query.includes("FROM public.platform_schema_migrations")) {
        const migrationKey = String(parameters[0]);
        return markers.has(migrationKey) ? [{ migration_key: migrationKey }] : [];
      }
      if (query.includes("FROM pg_catalog.pg_constraint")) {
        const name = String(parameters[0]);
        return constraints.has(name) ? [{ conname: name, convalidated: constraints.get(name) }] : [];
      }
      if (query.includes("NOT public.project_mutation_resource_key_is_canonical_v1(mutation.resource_key)")) {
        return Array.from({ length: options.invalidResourceKeys ?? 0 }, (_, index) => ({ mutation_id: String(index) }));
      }
      if (query.startsWith("UPDATE public.project_mutations")) {
        return Array.from({ length: options.backfilledRows ?? 0 }, (_, index) => ({ mutation_id: String(index) }));
      }
      if (query.startsWith("INSERT INTO public.platform_schema_migrations")) {
        markers.add(String(parameters[0]));
      }
      return [];
    },
    {
      unsafe: async (query: string) => {
        const normalized = query.replaceAll(/\s+/g, " ").trim();
        unsafeQueries.push(normalized);
        const added = normalized.match(/ADD CONSTRAINT (project_mutations_[a-z_]+)/)?.[1];
        const validated = normalized.match(/VALIDATE CONSTRAINT (project_mutations_[a-z_]+)/)?.[1];
        if (added) constraints.set(added, false);
        if (validated) constraints.set(validated, true);
      },
    },
  );
  return { transaction: transaction as unknown as SQL, taggedQueries, unsafeQueries, markers };
}

describe("project mutation journal migration", () => {
  test("runs v3 then narrows recovery scheduling in a separately marked v4 evolution", async () => {
    const fixture = migrationFixture({ backfilledRows: 2 });

    await migrateProjectMutationJournal(fixture.transaction);
    await migrateProjectMutationJournal(fixture.transaction);

    expect(fixture.unsafeQueries).toContainEqual(expect.stringContaining(
      "ALTER COLUMN recovery_not_before SET DEFAULT clock_timestamp()",
    ));
    expect(fixture.unsafeQueries).toContainEqual(expect.stringContaining(
      "ALTER COLUMN recovery_not_before DROP DEFAULT",
    ));
    expect(fixture.unsafeQueries.filter((query) => query.includes("ADD CONSTRAINT"))).toHaveLength(5);
    expect(fixture.unsafeQueries.filter((query) => query.includes("VALIDATE CONSTRAINT"))).toHaveLength(5);
    expect(fixture.unsafeQueries).toContainEqual(expect.stringContaining(
      "ADD CONSTRAINT project_mutations_resource_key_canonical_v1_check",
    ));
    expect(fixture.unsafeQueries).toContainEqual(expect.stringContaining(
      "ADD CONSTRAINT project_mutations_fencing_epoch_safe_check",
    ));
    expect(fixture.unsafeQueries).toContainEqual(expect.stringContaining(
      "DROP CONSTRAINT IF EXISTS project_mutations_recoverable_due_check",
    ));
    const recoveryUpdates = fixture.taggedQueries.filter((query) => query.startsWith(
      "UPDATE public.project_mutations",
    ));
    expect(recoveryUpdates).toHaveLength(3);
    expect(recoveryUpdates[0])
      .toContain("status IN ('pending', 'running', 'failed_retryable')");
    expect(recoveryUpdates[1]).toContain("status IN ('running', 'failed_retryable')");
    expect(recoveryUpdates[1]).not.toContain("'pending'");
    expect(recoveryUpdates[2]).toContain("status = 'pending'");
    expect(recoveryUpdates[2]).toContain("SET recovery_not_before = NULL");
    expect(fixture.taggedQueries.filter((query) => query.startsWith("INSERT INTO public.platform_schema_migrations")))
      .toHaveLength(2);
    expect(fixture.markers).toEqual(new Set([
      PROJECT_MUTATION_JOURNAL_MIGRATION_KEY,
      PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY,
    ]));
    const validatorDdl = fixture.unsafeQueries.find((query) => query.startsWith(
      "CREATE OR REPLACE FUNCTION public.project_mutation_resource_key_is_canonical_v1",
    ));
    expect(validatorDdl).toContain("SET search_path = pg_catalog");
    expect(validatorDdl).toContain("WHEN invalid_parameter_value OR character_not_in_repertoire");
    expect(validatorDdl).not.toContain("WHEN OTHERS");
  });

  test("runs v4 when v3 is already marked without replaying v3 mutation DDL", async () => {
    const fixture = migrationFixture({ markers: [PROJECT_MUTATION_JOURNAL_MIGRATION_KEY] });

    await migrateProjectMutationJournal(fixture.transaction);

    expect(fixture.unsafeQueries).toContainEqual(expect.stringContaining(
      "ALTER COLUMN recovery_not_before DROP DEFAULT",
    ));
    expect(fixture.unsafeQueries.some((query) => query.includes("SET DEFAULT clock_timestamp()"))).toBe(false);
    expect(fixture.unsafeQueries.some((query) => query.includes(
      "CREATE OR REPLACE FUNCTION public.project_mutation_resource_key_is_canonical_v1",
    ))).toBe(false);
    const recoveryUpdates = fixture.taggedQueries.filter((query) => query.startsWith(
      "UPDATE public.project_mutations",
    ));
    expect(recoveryUpdates).toHaveLength(2);
    expect(recoveryUpdates[0]).toContain("status IN ('running', 'failed_retryable')");
    expect(recoveryUpdates[1]).toContain("status = 'pending'");
    expect(fixture.markers.has(PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY)).toBe(true);
  });

  test("skips all mutation DDL after both durable markers exist", async () => {
    const fixture = migrationFixture({
      markers: [
        PROJECT_MUTATION_JOURNAL_MIGRATION_KEY,
        PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY,
      ],
    });

    await migrateProjectMutationJournal(fixture.transaction);

    expect(fixture.unsafeQueries).toHaveLength(0);
    expect(fixture.taggedQueries).toHaveLength(4);
    expect(fixture.taggedQueries[0]).toContain("pg_advisory_xact_lock");
    expect(fixture.taggedQueries[1]).toContain("FROM public.platform_schema_migrations");
    expect(fixture.taggedQueries[2]).toContain("pg_advisory_xact_lock");
    expect(fixture.taggedQueries[3]).toContain("FROM public.platform_schema_migrations");
  });

  test("fails before backfill, constraints, or marker when a legacy raw resource key remains", async () => {
    const fixture = migrationFixture({ invalidResourceKeys: 1 });

    await expect(migrateProjectMutationJournal(fixture.transaction))
      .rejects.toThrow("requires canonical v1 resource keys");

    expect(fixture.unsafeQueries).toHaveLength(1);
    expect(fixture.unsafeQueries[0]).toContain(
      "CREATE OR REPLACE FUNCTION public.project_mutation_resource_key_is_canonical_v1",
    );
    expect(fixture.taggedQueries.some((query) => query.startsWith("UPDATE public.project_mutations"))).toBe(false);
    expect(fixture.taggedQueries.some((query) => query.startsWith("INSERT INTO public.platform_schema_migrations")))
      .toBe(false);
  });
});
