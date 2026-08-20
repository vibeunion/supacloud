import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const migration = readFileSync(
  resolve(repositoryRoot, "docs/examples/maker-checker-state-machine.sql"),
  "utf8",
);
const machine = readFileSync(
  resolve(repositoryRoot, "docs/examples/maker-checker-machine.ts"),
  "utf8",
);
const workflowBridge = readFileSync(
  resolve(repositoryRoot, "docs/examples/maker-checker-workflow-bridge.sql"),
  "utf8",
);
const workflowDispatcher = readFileSync(
  resolve(repositoryRoot, "docs/examples/maker-checker-workflow-dispatcher.ts"),
  "utf8",
);
const managementPackage = JSON.parse(readFileSync(
  resolve(repositoryRoot, "packages/management-api/package.json"),
  "utf8",
));

describe("Maker-Checker application reference", () => {
  test("keeps transition, concurrency, replay, and audit enforcement in PostgreSQL", () => {
    expect(migration).toContain("FOR UPDATE;");
    expect(migration).toContain("v_document_id uuid;");
    expect(migration).not.toContain("\n  document_id uuid;");
    expect(migration.indexOf("FOR UPDATE;")).toBeLessThan(
      migration.indexOf("SELECT * INTO existing_event"),
    );
    expect(migration).toContain("REVIEW_DOCUMENT_STALE_VERSION");
    expect(migration).toContain("REVIEW_DOCUMENT_IDEMPOTENCY_CONFLICT");
    expect(migration).toContain("document.maker_id <> v_actor_id");
    expect(migration).toContain("document.submitted_payload = document.payload");
    expect(migration).toContain("document.submitted_payload_checksum = v_payload_checksum");
    expect(migration).toContain("WHEN v_transition_event = 'submit' THEN payload");
    expect(migration).toContain("LANGUAGE sql VOLATILE SECURITY DEFINER");
    expect(migration).toContain("REVIEW_DOCUMENT_DIRECT_TRANSITION_FORBIDDEN");
    expect(migration).toContain("REVIEW_DOCUMENT_EVENT_APPEND_ONLY");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.guard_review_document_transition() FROM PUBLIC",
    );
    expect(migration).toContain("UNIQUE (document_id, idempotency_key)");
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE).*authenticated/i);
  });

  test("keeps XState as a UI projection with the same state vocabulary", () => {
    for (const state of ["draft", "submitted", "returned", "approved", "completed"]) {
      expect(machine).toContain(`${state}:`);
    }
    expect(machine).toContain("context.actorId !== context.makerId");
    expect(machine).toContain("context.submittedPayloadChecksum === context.payloadChecksum");
    expect(machine).toContain("transition_review_document()");
    expect(machine).toContain("input: {} as ReviewContext");
    expect(managementPackage.dependencies).not.toHaveProperty("xstate");
  });

  test("hands transition side effects to Durable Workflows through a leased outbox", () => {
    expect(workflowBridge).toContain("AFTER INSERT ON public.review_document_transition_events");
    expect(workflowBridge).toContain("FOR UPDATE OF outbox SKIP LOCKED");
    expect(workflowBridge).toContain("workflow_run_id uuid NOT NULL");
    expect(workflowBridge).toContain("GRANT EXECUTE ON FUNCTION public.claim_review_document_workflow");
    expect(workflowBridge).toContain("transitionEventId");
    expect(workflowBridge).toContain("entityVersion");
    expect(workflowBridge).toContain("REVIEW_DOCUMENT_WORKFLOW_OUTBOX_APPEND_ONLY");
    expect(workflowBridge).not.toContain("NEW.payload");
    expect(workflowBridge).not.toContain("PERFORM public.supacloud_workflow_start");
    expect(workflowBridge).not.toMatch(/GRANT\s+EXECUTE.*authenticated/i);
    expect(workflowBridge).not.toMatch(/GRANT\s+EXECUTE.*anon/i);
    expect(workflowDispatcher).toContain("supacloud.workflows.start({");
    expect(workflowDispatcher).toContain("invokeWorkflowBridgeRpc");
    expect(workflowDispatcher).toContain("runId: claim.runId");
    expect(workflowDispatcher).toContain("complete_review_document_workflow_dispatch");
    expect(workflowDispatcher).toContain("release_review_document_workflow_dispatch");
    expect(workflowDispatcher).not.toContain("SUPABASE_SERVICE_ROLE_KEY,");
  });
});
