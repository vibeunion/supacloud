import type { SQL } from "bun";

export const PROJECT_MUTATION_JOURNAL_MIGRATION_KEY = "20260812_project_mutation_journal_v3";
export const PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY =
  "20260813_project_mutation_recovery_contract_v4";

const CANONICAL_RESOURCE_KEY_CONSTRAINT = "project_mutations_resource_key_canonical_v1_check";
const FENCING_EPOCH_SAFE_CONSTRAINT = "project_mutations_fencing_epoch_safe_check";
const RECOVERY_DUE_CONSTRAINT = "project_mutations_recovery_due_v2_check";
const CANONICAL_RESOURCE_KEY_PATTERN = "^v1/[a-z0-9][a-z0-9._-]{0,63}/[A-Za-z0-9_-]{2,171}$";
const CANONICAL_RESOURCE_KEY_FUNCTION = "public.project_mutation_resource_key_is_canonical_v1";

type ConstraintState = {
  conname: string;
  convalidated: boolean;
};

async function migrationIsCompleted(transaction: SQL, migrationKey: string): Promise<boolean> {
  const [marker] = await transaction`
    SELECT migration_key
    FROM public.platform_schema_migrations
    WHERE migration_key = ${migrationKey}
  `;
  return marker?.migration_key === migrationKey;
}

async function constraintState(transaction: SQL, name: string): Promise<ConstraintState | null> {
  const [constraint] = await transaction`
    SELECT conname, convalidated
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.project_mutations'::pg_catalog.regclass AND conname = ${name}
  ` as ConstraintState[];
  return constraint ?? null;
}

async function ensureSucceededResponseConstraint(transaction: SQL): Promise<void> {
  const name = "project_mutations_succeeded_response_check";
  const existing = await constraintState(transaction, name);
  if (!existing) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      ADD CONSTRAINT project_mutations_succeeded_response_check
      CHECK (
        status <> 'succeeded'
        OR (response_status IS NOT NULL AND response_status BETWEEN 200 AND 299)
      ) NOT VALID
    `);
  }
  if (!existing?.convalidated) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      VALIDATE CONSTRAINT project_mutations_succeeded_response_check
    `);
  }
}

async function ensureCanonicalResourceKeyFunction(transaction: SQL): Promise<void> {
  await transaction.unsafe(`
    CREATE OR REPLACE FUNCTION ${CANONICAL_RESOURCE_KEY_FUNCTION}(candidate TEXT)
    RETURNS BOOLEAN
    LANGUAGE plpgsql
    IMMUTABLE
    STRICT
    SET search_path = pg_catalog
    AS $$
    DECLARE
      encoded_id TEXT;
      decoded_id BYTEA;
      decoded_text TEXT;
      canonical_id TEXT;
    BEGIN
      IF candidate !~ '${CANONICAL_RESOURCE_KEY_PATTERN}' THEN
        RETURN FALSE;
      END IF;
      encoded_id := split_part(candidate, '/', 3);
      IF length(encoded_id) % 4 = 1 THEN
        RETURN FALSE;
      END IF;
      decoded_id := decode(
        translate(encoded_id, '-_', '+/')
          || repeat('=', (4 - length(encoded_id) % 4) % 4),
        'base64'
      );
      canonical_id := translate(
        rtrim(replace(encode(decoded_id, 'base64'), E'\\n', ''), '='),
        '+/',
        '-_'
      );
      IF canonical_id <> encoded_id OR octet_length(decoded_id) > 128 THEN
        RETURN FALSE;
      END IF;
      decoded_text := convert_from(decoded_id, 'UTF8');
      RETURN decoded_text = pg_catalog.btrim(
        decoded_text,
        U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'
      )
        AND decoded_text !~ '[[:cntrl:]]';
    EXCEPTION
      WHEN invalid_parameter_value OR character_not_in_repertoire THEN
        -- Only malformed base64url and UTF-8 are recoverable validation failures.
        RETURN FALSE;
    END;
    $$
  `);
}

async function assertCanonicalResourceKeys(transaction: SQL): Promise<void> {
  const [invalid] = await transaction`
    SELECT mutation_id
    FROM public.project_mutations AS mutation
    WHERE mutation.resource_key IS NOT NULL
      AND NOT public.project_mutation_resource_key_is_canonical_v1(mutation.resource_key)
    LIMIT 1
  ` as Array<{ mutation_id: string }>;
  if (invalid) {
    throw new Error("Project mutation migration requires canonical v1 resource keys");
  }
}

async function ensureCanonicalResourceKeyConstraint(transaction: SQL): Promise<void> {
  const existing = await constraintState(transaction, CANONICAL_RESOURCE_KEY_CONSTRAINT);
  if (!existing) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      ADD CONSTRAINT ${CANONICAL_RESOURCE_KEY_CONSTRAINT}
      CHECK (
        resource_key IS NULL
        OR ${CANONICAL_RESOURCE_KEY_FUNCTION}(resource_key)
      ) NOT VALID
    `);
  }
  if (!existing?.convalidated) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      VALIDATE CONSTRAINT ${CANONICAL_RESOURCE_KEY_CONSTRAINT}
    `);
  }
}

async function ensureFencingEpochSafeConstraint(transaction: SQL): Promise<void> {
  const existing = await constraintState(transaction, FENCING_EPOCH_SAFE_CONSTRAINT);
  if (!existing) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      ADD CONSTRAINT ${FENCING_EPOCH_SAFE_CONSTRAINT}
      CHECK (fencing_epoch <= 9007199254740991) NOT VALID
    `);
  }
  if (!existing?.convalidated) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      VALIDATE CONSTRAINT ${FENCING_EPOCH_SAFE_CONSTRAINT}
    `);
  }
}

async function backfillRecoverySchedule(transaction: SQL): Promise<number> {
  const rows = await transaction`
    UPDATE public.project_mutations
    SET recovery_not_before = COALESCE(updated_at, created_at, clock_timestamp())
    WHERE recovery_not_before IS NULL
      AND status IN ('pending', 'running', 'failed_retryable')
    RETURNING mutation_id
  ` as Array<{ mutation_id: string }>;
  return rows.length;
}

async function ensureRecoverableDueConstraint(transaction: SQL): Promise<void> {
  const name = "project_mutations_recoverable_due_check";
  const existing = await constraintState(transaction, name);
  if (!existing) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      ADD CONSTRAINT project_mutations_recoverable_due_check
      CHECK (
        status NOT IN ('pending', 'running', 'failed_retryable')
        OR recovery_not_before IS NOT NULL
      ) NOT VALID
    `);
  }
  if (!existing?.convalidated) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      VALIDATE CONSTRAINT project_mutations_recoverable_due_check
    `);
  }
}

async function recordMigration(
  transaction: SQL,
  migrationKey: string,
  details: Record<string, number>,
): Promise<void> {
  await transaction`
    INSERT INTO public.platform_schema_migrations (migration_key, details)
    VALUES (${migrationKey}, ${JSON.stringify(details)}::jsonb)
  `;
}

async function migrateProjectMutationJournalV3(transaction: SQL): Promise<void> {
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY})
    )
  `;
  if (await migrationIsCompleted(transaction, PROJECT_MUTATION_JOURNAL_MIGRATION_KEY)) return;

  await ensureCanonicalResourceKeyFunction(transaction);
  await assertCanonicalResourceKeys(transaction);
  await transaction.unsafe(`
    ALTER TABLE public.project_mutations
    ALTER COLUMN recovery_not_before SET DEFAULT clock_timestamp()
  `);
  const backfilledRows = await backfillRecoverySchedule(transaction);
  await ensureCanonicalResourceKeyConstraint(transaction);
  await ensureFencingEpochSafeConstraint(transaction);
  await ensureSucceededResponseConstraint(transaction);
  await ensureRecoverableDueConstraint(transaction);
  await recordMigration(transaction, PROJECT_MUTATION_JOURNAL_MIGRATION_KEY, {
    backfilled_recovery_rows: backfilledRows,
  });
}

async function backfillRecoverableRecoverySchedule(transaction: SQL): Promise<number> {
  const updatedMutations = await transaction`
    UPDATE public.project_mutations
    SET recovery_not_before = COALESCE(updated_at, created_at, clock_timestamp())
    WHERE recovery_not_before IS NULL
      AND status IN ('running', 'failed_retryable')
    RETURNING mutation_id
  ` as Array<{ mutation_id: string }>;
  return updatedMutations.length;
}

async function ensureRecoveryDueConstraint(transaction: SQL): Promise<void> {
  const existing = await constraintState(transaction, RECOVERY_DUE_CONSTRAINT);
  if (!existing) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      ADD CONSTRAINT ${RECOVERY_DUE_CONSTRAINT}
      CHECK (
        status NOT IN ('running', 'failed_retryable')
        OR recovery_not_before IS NOT NULL
      ) NOT VALID
    `);
  }
  if (!existing?.convalidated) {
    await transaction.unsafe(`
      ALTER TABLE public.project_mutations
      VALIDATE CONSTRAINT ${RECOVERY_DUE_CONSTRAINT}
    `);
  }
}

async function clearPendingRecoverySchedule(transaction: SQL): Promise<number> {
  const updatedMutations = await transaction`
    UPDATE public.project_mutations
    SET recovery_not_before = NULL
    WHERE status = 'pending' AND recovery_not_before IS NOT NULL
    RETURNING mutation_id
  ` as Array<{ mutation_id: string }>;
  return updatedMutations.length;
}

async function replaceRecoveryIndex(transaction: SQL): Promise<void> {
  await transaction.unsafe(`
    CREATE INDEX IF NOT EXISTS project_mutations_recovery_v2_idx
    ON public.project_mutations(operation, recovery_not_before, updated_at, mutation_id)
    WHERE recovery_not_before IS NOT NULL
      AND status IN ('running', 'failed_retryable')
  `);
  await transaction.unsafe(`
    DROP INDEX IF EXISTS public.project_mutations_recovery_idx
  `);
}

async function migrateProjectMutationRecoveryContractV4(transaction: SQL): Promise<void> {
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(${PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY})
    )
  `;
  if (await migrationIsCompleted(transaction, PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY)) return;

  await transaction.unsafe(`
    ALTER TABLE public.project_mutations
    ALTER COLUMN recovery_not_before DROP DEFAULT
  `);
  const backfilledRows = await backfillRecoverableRecoverySchedule(transaction);
  await ensureRecoveryDueConstraint(transaction);
  await transaction.unsafe(`
    ALTER TABLE public.project_mutations
    DROP CONSTRAINT IF EXISTS project_mutations_recoverable_due_check
  `);
  const clearedPendingRows = await clearPendingRecoverySchedule(transaction);
  await replaceRecoveryIndex(transaction);
  await recordMigration(transaction, PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY, {
    backfilled_recovery_rows: backfilledRows,
    cleared_pending_recovery_rows: clearedPendingRows,
  });
}

export async function migrateProjectMutationJournal(transaction: SQL): Promise<void> {
  await migrateProjectMutationJournalV3(transaction);
  await migrateProjectMutationRecoveryContractV4(transaction);
}
