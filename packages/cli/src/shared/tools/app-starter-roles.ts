export const STARTER_RUNTIME_ROLES_SCHEMA = `-- Explicit administrator migration after 001-003 and command persistence.
-- These cluster-wide names are reserved for this reference application.
-- Existing role names fail closed: never adopt an unknown role or its memberships.
CREATE ROLE starter_review_http NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE starter_review_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO starter_review_http, starter_review_worker;
GRANT SELECT ON public.starter_application, public.starter_members,
  public.starter_reviews, public.starter_attachments TO starter_review_http, starter_review_worker;

-- PostgreSQL row locks require UPDATE privilege. Restrictive checks below
-- prevent that lock privilege from allowing changes to these authority records.
GRANT UPDATE(singleton) ON public.starter_application TO starter_review_http, starter_review_worker;
GRANT UPDATE(subject) ON public.starter_members TO starter_review_http, starter_review_worker;
GRANT UPDATE(review_id) ON public.starter_attachments TO starter_review_http, starter_review_worker;
GRANT UPDATE(state,version) ON public.starter_reviews TO starter_review_http;
GRANT UPDATE(id) ON public.starter_reviews TO starter_review_worker;
GRANT INSERT ON public.starter_attachments TO starter_review_http;
GRANT SELECT,INSERT ON public.starter_attachment_results TO starter_review_worker;

CREATE POLICY starter_backend_binding_read ON public.starter_application FOR SELECT
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_binding_lock ON public.starter_application FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_binding_immutable ON public.starter_application AS RESTRICTIVE FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true) WITH CHECK (false);
CREATE POLICY starter_backend_member_read ON public.starter_members FOR SELECT
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_member_lock ON public.starter_members FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_member_immutable ON public.starter_members AS RESTRICTIVE FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true) WITH CHECK (false);
CREATE POLICY starter_backend_review_read ON public.starter_reviews FOR SELECT
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_review_update ON public.starter_reviews FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_worker_review_immutable ON public.starter_reviews AS RESTRICTIVE FOR UPDATE
  TO starter_review_worker USING (true) WITH CHECK (false);
CREATE POLICY starter_backend_attachment_read ON public.starter_attachments FOR SELECT
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_attachment_lock ON public.starter_attachments FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true);
CREATE POLICY starter_backend_attachment_immutable ON public.starter_attachments AS RESTRICTIVE FOR UPDATE
  TO starter_review_http, starter_review_worker USING (true) WITH CHECK (false);
CREATE POLICY starter_http_attachment_insert ON public.starter_attachments FOR INSERT
  TO starter_review_http WITH CHECK (true);
CREATE POLICY starter_worker_result_read ON public.starter_attachment_results FOR SELECT
  TO starter_review_worker USING (true);
CREATE POLICY starter_worker_result_insert ON public.starter_attachment_results FOR INSERT
  TO starter_review_worker WITH CHECK (true);

GRANT USAGE ON SCHEMA supacloud_commands, supacloud_workflows TO starter_review_http;
GRANT SELECT,INSERT ON supacloud_commands.execution_receipts TO starter_review_http;
GRANT INSERT ON supacloud_commands.execution_audit TO starter_review_http;
-- The receipt trigger checks canonical submission identity even for local commands.
GRANT EXECUTE ON FUNCTION supacloud_commands.snapshot(uuid,boolean) TO starter_review_http;
GRANT EXECUTE ON FUNCTION supacloud_workflows.start_run(uuid,text,text,text,jsonb,integer) TO starter_review_http;
`;
