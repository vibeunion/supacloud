import type { PipelineRequest } from "../../src/utils/pipeline-contract";

export function pipelineRequest(): PipelineRequest {
  return {
    name: "warehouse",
    publication_name: "analytics_publication",
    destination: {
      type: "bigquery",
      project_id: "fixture-project",
      dataset_id: "app_dataset",
      service_account_key: JSON.stringify({
        type: "service_account",
        client_email: "etl@fixture.invalid",
        private_key: "synthetic-test-key",
      }),
    },
  };
}

export function pipelineRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const input = pipelineRequest();
  return {
    id: "7dab7730-f575-4b35-a2d7-5a3eabb2cbb4",
    runtime_id: 42,
    project_ref: "fixture-project",
    name: input.name,
    publication_name: input.publication_name,
    destination_type: input.destination.type,
    destination_project_id: input.destination.project_id,
    destination_dataset_id: input.destination.dataset_id,
    destination_secret_encrypted: input.destination.service_account_key,
    settings: { batch_wait_ms: 0, sync_workers: 1, slot_recovery: "error", max_staleness_mins: 0 },
    desired_state: "stopped",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
