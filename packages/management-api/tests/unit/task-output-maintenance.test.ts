import { test } from "bun:test";
import assert from "node:assert/strict";
import { taskOutputMaintenanceFingerprint, taskOutputMaintenanceOptions } from "../../src/utils/task-output-maintenance-options";
import { taskOutputFailure } from "../../src/routes/task-output-handler";
import { TaskOutputError } from "../../src/utils/task-output";

test("maintenance defaults to a bounded, non-destructive dry run", () => {
  assert.deepEqual(taskOutputMaintenanceOptions([]), { mode: "dry-run", limit: 25 });
});
test("maintenance apply is explicit and bounded", () => {
  assert.deepEqual(taskOutputMaintenanceOptions(["--apply", "--limit", "100"]), { mode: "apply", limit: 100 });
  assert.deepEqual(taskOutputMaintenanceOptions(["--limit", "1", "--dry-run"]), { mode: "dry-run", limit: 1 });
  assert.deepEqual(taskOutputMaintenanceOptions(["--inspect"]), { mode: "inspect", limit: 25 });
});
for (const args of [["--apply", "--dry-run"], ["--apply", "--apply"], ["--wat"], ["--inspect", "--limit", "1"],
  ["--limit"], ["--limit", "0"], ["--limit", "101"], ["--limit", "1e2"], ["--limit", "01"],
  ["--limit", "1", "--limit", "2"], ["--limit=1"]]) {
  test(`invalid maintenance arguments fail closed: ${args.join(" ")}`, () => {
    assert.throws(() => taskOutputMaintenanceOptions(args));
  });
}
test("maintenance requires an explicit lowercase physical database fingerprint", () => {
  assert.equal(taskOutputMaintenanceFingerprint("a".repeat(64)), "a".repeat(64));
  for (const value of [undefined, null, "", "A".repeat(64), "a".repeat(63), "supacloud_meta", "a".repeat(64) + "\n"]) {
    assert.throws(() => taskOutputMaintenanceFingerprint(value));
  }
});
test("project rate limit has a safe response and conservative retry guidance", async () => {
  const response = taskOutputFailure(new TaskOutputError(429, "TASK_OUTPUT_PROJECT_RATE_LIMIT", "Project output rate limit exceeded"));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).code, "TASK_OUTPUT_PROJECT_RATE_LIMIT");
});
test("storage saturation does not pretend a timed retry will free storage", () => {
  const response = taskOutputFailure(new TaskOutputError(413, "TASK_OUTPUT_PROJECT_STORAGE_LIMIT", "Project retained output limit exceeded"));
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("retry-after"), null);
});
test("unknown database errors remain sanitized and unavailable", async () => {
  const response = taskOutputFailure(new Error("postgres://secret@internal.private"));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("secret"), false);
});
