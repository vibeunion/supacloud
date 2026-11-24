export interface DatabaseCheckCompletion {
    done: boolean;
    rls_checks: "ran" | "skipped";
    skipped_is_done: false;
    reason?: string;
}

interface DatabaseCheckReport {
    ok: boolean;
    checks: ReadonlyArray<{ name: string; skipped?: boolean; ok?: boolean }>;
}

/** Catalog reconcile is the existing RLS check. Skipping it is not agent completion. */
export function databaseCheckCompletion(report: DatabaseCheckReport): DatabaseCheckCompletion {
    const catalog = report.checks.find((check) => check.name === "catalog");
    if (!catalog || catalog.skipped === true) {
        return {
            done: false,
            rls_checks: "skipped",
            skipped_is_done: false,
            reason: "The catalog reconcile, including rls-disabled, did not run",
        };
    }
    if (!report.ok || catalog.ok !== true) {
        return {
            done: false,
            rls_checks: "ran",
            skipped_is_done: false,
            reason: "The catalog reconcile reported an error",
        };
    }
    return { done: true, rls_checks: "ran", skipped_is_done: false };
}
