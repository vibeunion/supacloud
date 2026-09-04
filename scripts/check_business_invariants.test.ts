import { describe, expect, test } from "bun:test";
import { checkBusinessInvariants, extractCreateTables } from "./check_business_invariants";

describe("business invariant check", () => {
  test("extracts nested CHECK expressions from CREATE TABLE", () => {
    const [table] = extractCreateTables(
      `CREATE TABLE public.jobs (id uuid PRIMARY KEY, status text NOT NULL CHECK (status IN ('queued', 'done')), payload jsonb);`,
      "001_jobs.sql",
    );
    expect(table?.name).toBe("public.jobs");
    expect(table?.body).toContain("status IN");
  });

  test("accepts a constrained RLS table", () => {
    const issues = checkBusinessInvariants([{
      path: "001_jobs.sql",
      sql: `CREATE TABLE public.jobs (id uuid PRIMARY KEY, user_id uuid REFERENCES public.profiles(id), status text CHECK (status IN ('queued', 'done'))); ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;`,
    }]);
    expect(issues).toEqual([]);
  });

  test("reports missing primary key, RLS, status check, and user foreign key", () => {
    const issues = checkBusinessInvariants([{
      path: "001_jobs.sql",
      sql: "CREATE TABLE public.jobs (user_id uuid, status text);",
    }]);
    expect(issues.map((issue) => issue.code)).toEqual([
      "table-missing-primary-key",
      "table-missing-rls",
      "status-missing-check",
      "user-id-missing-foreign-key",
    ]);
  });

  test("reports duplicate migration versions", () => {
    const issues = checkBusinessInvariants([
      { path: "001_one.sql", sql: "" },
      { path: "001_two.sql", sql: "" },
    ]);
    expect(issues.map((issue) => issue.code)).toContain("migration-version-duplicate");
  });
});
