import { describe, expect, test } from "bun:test";
import { InvalidWebhookRecordError, readWebhookRow, readWebhookRows } from "../../src/utils/webhook-record";

const row = {
  id: "11111111-1111-4111-8111-111111111111", project_ref: "project-one",
  url: "https://hooks.example.com/events", events: ["user.created"], secret_version: 1,
  enabled: false, api_version: "2026-07-01", created_by: null,
  created_at: new Date(0), updated_at: new Date(0), deleted_at: null, has_secret: false,
};

describe("persisted webhook metadata", () => {
  test.each([
    { id: undefined }, { project_ref: "another-project" }, { enabled: "false" },
    { secret_version: "1" }, { secret_version: 0 }, { has_secret: null },
    { created_at: new Date(NaN) }, { created_at: "2026-01-01" }, { deleted_at: undefined },
    { events: "user.created" }, { events: [1] }, { events: [] }, { events: ["*", "*"] }, { events: Array(1) },
  ])("rejects malformed records without returning partial data", (overrides) => {
    expect(() => readWebhookRows([{ ...row, ...overrides }], row.project_ref))
      .toThrow(InvalidWebhookRecordError);
  });

  test("validates cardinality and query identity", () => {
    expect(readWebhookRow([], row.project_ref, row.id)).toBeNull();
    expect(() => readWebhookRow([row], row.project_ref, "22222222-2222-4222-8222-222222222222"))
      .toThrow(InvalidWebhookRecordError);
    expect(() => readWebhookRows([row, row], row.project_ref)).toThrow(InvalidWebhookRecordError);
    expect(() => readWebhookRows(null, row.project_ref)).toThrow(InvalidWebhookRecordError);
    expect(() => readWebhookRows(Array(1), row.project_ref)).toThrow(InvalidWebhookRecordError);
  });

  test("copies valid false and null fields without retaining secret columns or aliases", () => {
    const copy = readWebhookRow([{ ...row, future_secret: "hidden" }], row.project_ref, row.id);
    expect(copy).toEqual(row);
    if (!copy) throw new Error("Missing webhook fixture");
    expect(copy.events).not.toBe(row.events);
    expect(copy.created_at).not.toBe(row.created_at);
    expect(copy).not.toHaveProperty("future_secret");
  });
});
