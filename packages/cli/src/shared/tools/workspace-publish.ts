import { resolve } from "node:path";
import type { ResolvedContext } from "../context";
import type { ToolResult } from "../tool-server";
import type { HttpTransport } from "../transports/http";
import { publishWorkspaceFrontend } from "./deploy-tools";
import {
    collectGitChanges, createWorkspacePlan, readWorkspaceHead, workspaceCheckoutClean,
    WORKSPACE_CONFIG_FILE, workspaceTracksFile,
} from "./workspace-plan";

function reject(message: string): ToolResult {
    return { isError: true, content: [{ type: "text", text: message }] };
}

export async function runWorkspacePublish(
    args: Record<string, unknown>,
    cwd: string,
    http: HttpTransport | null,
    context?: Pick<ResolvedContext, "projectRef" | "environment" | "environmentVariables">,
): Promise<ToolResult> {
    if (args.execute !== true) return reject("Pass --execute to publish a static frontend.");
    if (typeof args.application !== "string" || !args.application) return reject("workspace publish requires --application");
    if (typeof args.base !== "string" || args.changed !== undefined || args.head !== undefined) {
        return reject("workspace publish requires --base and compares it with HEAD; --changed and --head are not supported.");
    }
    const environment = args.environment;
    if (typeof environment !== "string" || !environment || environment !== context?.environment) {
        return reject("workspace publish requires --environment to match the active Management API profile.");
    }
    if (!http || !context.projectRef) return reject("workspace publish requires a Management API context with a project ref.");

    const root = resolve(typeof args.root === "string" ? args.root : cwd);
    let changedFiles: string[];
    try {
        const head = await readWorkspaceHead(root);
        if (args.source_revision !== head) return reject("workspace publish requires --source-revision to match HEAD.");
        if (!await workspaceCheckoutClean(root)) return reject("workspace publish requires a clean workspace checkout at the Git root.");
        if (!await workspaceTracksFile(root, WORKSPACE_CONFIG_FILE)) return reject("The workspace configuration must be tracked in HEAD.");
        const collected = await collectGitChanges(root, args.base, head);
        if (collected.fallback) return reject(collected.fallback);
        changedFiles = collected.files;
    } catch {
        return reject("workspace publish could not verify the checked-out revision or change set.");
    }
    const plan = await createWorkspacePlan({ root, environment, changedFiles });
    if (plan.status !== "ready") return reject(`Workspace plan is '${plan.status}'. Run workspace plan for diagnostics.`);
    if (args.plan_sha256 !== plan.plan_sha256) return reject("The plan digest does not match the current workspace.");
    const site = plan.applications.find(entry => entry.id === args.application);
    const target = site?.target;
    if (!site || !target || !("frontend_deployment_id" in target)) {
        return reject("The selected application is not an affected static frontend in this plan.");
    }
    if (target.project_ref !== context.projectRef) {
        return reject("The planned project ref does not match the active Management API profile.");
    }
    if (!await workspaceTracksFile(root, `${site.root}/supacloud.json`)) {
        return reject("The site-local supacloud.json must be tracked in HEAD.");
    }
    const buildCommand = site.tasks.find(task => task.kind === "build")?.command;
    if (!buildCommand) return reject("The selected frontend lacks a planned build command.");
    return publishWorkspaceFrontend(http, {
        projectRef: target.project_ref,
        environment,
        deploymentId: target.frontend_deployment_id,
        root: resolve(root, site.root),
        buildCommand,
        skipBuild: args.skip_build === true,
        json: args.format === "json",
        environmentVariables: context.environmentVariables,
    });
}
