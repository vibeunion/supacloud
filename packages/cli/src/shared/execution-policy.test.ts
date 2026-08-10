import { describe, expect, test } from "bun:test";
import { stringEnum } from "./schema";
import { authorizeExecution, executionMode, validateExecutionPolicyCoverage } from "./execution-policy";
import type { ResolvedContext } from "./context";

function context(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
    return {
        host: "management.example.com",
        sshUser: "root",
        sshPort: 22,
        sshKey: "",
        sshPass: "",
        apiUrl: "https://management.example.com",
        apiToken: "secret-token",
        projectRef: "prod-ref",
        readOnly: false,
        environment: "production",
        production: true,
        inferredSupabaseUrl: "",
        inferredServiceRoleKey: "",
        source: "process_env",
        sourcePath: null,
        ...overrides,
    };
}

describe("CLI execution policy", () => {
    test("requires an exact production confirmation for remote writes", () => {
        expect(() => authorizeExecution("project", { action: "task_cancel" }, { context: context() }))
            .toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("project", { action: "task_cancel" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
    });

    test("rejects cross-project production overrides even when confirmed", () => {
        expect(() => authorizeExecution("queue", { action: "send", ref: "other-ref" }, {
            context: context(),
            confirmProduction: "other-ref",
        })).toThrow("cannot target a different project");
    });

    test("blocks every classified remote write in read-only mode", () => {
        expect(() => authorizeExecution("frontend", { action: "redeploy" }, {
            context: context({ production: false, environment: "test", readOnly: true }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
    });

    test("allows migration previews and local authoring without production confirmation", () => {
        expect(executionMode("database", "push_migrations", { dry_run: true })).toBe("read");
        expect(executionMode("supabase", "push", { dry_run: true })).toBe("read");
        expect(() => authorizeExecution("supabase", { action: "db_dump" }, { context: context() }))
            .not.toThrow();
    });

    test("always rejects diagnostics repair in production", () => {
        expect(() => authorizeExecution("diagnostics", { action: "repair" }, {
            context: context(),
            confirmProduction: "prod-ref",
        })).toThrow("forbidden in production");
    });

    test("fails closed for unknown production actions", () => {
        expect(() => authorizeExecution("queue", { action: "future_mutation" }, { context: context() }))
            .toThrow("no classification");
    });

    test("detects registered action catalog drift", () => {
        expect(() => validateExecutionPolicyCoverage({
            project: { schema: { action: stringEnum(["get", "future_mutation"]) } },
        })).toThrow("project.future_mutation");
        expect(() => validateExecutionPolicyCoverage({
            project: { schema: { action: stringEnum(["get", "task_cancel"]) } },
        })).not.toThrow();
    });
});
