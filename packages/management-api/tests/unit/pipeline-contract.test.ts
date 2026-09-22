import { describe, expect, test } from "bun:test";
import {
  PipelineError, normalizePipelineInput, readPipelineCredentials, readPipelineRow, readPipelineRows,
} from "../../src/utils/pipeline-contract";
import { pipelineRequest, pipelineRow } from "../helpers/pipeline";

const ref = "fixture-project";
const id = "7dab7730-f575-4b35-a2d7-5a3eabb2cbb4";

describe("pipeline input contract", () => {
  test.each([null, [], true, 0, "input", {}].map(value => ({ value })))("rejects malformed input %#", ({ value }) => {
    expect(() => normalizePipelineInput(value)).toThrow(PipelineError);
  });

  test.each(["null", "[]", "false", "0", '"key"', "{}", "{", '{"type":"service_account"}'])(
    "rejects malformed service account %s", service_account_key => {
      const input = pipelineRequest();
      expect(() => normalizePipelineInput({
        ...input, destination: { ...input.destination, service_account_key },
      })).toThrow(PipelineError);
    },
  );

  test.each([
    { batch_wait_ms: null }, { batch_wait_ms: "0" }, { batch_wait_ms: NaN },
    { batch_wait_ms: -1 }, { sync_workers: 0 }, { sync_workers: 1.5 },
    { sync_workers: 33 }, { slot_recovery: "reset" }, { slot_recovery: null },
    { name: 1 }, { name: "name\n" }, { publication_name: ["public"] }, { publication_name: "pub\n" }, { destination: null },
  ])("rejects invalid settings %j", patch => {
    expect(() => normalizePipelineInput({ ...pipelineRequest(), ...patch })).toThrow(PipelineError);
  });

  test("preserves zero and takes a detached input snapshot", () => {
    const input = pipelineRequest();
    input.destination.max_staleness_mins = 0;
    input.batch_wait_ms = 0;
    const normalized = normalizePipelineInput(input);
    input.destination.project_id = "changed";
    expect(normalized.batch_wait_ms).toBe(0);
    expect(normalized.destination.max_staleness_mins).toBe(0);
    expect(normalized.destination.project_id).toBe(ref);
    expect(normalized.sync_workers).toBe(4);
    expect(normalized.slot_recovery).toBe("error");
    expect(Object.hasOwn(normalizePipelineInput(pipelineRequest()).destination, "max_staleness_mins")).toBe(false);
  });
});

describe("pipeline database records", () => {
  test.each([42, 42n, "42"])("accepts exact runtime ID %s", runtime_id => {
    const row = readPipelineRow([pipelineRow({ runtime_id })], ref, id.toUpperCase());
    expect(row?.runtime_id).toBe(42);
    expect(row?.settings).toEqual({ batch_wait_ms: 0, sync_workers: 1, slot_recovery: "error", max_staleness_mins: 0 });
  });

  test.each([
    { runtime_id: 0 }, { runtime_id: -1 }, { runtime_id: 1.5 }, { runtime_id: true },
    { runtime_id: "01" }, { runtime_id: "1e2" }, { runtime_id: "../other" }, { runtime_id: "42\n" },
    { runtime_id: 9_007_199_254_740_992n }, { runtime_id: "9007199254740993" },
    { destination_type: "postgres" }, { project_ref: "other" }, { desired_state: "active" },
    { name: {} }, { created_at: new Date("invalid") }, { updated_at: "2026-01-01" },
    { settings: null }, { settings: [] }, { settings: "{" }, { settings: { sync_workers: "4" } },
    { settings: { slot_recovery: "reset" } }, { settings: { batch_wait_ms: null } },
    { settings: { max_staleness_mins: -1 } }, { destination_secret_encrypted: null },
  ])("rejects malformed stored values %#", patch => {
    expect(() => readPipelineRows([pipelineRow(patch)], ref)).toThrow("Invalid persisted pipeline record");
  });

  test("accepts legacy JSON text and null staleness without coercing other fields", () => {
    const row = readPipelineRow([pipelineRow({
      settings: JSON.stringify({ max_staleness_mins: null }),
    })], ref);
    expect(row?.settings).toEqual({ batch_wait_ms: 5000, sync_workers: 4, slot_recovery: "error" });
  });

  test("rejects missing, duplicate, sparse or mismatched row identities", () => {
    expect(readPipelineRow([], ref)).toBeNull();
    expect(() => readPipelineRows({}, ref)).toThrow(PipelineError);
    expect(() => readPipelineRows(new Array(1), ref)).toThrow(PipelineError);
    expect(() => readPipelineRow([pipelineRow(), pipelineRow()], ref)).toThrow(PipelineError);
    expect(() => readPipelineRow([pipelineRow()], ref, crypto.randomUUID())).toThrow(PipelineError);
    expect(() => readPipelineRows([pipelineRow(), pipelineRow({ id: crypto.randomUUID() })], ref)).toThrow(PipelineError);
  });

  test("projects only known fields and copies mutable data", () => {
    const raw = pipelineRow({ future_secret: "hidden" });
    const row = readPipelineRow([raw], ref);
    expect(row).not.toHaveProperty("future_secret");
    expect(row?.settings).not.toBe(raw.settings);
    expect(row?.created_at).not.toBe(raw.created_at);
  });

  const credentials = { ref, db_name: "fixture database", db_user: "fixture", db_password: "pass%@: " };
  test("preserves exact database credentials", () => {
    expect(readPipelineCredentials([credentials], ref)).toEqual({
      database: "fixture database", username: "fixture", password: "pass%@: ",
    });
  });
  test.each([
    { ref: "other" }, { db_name: null }, { db_user: true }, { db_user: 'bad" role' }, { db_user: "role\n" },
    { db_password: 123 }, { db_password: "" }, { db_name: "bad\0name" },
  ])("rejects malformed credentials %j", patch => {
    expect(() => readPipelineCredentials([{ ...credentials, ...patch }], ref)).toThrow(PipelineError);
  });
  test("does not accept multiple, sparse or missing credential receipts", () => {
    expect(() => readPipelineCredentials([], ref)).toThrow("Project not found");
    expect(() => readPipelineCredentials([credentials, credentials], ref)).toThrow(PipelineError);
    expect(() => readPipelineCredentials(new Array(1), ref)).toThrow(PipelineError);
  });
});
