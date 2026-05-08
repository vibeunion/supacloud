import * as p from "@clack/prompts";
import { HealthChecker, type HealthReport } from "./infra/health";
import { config } from "./config";
import os from "node:os";

function getSpinner() {
    const s = p.spinner();
    const isCI = config.isGithubActions || !process.stdout.isTTY;
    if (isCI) {
        return {
            start: (msg: string) => console.log(`[CI] ${msg}...`),
            stop: (msg: string) => console.log(`[CI] ✅ ${msg}`),
            message: (msg: string) => console.log(`[CI] ${msg}`)
        };
    }
    return s;
}

export async function runDoctor(options: { skipSmokeTest?: boolean, forceYes?: boolean } = {}) {
    p.intro("\x1b[45m SupaCloud System Health Check Center (Doctor) \x1b[0m");

    const s = getSpinner();
    s.start("Deep scanning infrastructure status...");

    try {
        const reports = await HealthChecker.runFullCheck();
        s.stop("Infrastructure scan completed");

        const tableData = reports.map(r => {
            const statusIcon = r.status === "OK" ? "✅" : r.status === "WARN" ? "⚠️" : "❌";
            return `${statusIcon} [${r.component.padEnd(12)}] ${r.message}`;
        });

        p.note(tableData.join("\n"), "System Health Report");

        const hasError = reports.some(r => r.status === "ERROR");
        if (hasError) {
            p.log.error("Critical service errors detected, basic functionality tests skipped.");
            const issues = reports.filter(r => r.status !== "OK");
            issues.forEach(r => {
                p.log.step(`- \x1b[33m${r.component}\x1b[0m: ${r.recommendation || "Please check logs."}`);
            });
            p.outro("Health check complete. Please fix the red errors above first.");
            return;
        }

        // --- Smoke test entry ---
        if (!options.skipSmokeTest) {
            const shouldTest = options.forceYes || await p.confirm({
                message: "Infrastructure seems ready. Run business smoke test (create and destroy a test project)?",
                initialValue: true
            });

            if (p.isCancel(shouldTest) || !shouldTest) {
                p.outro("Basic checks passed, business functionality pending verification. Enjoy!");
                return;
            }

            s.start("Running business smoke test (creating project)...");
            const testRef = `smoke-test-${Math.random().toString(36).substring(7)}`;

            try {
                const { projectService } = await import("./services");

                // 1. Create project
                const project = await projectService.createProject({
                    name: "Doctor Smoke Test Project",
                    organization_id: "default"
                });
                s.message(`Project injected successfully (Ref: ${project.ref}), waiting for gateway to take effect...`);

                // Simulate waiting for gateway ready (Kong usually needs a few seconds to sync)
                await new Promise(r => setTimeout(r, 2000));

                // 2. Verify details retrieval
                const details = await projectService.getProject(project.ref);
                if (!details) throw new Error("Unable to get test project details, persistence error.");

                s.message("Function verification passed, cleaning up test data...");

                // 3. Cleanup
                await projectService.deleteProject(project.ref);

                s.stop("Business smoke test full chain passed! ✨");
                p.log.success("[Conclusion] Your SupaCloud is fully ready for production.");
            } catch (testErr: unknown) {
                s.stop("Business smoke test failed");
                p.log.error(`Smoke test found logic error: ${testErr instanceof Error ? testErr.message : String(testErr)}`);
                p.log.info("This may indicate database permissions or routing script issues.");
            }
        }

        p.outro("Health check complete, happy deployment!");
    } catch (error: unknown) {
        s.stop("Health check failed midway");
        p.log.error(`Health check tool crashed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
