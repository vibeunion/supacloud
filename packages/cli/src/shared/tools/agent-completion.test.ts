import { expect, test } from "bun:test";
import { databaseCheckCompletion } from "./agent-completion";

test("a skipped catalog reconcile is not agent completion", () => {
    expect(databaseCheckCompletion({
        ok: true,
        checks: [{ name: "catalog", skipped: true }],
    })).toEqual({
        done: false,
        rls_checks: "skipped",
        skipped_is_done: false,
        reason: "The catalog reconcile, including rls-disabled, did not run",
    });
});

test("a failed catalog reconcile ran and is not done", () => {
    expect(databaseCheckCompletion({
        ok: false,
        checks: [{ name: "catalog", ok: false }],
    })).toMatchObject({ done: false, rls_checks: "ran", skipped_is_done: false });
});

test("a passing catalog reconcile is done only when the report passed", () => {
    expect(databaseCheckCompletion({
        ok: true,
        checks: [{ name: "module-lint", ok: true }, { name: "catalog", ok: true }],
    })).toEqual({ done: true, rls_checks: "ran", skipped_is_done: false });
    expect(databaseCheckCompletion({
        ok: false,
        checks: [{ name: "module-lint", ok: false }, { name: "catalog", ok: true }],
    }).done).toBe(false);
});
