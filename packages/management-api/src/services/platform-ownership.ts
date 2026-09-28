export const PLATFORM_PUBLIC_ROUTINES = [
  ["supacloud_workflow_start", "supacloud_workflows"],
  ["supacloud_workflow_claim", "supacloud_workflows"],
  ["supacloud_workflow_advance", "supacloud_workflows"],
  ["supacloud_workflow_complete", "supacloud_workflows"],
  ["supacloud_workflow_retry", "supacloud_workflows"],
  ["supacloud_workflow_fail", "supacloud_workflows"],
  ["supacloud_workflow_cancel", "supacloud_workflows"],
  ["supacloud_workflow_get", "supacloud_workflows"],
  ["supacloud_workflow_events", "supacloud_workflows"],
  ["supacloud_command_submit", "supacloud_commands"],
  ["supacloud_command_get", "supacloud_commands"],
  ["supacloud_artifact_register", "supacloud_artifacts"],
  ["supacloud_artifact_get", "supacloud_artifacts"],
  ["supacloud_artifact_link", "supacloud_artifacts"],
] as const;

export const PLATFORM_PUBLIC_ROUTINE_VALUES_SQL = PLATFORM_PUBLIC_ROUTINES
  .map(([name, schema]) => `('public.${name}(jsonb)', '${schema}')`).join(",\n");

/** Restore only registered wrappers; never transfer private objects or grant access. */
export function renderPlatformRpcOwnershipSql(): string {
  return `
DO $platform_rpc_ownership$
DECLARE
  object_row RECORD;
BEGIN
  FOR object_row IN
    SELECT p.oid, p.proowner, p.prosecdef, n.nspowner AS expected_owner
    FROM (VALUES ${PLATFORM_PUBLIC_ROUTINE_VALUES_SQL}) AS platform(signature, private_schema)
    JOIN pg_proc p ON p.oid = to_regprocedure(platform.signature)
    LEFT JOIN pg_namespace n ON n.nspname = platform.private_schema
  LOOP
    IF object_row.expected_owner IS NULL OR NOT object_row.prosecdef THEN
      RAISE EXCEPTION 'PLATFORM_RPC_OWNERSHIP_CONTEXT_INVALID';
    END IF;
    IF object_row.proowner <> object_row.expected_owner THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',
        object_row.oid::regprocedure, pg_get_userbyid(object_row.expected_owner));
    END IF;
  END LOOP;
END
$platform_rpc_ownership$;
`;
}

export async function repairPlatformRpcOwnership(
  database: { unsafe(statement: string): Promise<unknown> },
): Promise<void> {
  await database.unsafe(renderPlatformRpcOwnershipSql());
}
