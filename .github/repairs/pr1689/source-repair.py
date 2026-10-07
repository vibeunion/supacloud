"""Apply an audited, SHA-bound review patch. No repository code is executed here."""
from pathlib import Path
import json
import subprocess

SOURCE = "760ee481080e06302f30b3d58029e0a7c4632eed"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == SOURCE
assets = Path(__file__).resolve().parent / "files"
changed = set()

def save(path, text):
    target = Path(path)
    assert not target.is_symlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    changed.add(path)

def edit(path, old, new, count=1):
    text = Path(path).read_text(encoding="utf-8")
    assert text.count(old) == count, (path, old, text.count(old))
    save(path, text.replace(old, new))

sql_path = "packages/management-api/src/db/sql-modules/pgmq-public.sql"
edit(sql_path, "  msg_id bigint NOT NULL,\n  created_at", "  msg_id bigint NOT NULL,\n  message jsonb NOT NULL,\n  sleep_seconds integer NOT NULL,\n  created_at")
edit(sql_path, "REVOKE ALL ON TABLE supacloud_queue.job_keys FROM PUBLIC, anon, authenticated, service_role;", """-- Upgrade early key-only installations without inventing an input identity.
ALTER TABLE supacloud_queue.job_keys ADD COLUMN IF NOT EXISTS message jsonb;
ALTER TABLE supacloud_queue.job_keys ADD COLUMN IF NOT EXISTS sleep_seconds integer;
REVOKE ALL ON SCHEMA supacloud_queue FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE supacloud_queue.job_keys FROM PUBLIC, anon, authenticated, service_role;""")
text = Path(sql_path).read_text()
start = text.index("-- Additive SupaCloud extension;")
end = text.index("CREATE OR REPLACE FUNCTION pgmq_public.read(", start)
text = text[:start] + (assets / "send-idempotent.sql").read_text() + text[end:]
save(sql_path, text)
for target in ["packages/management-api/src/db/schemas/supabase.sql", "packages/supacloud-lite/src/runtime/db/emulated.ts"]:
    source = Path(target).read_text()
    start_marker = "-- supacloud:sql-module:pgmq-public:start"
    end_marker = "-- supacloud:sql-module:pgmq-public:end"
    assert source.count(start_marker) == source.count(end_marker) == 1
    start = source.index(start_marker)
    end = source.index(end_marker) + len(end_marker)
    save(target, source[:start] + start_marker + "\n" + text.strip() + "\n" + end_marker + source[end:])

sdk = "packages/supacloud-js/src/index.ts"
edit(sdk, "type SupaCloudQueueSendResult,", "type SupaCloudQueueSendResult, type SupaCloudQueueIdempotentSendResult,", 2)
text = Path(sdk).read_text()
start = text.index("  async sendIdempotent(")
end = text.index("  async sendBatch(", start)
block = text[start:end]
assert block.count("Promise<SupaCloudQueueSendResult>") == 1
block = block.replace("Promise<SupaCloudQueueSendResult>", "Promise<SupaCloudQueueIdempotentSendResult>")
block = block.replace('typeof jobKey !== "string" ||', 'typeof jobKey !== "string" || jobKey.trim() !== jobKey ||')
block = block.replace('!value[0] || typeof value[0] !== "object"', '!value[0] || Array.isArray(value[0]) || typeof value[0] !== "object"')
block = block.replace('      const row = value[0] as Record<string, unknown>;\n', '      const row = value[0] as Record<string, unknown>;\n      if (typeof row.created !== "boolean") throw new SupaCloudQueueError();\n')
assert block.count('status: "pending"') == 1
block = block.replace('status: "pending"', 'status: result.created ? "pending" : "deduplicated"')
save(sdk, text[:start] + block + text[end:])
queue_rpc = "packages/supacloud-js/src/queue-rpc.ts"
edit(queue_rpc, "  deduplicated?: boolean;\n", "")
edit(queue_rpc, "export type SupaCloudQueueMutationResult = {", """/** Deduplication confirms the original enqueue, not current pending/execution state. */
export type SupaCloudQueueIdempotentSendResult = Omit<SupaCloudQueueSendResult, "status"> & {
  status: "pending" | "deduplicated";
  deduplicated: boolean;
};
export type SupaCloudQueueMutationResult = {""")

worker = "packages/worker/src/index.ts"
edit(worker, "/** Forces one in-flight message for this named queue. */", "/** One in-flight message per worker instance; not a distributed queue lock. */", 2)
edit(worker, "  const maxConcurrent = integer(options.concurrency, 4, 1, 32);", """  if (options.serial !== undefined && typeof options.serial !== "boolean") throw new Error("WORKER_SERIAL_CONFIG_INVALID");
  const maxConcurrent = integer(options.concurrency, options.serial === true ? 1 : 4, 1, 32);""")
edit(worker, """  const policy = normalizeJobPolicy({
    ...options.policy,
    ...(options.retryLimit === undefined ? {} : { maxAttempts: options.retryLimit }),
  });""", """  const configuredPolicy = normalizeJobPolicy(options.policy);
  const legacyRetries = options.retryLimit === undefined ? undefined : integer(options.retryLimit, 5, 0, 10);
  if (legacyRetries !== undefined && options.policy?.maxRetries !== undefined && legacyRetries !== configuredPolicy.maxRetries) {
    throw new Error("WORKER_RETRY_POLICY_INVALID");
  }
  const policy = normalizeJobPolicy({ ...configuredPolicy, maxRetries: legacyRetries ?? configuredPolicy.maxRetries });""")
edit(worker, "    maxConcurrent: options.serial ? 1 : integer(options.concurrency, 4, 1, 32),\n    batchSize: options.serial ? 1 : integer(options.concurrency, 4, 1, 32),\n", "")
edit(worker, "limit: policy.maxAttempts,", "limit: policy.maxRetries,")
old_test = "packages/worker/src/job-policy.test.ts"
edit(old_test, "maxAttempts", "maxRetries", 2)
edit(old_test, 'import { createPgmqWakeup } from "./wakeup.js";', 'import { createPgmqWakeup, pgmqWakeupChannel } from "./wakeup.js";')
edit(old_test, '      "supacloud_pgmq_scw_reports:report:42",\n      "wait:supacloud_pgmq_scw_reports",', '      `${pgmqWakeupChannel("scw_reports")}:report:42`,\n      `wait:${pgmqWakeupChannel("scw_reports")}`,')
worker_test = "packages/worker/tests/worker.test.ts"
edit(worker_test, '    expect(createPgflowQueueWorker({ ...options, serial: true, concurrency: 1 }, handler).state).toBe("idle");', '''    expect(createPgflowQueueWorker({ ...options, serial: true, concurrency: 1 }, handler).state).toBe("idle");
    expect(createPgflowQueueWorker({ ...options, serial: true, concurrency: undefined }, handler).state).toBe("idle");
    expect(() => createPgflowQueueWorker({ ...options, serial: "true" as never }, handler)).toThrow("WORKER_SERIAL_CONFIG_INVALID");
    expect(() => createPgflowQueueWorker({ ...options, retryLimit: 11 }, handler)).toThrow("WORKER_CONFIG_INVALID");
    expect(() => createPgflowQueueWorker({ ...options, retryLimit: 2, policy: { maxRetries: 3 } }, handler)).toThrow("WORKER_RETRY_POLICY_INVALID");''')
edit(worker_test, '        ).toThrow("WORKER_CONFIG_INVALID");', '      ).toThrow("WORKER_CONFIG_INVALID");')
telemetry = "packages/worker/src/telemetry.ts"
text = Path(telemetry).read_text()
start = text.index("export interface QueueJobMetrics {")
end = text.index("/** Loopback-only operational endpoint;", start)
save(telemetry, text[:start] + 'export { createQueueJobMetrics, type QueueJobMetrics } from "./job-metrics.js";\n\n' + text[end:])
manifest = "packages/worker/package.json"
edit(manifest, '"test": "bun test tests/worker.test.ts"', '"test": "bun test tests/worker.test.ts src/job-policy.test.ts src/job-policy-boundaries.test.ts"')
readme = "packages/worker/README.md"
text = Path(readme).read_text()
start = text.index("The adapter also exposes small policy primitives")
end = text.index("```ts", start)
save(readme, text[:start] + """The adapter exposes policy primitives on the existing PGMQ/Workflow boundary:

- SDK `sendIdempotent` adds `pgmq_public.send_idempotent`. It binds a tenant-local
  `(queue_name, job_key)` to the original JSON input and delay in the enqueue
  transaction. Reusing a key with different input/delay fails. A deduplicated
  receipt does not claim the old job is still pending or completed. Keys and
  their input identity survive archive/delete and require an explicit, reviewed
  administrator retention policy; no automatic cleanup or exactly-once business
  execution is implied. Existing key-only records fail closed rather than invent
  input identity. Official PGMQ RPC contracts are unchanged.
- `serial: true` defaults concurrency and batch size to one **per process**. An
  explicit conflicting concurrency is rejected. This is not a cross-process
  mutex and does not serialize replicas or expired visibility leases.
- `normalizeJobPolicy` uses `maxRetries` (retries after the first attempt, matching
  pgflow); the existing `retryLimit` remains supported with its previous bounds.
  `priority` is handler metadata, not priority dequeue ordering.
- `runTaskListOnce` is a finite local fixture runner, not a database queue drain.
  It reuses the worker's authorization, cancellation and error-redaction boundary.
- `createPgmqWakeup` creates bounded hashed notification channels. The transport
  owns LISTEN registration/connection cleanup; notifications are advisory and
  require polling/reconciliation. Notify only after enqueue commit, register the
  listener before checking for queued work, and never put secrets in a notification.
- `backfillOccurrences` calculates bounded fixed-interval occurrences from an
  explicit `anchor` (Unix epoch by default), so overlapping polling windows retain
  the same scheduled keys. It is not a cron scheduler or timezone/DST engine.
- `createQueueJobMetrics` is explicit instrumentation, not automatically collected
  queue telemetry. Supply `observePending(oldestTimestamp)` from an authoritative
  queue query, or `null` for an empty queue. The age gauge is absent until observed;
  completion counters alone cannot determine the oldest pending message.

""" + text[end:])

mapping = {
    "job-policy.ts": "packages/worker/src/job-policy.ts",
    "wakeup.ts": "packages/worker/src/wakeup.ts",
    "schedule.ts": "packages/worker/src/schedule.ts",
    "task-list-once.ts": "packages/worker/src/task-list-once.ts",
    "job-metrics.ts": "packages/worker/src/job-metrics.ts",
    "job-policy-boundaries.test.ts": "packages/worker/src/job-policy-boundaries.test.ts",
    "queue-idempotency.test.ts": "packages/supacloud-js/src/queue-idempotency.test.ts",
    "pgmq-rpc-idempotency.test.ts": "packages/management-api/tests/unit/pgmq-rpc-idempotency.test.ts",
    "pgmq-idempotency.test.ts": "packages/supacloud-lite/src/runtime/db/pgmq-idempotency.test.ts",
    "worker-queue-controls.yml": ".github/workflows/worker-queue-controls.yml",
}
for name, path in mapping.items():
    save(path, (assets / name).read_text())
assert len(changed) == 21, sorted(changed)
subprocess.run(["git", "diff", "--check"], check=True)
subprocess.run(["git", "add", "--", *sorted(changed)], check=True)
actual = set(subprocess.check_output(["git", "diff", "--cached", "--name-only"], text=True).splitlines())
assert actual == changed, (actual, changed)
print(json.dumps({"source": SOURCE, "paths": sorted(changed)}, indent=2))
