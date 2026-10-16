import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderStarterTaskRecoverySchema } from "./app-starter-task-provisioning";
import { STARTER_TASK_SCHEMA } from "./app-starter-tasks";

// The renderer must not rewrite historical migrations or broaden recovery grants.
test("default task provisioning preserves the exact new migration", () => {
  assert.equal(renderStarterTaskRecoverySchema("starter_review_http", "starter_review_worker"), STARTER_TASK_SCHEMA);
});

test("task provisioning scopes only backend grants and preserves browser revocation", () => {
  const sql = renderStarterTaskRecoverySchema("owned_http", "owned_worker");
  assert.match(sql, /GRANT SELECT,INSERT ON public\.starter_attachment_retries TO owned_http;/);
  assert.match(sql, /GRANT SELECT ON public\.starter_attachment_retries TO owned_worker;/);
  assert.match(sql, /snapshot\(uuid,boolean\) TO owned_http;/);
  assert.match(sql, /REVOKE ALL ON public\.starter_attachment_retries FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(sql, /\bstarter_review_(http|worker)\b/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE|ALL)/);
  assert.equal(sql.replace(/\bowned_http\b/g, "starter_review_http").replace(/\bowned_worker\b/g, "starter_review_worker"), STARTER_TASK_SCHEMA);
});

test("role substitution is nonrecursive and supports the PostgreSQL identifier boundary", () => {
  const http = "starter_review_worker_http", worker = "w".repeat(63);
  const sql = renderStarterTaskRecoverySchema(http, worker);
  assert.ok(sql.includes("TO " + http + ";"));
  assert.ok(sql.includes("TO " + worker + ";"));
  assert.ok(!sql.includes(worker + "_http"));
});

for (const [http, worker] of [
  ["same", "same"], ["http;drop", "worker"], ["HTTP", "worker"], ["1http", "worker"],
  ["h".repeat(64), "worker"], ["", "worker"], ["http", 'worker"'], ["http", "worker "],
]) {
  test(`task provisioning rejects unsafe or colliding roles ${JSON.stringify([http, worker])}`, () => {
    assert.throws(() => renderStarterTaskRecoverySchema(http!, worker!), /Distinct PostgreSQL runtime role names required/);
  });
}

test("delivery fixtures provision and archive all five starter migrations", () => {
  const read = (path: string) => readFileSync(new URL("../../../../../scripts/" + path, import.meta.url), "utf8");
  const roles = read("fixtures/starter-runtime-roles.fixture");
  assert.ok(roles.indexOf("004-review-runtime-roles.sql") < roles.indexOf("005-review-task-recovery.sql"));
  assert.ok(roles.indexOf("005-review-task-recovery.sql") < roles.indexOf("CREATE ROLE starter_http_login"));
  const builder = read("build-platform-business-acceptance.ts");
  assert.match(builder, /migrations\/005-review-task-recovery\.sql/);
  assert.match(builder, /renderStarterTaskRecoverySchema\(`\$\{rolePrefix\}_http`, `\$\{rolePrefix\}_worker`\)/);
  for (const file of ["starter-review-delivery.fixture", "starter-attachment-worker-delivery.fixture"]) {
    const source = read("fixtures/" + file);
    assert.ok(source.includes('file.path.startsWith("bundle/migrations/")).length, 5'));
    assert.ok(source.includes('file.path.startsWith("bundle/migrations/operator-provisioning/")).length, 3'));
  }
});
