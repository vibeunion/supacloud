export function renderStarterRuntimeRolesSchema(httpRole: string, workerRole: string): string {
  if (httpRole === workerRole || [httpRole, workerRole].some(role => !/^[a-z_][a-z0-9_]{0,62}$/.test(role))) {
    throw new Error("Distinct PostgreSQL runtime role names required");
  }
  return `-- Explicit administrator migration after 001-003 and command persistence.
-- These cluster-wide names are reserved for this reference application.
-- Existing role names fail closed: never adopt an unknown role or its memberships.
CREATE ROLE ${httpRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ${workerRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO ${httpRole}, ${workerRole};
GRANT SELECT ON public.starter_application, public.starter_members,
  public.starter_reviews, public.starter_attachments TO ${httpRole}, ${workerRole};

-- PostgreSQL row locks require UPDATE privilege. Restrictive checks below
-- prevent that lock privilege from allowing changes to these authority records.
GRANT UPDATE(singleton) ON public.starter_application TO ${httpRole}, ${workerRole};
GRANT UPDATE(subject) ON public.starter_members TO ${httpRole}, ${workerRole};
GRANT UPDATE(review_id) ON public.starter_attachments TO ${httpRole}, ${workerRole};
GRANT UPDATE(state,version) ON public.starter_reviews TO ${httpRole};
GRANT UPDATE(id) ON public.starter_reviews TO ${workerRole};
GRANT INSERT ON public.starter_attachments TO ${httpRole};
GRANT SELECT,INSERT ON public.starter_attachment_results TO ${workerRole};

CREATE POLICY starter_backend_binding_read ON public.starter_application FOR SELECT
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_binding_lock ON public.starter_application FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_binding_immutable ON public.starter_application AS RESTRICTIVE FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true) WITH CHECK (false);
CREATE POLICY starter_backend_member_read ON public.starter_members FOR SELECT
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_member_lock ON public.starter_members FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_member_immutable ON public.starter_members AS RESTRICTIVE FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true) WITH CHECK (false);
CREATE POLICY starter_backend_review_read ON public.starter_reviews FOR SELECT
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_review_update ON public.starter_reviews FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_worker_review_immutable ON public.starter_reviews AS RESTRICTIVE FOR UPDATE
  TO ${workerRole} USING (true) WITH CHECK (false);
CREATE POLICY starter_backend_attachment_read ON public.starter_attachments FOR SELECT
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_attachment_lock ON public.starter_attachments FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true);
CREATE POLICY starter_backend_attachment_immutable ON public.starter_attachments AS RESTRICTIVE FOR UPDATE
  TO ${httpRole}, ${workerRole} USING (true) WITH CHECK (false);
CREATE POLICY starter_http_attachment_insert ON public.starter_attachments FOR INSERT
  TO ${httpRole} WITH CHECK (true);
CREATE POLICY starter_worker_result_read ON public.starter_attachment_results FOR SELECT
  TO ${workerRole} USING (true);
CREATE POLICY starter_worker_result_insert ON public.starter_attachment_results FOR INSERT
  TO ${workerRole} WITH CHECK (true);

GRANT USAGE ON SCHEMA supacloud_commands, supacloud_workflows TO ${httpRole};
GRANT SELECT,INSERT ON supacloud_commands.execution_receipts TO ${httpRole};
GRANT INSERT ON supacloud_commands.execution_audit TO ${httpRole};
-- The receipt trigger checks canonical submission identity even for local commands.
GRANT EXECUTE ON FUNCTION supacloud_commands.snapshot(uuid,boolean) TO ${httpRole};
GRANT EXECUTE ON FUNCTION supacloud_workflows.start_run(uuid,text,text,text,jsonb,integer) TO ${httpRole};
`;
}

export const STARTER_RUNTIME_ROLES_SCHEMA = renderStarterRuntimeRolesSchema("starter_review_http", "starter_review_worker");
