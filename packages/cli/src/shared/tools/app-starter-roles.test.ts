import { expect, test } from "bun:test";
import { renderStarterRuntimeRolesSchema, STARTER_RUNTIME_ROLES_SCHEMA } from "./app-starter-roles";

test("scoped roles retain the starter privilege and policy template", () => {
  expect(renderStarterRuntimeRolesSchema("starter_review_http", "starter_review_worker"))
    .toBe(STARTER_RUNTIME_ROLES_SCHEMA);
  const sql = renderStarterRuntimeRolesSchema("project_a_http", "project_a_worker");
  expect(sql).toContain("CREATE ROLE project_a_http NOLOGIN NOSUPERUSER");
  expect(sql).toContain("TO project_a_worker USING (true) WITH CHECK (false)");
  expect(sql).not.toContain("starter_review_http");
  expect(sql).not.toContain("starter_review_worker");
});

test("role identifiers reject collisions, SQL injection and PostgreSQL truncation", () => {
  for (const name of ["", "same", "x;DROP ROLE postgres", "a".repeat(64), "quoted\"name", "Role"]) {
    expect(() => renderStarterRuntimeRolesSchema(name, "same")).toThrow();
  }
});
