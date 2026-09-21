import type { AuthExecutionPolicy } from "./auth-execution-policy";
import type { GotrueRuntimeController, GotrueRuntimeStatus } from "./tenant-runtime.service";

export interface AuthRuntimeApplyOperations {
    readPolicy(): Promise<AuthExecutionPolicy>;
    ensureBinary(): Promise<void>;
    installTemplate(): Promise<void>;
    getPorts(): Promise<{ postgrest: number; gotrue: number }>;
    generateConfig(ports: { postgrest: number; gotrue: number }): Promise<void>;
    ensureAuthSchema(): Promise<void>;
    controller: Pick<GotrueRuntimeController,
        "unit" | "stopAndDisable" | "observe" | "isActive" | "isFailed" | "resetFailed"
        | "restart" | "enable" | "start" | "waitForHealthy">;
}

export async function applyAuthRuntime(
    ref: string,
    operations: AuthRuntimeApplyOperations,
): Promise<GotrueRuntimeStatus> {
    const policy = await operations.readPolicy();
    if (policy.mode === "shared") {
        throw new Error(`Auth configuration for ${ref} is managed by ${policy.authorityRef}`);
    }

    if (policy.mode === "external") {
        await operations.controller.stopAndDisable(ref);
        const ports = await operations.getPorts();
        await operations.generateConfig(ports);
        const current = await operations.readPolicy();
        if (current.mode !== "external" || current.upstream !== policy.upstream) {
            throw new Error(`Auth execution policy changed while applying configuration for ${ref}`);
        }
        const observed = await operations.controller.observe(ref, ports.gotrue);
        return {
            component: "gotrue",
            desired: "stopped",
            actual: observed.actual,
            port: ports.gotrue,
            unit: operations.controller.unit(ref),
            health: observed.health,
            last_error: observed.last_error,
            updated_at: null,
            last_reconciled_at: null,
        };
    }

    await operations.ensureBinary();
    await operations.installTemplate();
    const ports = await operations.getPorts();
    await operations.generateConfig(ports);
    const active = await operations.controller.isActive(ref);
    if (await operations.controller.isFailed(ref)) {
        await operations.controller.resetFailed(ref);
    }
    if (active) {
        await operations.controller.restart(ref);
    } else {
        await operations.ensureAuthSchema();
        await operations.controller.enable(ref);
        await operations.controller.start(ref);
    }
    const status = await operations.controller.waitForHealthy(ref, ports.gotrue, 20, 500);
    if (status.health !== "healthy") {
        throw new Error(status.last_error || `GoTrue runtime did not become healthy after applying auth config for ${ref}`);
    }
    return status;
}
