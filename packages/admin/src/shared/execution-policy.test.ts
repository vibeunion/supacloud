import { describe, expect, test } from "bun:test";
import { stringEnum } from "./schema";
import { authorizeExecution, executionMode, validateExecutionPolicyCoverage } from "./execution-policy";
import type { ResolvedContext } from "./context";

function productionContext(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
    return {
        host: "production.example.com",
        sshUser: "root",
        sshPort: 2201,
        sshKey: "",
        sshPass: "",
        sshHostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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

describe("Admin execution policy", () => {
    test("classifies the complete registered action catalog", () => {
        const expectedModes = {
            read: [
                "project.list", "project.get", "project.settings", "project.api_keys",
                "project.health", "project.logs", "project.tasks", "project.services",
                "project.runtime_snapshot",
                "platform.metrics", "platform.list_backups", "platform.list_logical_backups", "platform.network",
                "platform.list_orgs", "platform.get_org",
                "gateway.routes", "gateway.get_certificate", "gateway.custom_hostname",
                "frontend.list_releases", "frontend.get_release",
                "ssh.ping", "ssh.versions", "ssh.diagnose", "ssh.exec",
                "ssh.troubleshoot", "ssh.container_logs", "ssh.tenant_list",
                "ssh.tenant_inspect", "ssh.tenant_diagnose", "ssh.upgrade_status",
            ],
            write: [
                "project.create", "project.delete", "project.pause", "project.restore",
                "project.restart", "project.update_settings",
                "platform.create_backup", "platform.create_logical_backup",
                "platform.restore_logical_backup", "platform.update_network",
                "gateway.upsert_route", "gateway.update_route", "gateway.delete_route",
                "gateway.config", "gateway.update_certificate", "gateway.issue_certificate",
                "gateway.deploy_certificate", "gateway.rebuild", "gateway.set_custom_hostname",
                "gateway.delete_custom_hostname", "gateway.verify_custom_hostname",
                "frontend.upload_release", "frontend.activate_release",
                "ssh.setup", "ssh.install", "ssh.upgrade", "ssh.tenant_migrate",
            ],
        } as const;

        for (const mode of ["read", "write"] as const) {
            for (const qualifiedAction of expectedModes[mode]) {
                const [moduleName, action] = qualifiedAction.split(".");
                expect(executionMode(moduleName, action, {})).toBe(mode);
            }
        }
    });

    test("classifies conditional service status as read and lifecycle changes as write", () => {
        expect(executionMode("project", "service_control", { service_action: "status" })).toBe("read");
        expect(executionMode("project", "service_control", { service_action: "restart" })).toBe("write");
        expect(executionMode("ssh", "tenant_manage", { tenant_action: "status" })).toBe("read");
        expect(executionMode("ssh", "tenant_manage", { tenant_action: "stop" })).toBe("write");
    });

    test("blocks every classified remote write in read-only mode", () => {
        expect(() => authorizeExecution("gateway", {
            action: "rebuild",
            ref: "test-ref",
        }, {
            context: productionContext({
                environment: "test",
                production: false,
                readOnly: true,
                projectRef: "test-ref",
            }),
        })).toThrow("SUPACLOUD_READ_ONLY=true");
    });

    test("blocks unclassified remote writes while allowing reads", () => {
        const unclassifiedContext = productionContext({
            environment: "",
            production: false,
        });
        expect(() => authorizeExecution("project", {
            action: "delete",
            ref: "prod-ref",
        }, {
            context: unclassifiedContext,
        })).toThrow("requires an explicit SUPACLOUD_ENV");
        expect(() => authorizeExecution("project", {
            action: "get",
            ref: "prod-ref",
        }, {
            context: unclassifiedContext,
        })).not.toThrow();
    });

    test("requires exact production confirmation for project writes", () => {
        const args = { action: "delete", ref: "prod-ref" };
        expect(() => authorizeExecution("project", args, {
            context: productionContext(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("project", args, {
            context: productionContext(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
    });

    test.each(["create_logical_backup", "restore_logical_backup"])(
        "requires exact production project confirmation for platform.%s",
        (action) => {
            const args = { action, ref: "prod-ref" };
            expect(() => authorizeExecution("platform", args, {
                context: productionContext(),
            })).toThrow("--confirm-production prod-ref");
            expect(() => authorizeExecution("platform", args, {
                context: productionContext(),
                confirmProduction: "prod-ref",
            })).not.toThrow();
        },
    );

    test("classifies verified logical inventory as a production read", () => {
        expect(() => authorizeExecution("platform", {
            action: "list_logical_backups",
            ref: "prod-ref",
        }, {
            context: productionContext(),
        })).not.toThrow();
    });

    test("requires the exact production project ref for frontend release writes", () => {
        const args = {
            action: "activate_release",
            ref: "prod-ref",
            id: "web",
            release_id: "a".repeat(64),
        };
        expect(() => authorizeExecution("frontend", args, {
            context: productionContext(),
        })).toThrow("--confirm-production prod-ref");
        expect(() => authorizeExecution("frontend", args, {
            context: productionContext(),
            confirmProduction: "prod-ref",
        })).not.toThrow();
        expect(() => authorizeExecution("frontend", { ...args, ref: "other-ref" }, {
            context: productionContext(),
            confirmProduction: "other-ref",
        })).toThrow("different project ref");
    });

    test("rejects cross-project production reads and writes", () => {
        expect(() => authorizeExecution("project", {
            action: "get",
            ref: "other-ref",
        }, {
            context: productionContext(),
        })).toThrow("different project ref");
        expect(() => authorizeExecution("gateway", {
            action: "rebuild",
            ref: "other-ref",
        }, {
            context: productionContext(),
            confirmProduction: "other-ref",
        })).toThrow("different project ref");
    });

    test("binds ref-less production writes to exact API and SSH targets", () => {
        expect(() => authorizeExecution("project", { action: "create" }, {
            context: productionContext({ projectRef: "" }),
        })).toThrow("--confirm-production platform:management.example.com");
        expect(() => authorizeExecution("project", { action: "create" }, {
            context: productionContext({ projectRef: "" }),
            confirmProduction: "platform:management.example.com",
        })).not.toThrow();

        expect(() => authorizeExecution("ssh", { action: "upgrade" }, {
            context: productionContext({ projectRef: "" }),
        })).toThrow("--confirm-production host:production.example.com:2201");
        expect(() => authorizeExecution("ssh", { action: "upgrade" }, {
            context: productionContext({ projectRef: "" }),
            confirmProduction: "host:production.example.com:2201",
        })).not.toThrow();
    });

    test("ignores irrelevant ref flags when deriving platform and host confirmation targets", () => {
        expect(() => authorizeExecution("project", {
            action: "create",
            ref: "prod-ref",
        }, {
            context: productionContext(),
            confirmProduction: "prod-ref",
        })).toThrow("--confirm-production platform:management.example.com");
        expect(() => authorizeExecution("ssh", {
            action: "upgrade",
            project_ref: "prod-ref",
        }, {
            context: productionContext(),
            confirmProduction: "prod-ref",
        })).toThrow("--confirm-production host:production.example.com:2201");
    });

    test("does not substitute a platform target for a missing required project ref", () => {
        expect(() => authorizeExecution("platform", { action: "create_backup" }, {
            context: productionContext({ projectRef: "" }),
            confirmProduction: "platform:management.example.com",
        })).toThrow("requires --ref");
        expect(() => authorizeExecution("ssh", {
            action: "tenant_migrate",
            source_ref: "source-ref",
        }, {
            context: productionContext({ projectRef: "" }),
            confirmProduction: "host:production.example.com:2201",
        })).toThrow("requires --target_ref");
    });

    test("fails closed for unknown actions in production or read-only profiles", () => {
        expect(() => authorizeExecution("project", { action: "future_action" }, {
            context: productionContext(),
        })).toThrow("no classification");
        expect(() => authorizeExecution("project", { action: "future_action" }, {
            context: productionContext({ production: false, environment: "test", readOnly: true }),
        })).toThrow("no classification");
        expect(() => authorizeExecution("project", { action: "future_action" }, {
            context: productionContext({ production: false, environment: "test" }),
        })).not.toThrow();
    });

    test("detects top-level and conditional action catalog drift", () => {
        expect(() => validateExecutionPolicyCoverage({
            project: { schema: { action: {} as never } },
        })).toThrow("cannot inspect project.action");
        expect(() => validateExecutionPolicyCoverage({
            project: { schema: { action: stringEnum(["list", "future_action"]) } },
        })).toThrow("project.future_action");
        expect(() => validateExecutionPolicyCoverage({
            project: {
                schema: {
                    action: stringEnum(["service_control"]),
                    service_action: stringEnum(["status", "future_action"]),
                },
            },
        })).toThrow("project.service_control.future_action");
    });
});
