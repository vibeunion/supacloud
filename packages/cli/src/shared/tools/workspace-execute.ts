import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createWorkspacePlan, WORKSPACE_CONFIG_FILE, type WorkspacePlan } from "./workspace-plan";
import type { ToolResult } from "../tool-server";

export interface WorkspaceArtifact {
    releaseId: string;
    manifestSha256: string;
}

export type WorkspaceTargetStatus = "succeeded" | "failed" | "unknown" | "absent" | "accepted";

export interface WorkspaceTargetObservation {
    project_ref: string;
    application_id: string;
    environment_id: string;
    release_id: string | null;
    manifest_sha256: string | null;
    status: WorkspaceTargetStatus;
    failure: string | null;
    mutation_id: string | null;
    authoritative: false;
}

export interface WorkspaceDeliveryClient {
    build(input: { applicationId: string; root: string; sourceRevision: string; configDigest: string }): Promise<{ manifestSha256: string; manifestPath?: string }>;
    listReleases(projectRef: string, applicationId: string): Promise<WorkspaceArtifact[]>;
    upload(input: { projectRef: string; applicationId: string; root: string; manifestSha256: string }): Promise<WorkspaceArtifact>;
    transfer(input: { projectRef: string; applicationId: string; sourceProjectRef: string; sourceReleaseId: string; manifestSha256: string }): Promise<WorkspaceArtifact & { replayed: boolean }>;
    deploy(input: WorkspaceWrite): Promise<{ mutationId: string; status: WorkspaceTargetStatus; replayed: boolean }>;
    readDeploy(input: { projectRef: string; applicationId: string; environmentId: string; mutationId: string }): Promise<{ mutationId: string; status: WorkspaceTargetStatus }>;
    reconcileDeploy(input: { projectRef: string; applicationId: string; environmentId: string; mutationId: string }): Promise<{ mutationId: string; status: WorkspaceTargetStatus }>;
    promote(input: WorkspacePromotion): Promise<{ mutationId: string; status: WorkspaceTargetStatus; replayed: boolean }>;
    reconcilePromotion(input: { projectRef: string; applicationId: string; environmentId: string; mutationId: string }): Promise<{ mutationId: string; status: WorkspaceTargetStatus }>;
    observe(input: { projectRef: string; applicationId: string; environmentId: string }): Promise<WorkspaceTargetObservation>;
}

export interface WorkspaceWrite {
    projectRef: string;
    applicationId: string;
    environmentId: string;
    releaseId: string;
    manifestSha256: string;
    mutationId: string;
    approvalId: string | null;
    repository: string;
    configDigest: string;
    sourceRevision: string;
    workspacePlanSha256: string;
    configurationId: string | null;
    activationId: string | null;
    expectedActivationId: string | null;
}

export interface WorkspacePromotion extends WorkspaceWrite {
    sourceProjectRef: string;
    sourceEnvironmentId: string;
    sourceReleaseId: string;
}

export interface WorkspaceExecutionResult {
    schema: "supacloud.workspace-execution.v1";
    operation: "execute" | "retry" | "promote" | "rollback" | "reconcile" | "status";
    status: "ready" | "unchanged" | "blocked" | "completed" | "unknown";
    execution_performed: boolean;
    plan_sha256: string | null;
    config_digest: string | null;
    source_revision: string | null;
    repository: string | null;
    builds: Array<{ application_id: string; manifest_sha256: string; count: number }>;
    targets: Array<{
        application_id: string;
        environment_id: string;
        project_ref: string;
        release_id: string | null;
        mutation_id: string | null;
        status: WorkspaceTargetStatus | "skipped";
        reused_build: boolean;
        failure: string | null;
    }>;
    observations: WorkspaceTargetObservation[];
    diagnostics: Array<{ code: string; message: string }>;
}

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text", text }] };
}

export function workspaceMutationId(parts: readonly string[]): string {
    const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function blocked(operation: WorkspaceExecutionResult["operation"], code: string, message: string, plan: WorkspacePlan | null = null): WorkspaceExecutionResult {
    return {
        schema: "supacloud.workspace-execution.v1", operation, status: "blocked", execution_performed: false,
        plan_sha256: plan?.plan_sha256 ?? null, config_digest: null, source_revision: null, repository: plan?.repository ?? null,
        builds: [], targets: [], observations: [], diagnostics: [{ code, message }],
    };
}

async function releaseFor(client: WorkspaceDeliveryClient, projectRef: string, applicationId: string, manifestSha256: string, root: string): Promise<{ artifact: WorkspaceArtifact; uploaded: boolean }> {
    const existing = (await client.listReleases(projectRef, applicationId)).find(release => release.manifestSha256 === manifestSha256);
    if (existing) return { artifact: existing, uploaded: false };
    const uploaded = await client.upload({ projectRef, applicationId, root, manifestSha256 });
    if (uploaded.manifestSha256 !== manifestSha256) throw new Error("Uploaded release digest did not match the built manifest");
    return { artifact: uploaded, uploaded: true };
}

export async function executeWorkspace(input: {
    root: string;
    operation: WorkspaceExecutionResult["operation"];
    environment: string;
    changedFiles: readonly string[];
    execute: boolean;
    planSha256?: string;
    sourceRevision?: string;
    headRevision?: string;
    approvalId?: string;
    mutationId?: string;
    releaseId?: string;
    configurationId?: string;
    activationId?: string;
    expectedActivationId?: string | null;
    sourceEnvironment?: string;
    configDigest: string;
    client: WorkspaceDeliveryClient;
}): Promise<WorkspaceExecutionResult> {
    const plan = await createWorkspacePlan({ root: input.root, environment: input.environment, changedFiles: input.changedFiles });
    if (input.operation !== "status" && input.execute !== true) {
        return { ...blocked(input.operation, "execution-not-requested", "Pass --execute to perform workspace delivery. The plan was not executed.", plan), plan_sha256: plan.plan_sha256, config_digest: input.configDigest, repository: plan.repository };
    }
    if (!plan.repository) return blocked(input.operation, "repository-identity-required", "supacloud.workspace.json repository must name the source without credentials.", plan);
    if (input.operation === "status") return observeWorkspace(input, plan);
    if (plan.plan_sha256 !== input.planSha256) return blocked(input.operation, "stale-plan", "The plan digest does not match the current workspace. No target was selected.", plan);
    if (!input.sourceRevision || input.sourceRevision !== input.headRevision) {
        return blocked(input.operation, "source-revision-mismatch", "source revision must match the checked-out commit. No target was selected.", plan);
    }
    if (input.operation === "reconcile") return reconcileWorkspace(input, plan);
    if (input.operation === "promote") return promoteWorkspace(input, plan);
    if (input.operation === "rollback") return rollbackWorkspace(input, plan);
    return input.operation === "retry" ? retryWorkspace(input, plan) : deployWorkspace(input, plan);
}

function affectedTargets(plan: WorkspacePlan) {
    return plan.applications.filter(entry => entry.impact === "affected" && entry.target);
}

async function observeWorkspace(input: { root: string; client: WorkspaceDeliveryClient; configDigest: string }, plan: WorkspacePlan): Promise<WorkspaceExecutionResult> {
    const text = await readFile(join(resolve(input.root), WORKSPACE_CONFIG_FILE), "utf8");
    const parsed = JSON.parse(text) as { applications?: Array<{ environments?: Record<string, unknown> }> };
    const names = [...new Set((parsed.applications ?? []).flatMap(application => Object.keys(application.environments ?? {})))].sort((a, b) => a.localeCompare(b, "en"));
    const observations: WorkspaceTargetObservation[] = [];
    for (const environment of names) {
        const selected = environment === plan.environment ? plan : await createWorkspacePlan({ root: input.root, environment, changedFiles: [] });
        for (const application of selected.applications) {
            const binding = application.configured_binding;
            if (!binding) continue;
            const observed = await input.client.observe({ projectRef: binding.project_ref, applicationId: application.id, environmentId: environment });
            observations.push({ ...observed, authoritative: false });
        }
    }
    return {
        schema: "supacloud.workspace-execution.v1", operation: "status", status: "completed", execution_performed: false,
        plan_sha256: plan.plan_sha256, config_digest: input.configDigest, source_revision: null, repository: plan.repository,
        builds: [], targets: [], observations, diagnostics: [],
    };
}

async function deployWorkspace(input: { client: WorkspaceDeliveryClient; environment: string; sourceRevision?: string; approvalId?: string; configurationId?: string; configDigest: string }, plan: WorkspacePlan): Promise<WorkspaceExecutionResult> {
    const builds = new Map<string, { manifestSha256: string; count: number }>();
    const targets: WorkspaceExecutionResult["targets"] = [];
    for (const application of plan.applications.filter(entry => entry.impact === "affected" && entry.target)) {
        const target = application.target!;
        const key = `${application.id}\0${input.sourceRevision}\0${input.configDigest}`;
        let built = builds.get(key);
        if (!built) {
            const manifest = await input.client.build({ applicationId: application.id, root: application.root, sourceRevision: input.sourceRevision!, configDigest: input.configDigest });
            built = { manifestSha256: manifest.manifestSha256, count: 1 };
            builds.set(key, built);
        }
        const { artifact } = await releaseFor(input.client, target.project_ref, application.id, built.manifestSha256, application.root);
        const mutationId = workspaceMutationId(["deploy", plan.plan_sha256, application.id, input.environment, artifact.releaseId]);
        if (input.environment === "production" && !input.approvalId) {
            targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: artifact.releaseId, mutation_id: null, status: "skipped", reused_build: built.count > 1, failure: "production deployment requires a server approval" });
            continue;
        }
        const deployed = await input.client.deploy({
            projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment,
            releaseId: artifact.releaseId, manifestSha256: artifact.manifestSha256, mutationId,
            approvalId: input.approvalId ?? null, repository: plan.repository!, configDigest: input.configDigest,
            sourceRevision: input.sourceRevision!, workspacePlanSha256: plan.plan_sha256,
            configurationId: input.configurationId ?? null, activationId: null, expectedActivationId: null,
        });
        if (deployed.mutationId !== mutationId) {
            return blocked("execute", "mutation-identity-changed", "The deployment response changed the mutation id. No new write was attempted.", plan);
        }
        targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: artifact.releaseId, mutation_id: mutationId, status: deployed.status, reused_build: false, failure: deployed.status === "failed" ? "deployment failed" : null });
        if (deployed.status === "unknown") break;
    }
    const unknown = targets.some(target => target.status === "unknown");
    return {
        schema: "supacloud.workspace-execution.v1", operation: "execute", status: unknown ? "unknown" : "completed",
        execution_performed: targets.some(target => target.status !== "skipped"), plan_sha256: plan.plan_sha256,
        config_digest: input.configDigest, source_revision: input.sourceRevision ?? null, repository: plan.repository,
        builds: [...builds.entries()].map(([key, value]) => ({ application_id: key.split("\0")[0]!, manifest_sha256: value.manifestSha256, count: value.count })),
        targets, observations: [], diagnostics: [],
    };
}

async function retryWorkspace(input: { client: WorkspaceDeliveryClient; environment: string; sourceRevision?: string; approvalId?: string; mutationId?: string; configurationId?: string; configDigest: string }, plan: WorkspacePlan): Promise<WorkspaceExecutionResult> {
    const selected = affectedTargets(plan);
    if (input.mutationId && selected.length !== 1) return blocked("retry", "ambiguous-retry", "Pass one affected application when retrying an explicit mutation id.", plan);
    const targets: WorkspaceExecutionResult["targets"] = [];
    let wrote = false;
    for (const application of selected) {
        const target = application.target!;
        const releases = await input.client.listReleases(target.project_ref, application.id);
        const existing = releases[0];
        if (!existing) return blocked("retry", "release-missing", "Retry cannot rebuild a missing release from an ambiguous target.", plan);
        const mutationId = input.mutationId ?? workspaceMutationId(["deploy", plan.plan_sha256, application.id, input.environment, existing.releaseId]);
        const current = await input.client.readDeploy({ projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment, mutationId });
        if (current.mutationId !== mutationId) return blocked("retry", "mutation-identity-changed", "The stored deployment id did not match. No new write was attempted.", plan);
        if (current.status === "succeeded") {
            targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: existing.releaseId, mutation_id: mutationId, status: "succeeded", reused_build: true, failure: null });
            continue;
        }
        if (current.status === "unknown" || current.status === "accepted") {
            const reconciled = await input.client.reconcileDeploy({ projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment, mutationId });
            if (reconciled.mutationId !== mutationId) return blocked("retry", "mutation-identity-changed", "Reconcile changed the mutation id.", plan);
            targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: existing.releaseId, mutation_id: mutationId, status: reconciled.status, reused_build: true, failure: null });
            continue;
        }
        wrote = true;
        const deployed = await input.client.deploy({
            projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment,
            releaseId: existing.releaseId, manifestSha256: existing.manifestSha256, mutationId,
            approvalId: input.approvalId ?? null, repository: plan.repository!, configDigest: input.configDigest,
            sourceRevision: input.sourceRevision!, workspacePlanSha256: plan.plan_sha256,
            configurationId: input.configurationId ?? null, activationId: null, expectedActivationId: null,
        });
        if (deployed.mutationId !== mutationId) return blocked("retry", "mutation-identity-changed", "Retry changed the mutation id.", plan);
        targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: existing.releaseId, mutation_id: mutationId, status: deployed.status, reused_build: true, failure: null });
    }
    return {
        schema: "supacloud.workspace-execution.v1", operation: "retry", status: targets.some(target => target.status === "unknown") ? "unknown" : "completed",
        execution_performed: wrote, plan_sha256: plan.plan_sha256,
        config_digest: input.configDigest, source_revision: input.sourceRevision ?? null, repository: plan.repository,
        builds: [], targets, observations: [], diagnostics: [],
    };
}

async function promoteWorkspace(input: { root: string; changedFiles: readonly string[]; client: WorkspaceDeliveryClient; environment: string; sourceEnvironment?: string; sourceRevision?: string; approvalId?: string; releaseId?: string; configurationId?: string; configDigest: string }, plan: WorkspacePlan): Promise<WorkspaceExecutionResult> {
    if (!input.approvalId || !input.sourceEnvironment || !input.configurationId) {
        return blocked("promote", "approval-required", "Promotion requires a server approval, source environment, and configuration revision.", plan);
    }
    const sourcePlan = await createWorkspacePlan({ root: input.root, environment: input.sourceEnvironment, changedFiles: input.changedFiles });
    const targets: WorkspaceExecutionResult["targets"] = [];
    for (const application of affectedTargets(plan)) {
        const target = application.target!;
        const source = sourcePlan.applications.find(entry => entry.id === application.id)?.configured_binding;
        if (!source) return blocked("promote", "source-binding-missing", "The source environment has no project binding for this application.", plan);
        const releases = await input.client.listReleases(source.project_ref, application.id);
        const selected = releases.find(release => release.releaseId === input.releaseId) ?? releases[0];
        if (!selected) return blocked("promote", "source-release-missing", "The source project has no immutable release to promote.", plan);
        const transferred = await input.client.transfer({
            projectRef: target.project_ref, applicationId: application.id, sourceProjectRef: source.project_ref,
            sourceReleaseId: selected.releaseId, manifestSha256: selected.manifestSha256,
        });
        const mutationId = workspaceMutationId(["promote", plan.plan_sha256, application.id, input.environment, transferred.releaseId]);
        const promoted = await input.client.promote({
            projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment,
            releaseId: transferred.releaseId, manifestSha256: transferred.manifestSha256, mutationId,
            approvalId: input.approvalId, repository: plan.repository!, configDigest: input.configDigest,
            sourceRevision: input.sourceRevision!, workspacePlanSha256: plan.plan_sha256,
            configurationId: input.configurationId, activationId: null, expectedActivationId: null,
            sourceProjectRef: source.project_ref, sourceEnvironmentId: input.sourceEnvironment, sourceReleaseId: selected.releaseId,
        });
        if (promoted.mutationId !== mutationId) return blocked("promote", "mutation-identity-changed", "Promotion changed the mutation id.", plan);
        targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: transferred.releaseId, mutation_id: mutationId, status: promoted.status, reused_build: true, failure: null });
    }
    return {
        schema: "supacloud.workspace-execution.v1", operation: "promote", status: "completed", execution_performed: true,
        plan_sha256: plan.plan_sha256, config_digest: input.configDigest, source_revision: input.sourceRevision ?? null,
        repository: plan.repository, builds: [], targets, observations: [], diagnostics: [],
    };
}

async function rollbackWorkspace(input: { client: WorkspaceDeliveryClient; environment: string; sourceRevision?: string; approvalId?: string; releaseId?: string; configurationId?: string; activationId?: string; expectedActivationId?: string | null; configDigest: string }, plan: WorkspacePlan): Promise<WorkspaceExecutionResult> {
    if (!input.approvalId || !input.releaseId || !input.configurationId || !input.activationId) {
        return blocked("rollback", "approval-required", "Rollback requires a server approval and the immutable release, configuration, and activation ids.", plan);
    }
    const targets: WorkspaceExecutionResult["targets"] = [];
    for (const application of plan.applications.filter(entry => entry.target)) {
        const target = application.target!;
        const known = (await input.client.listReleases(target.project_ref, application.id)).find(release => release.releaseId === input.releaseId);
        if (!known) return blocked("rollback", "release-missing", "Rollback can only activate a release the target project already stores.", plan);
        const deployed = await input.client.deploy({
            projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment,
            releaseId: known.releaseId, manifestSha256: known.manifestSha256,
            mutationId: input.activationId!, approvalId: input.approvalId!, repository: plan.repository!,
            configDigest: input.configDigest, sourceRevision: input.sourceRevision!, workspacePlanSha256: plan.plan_sha256,
            configurationId: input.configurationId!, activationId: input.activationId!, expectedActivationId: input.expectedActivationId ?? null,
        });
        if (deployed.mutationId !== input.activationId) return blocked("rollback", "mutation-identity-changed", "Rollback changed the activation id.", plan);
        targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: input.releaseId, mutation_id: input.activationId, status: deployed.status, reused_build: true, failure: null });
    }
    return {
        schema: "supacloud.workspace-execution.v1", operation: "rollback", status: "completed", execution_performed: true,
        plan_sha256: plan.plan_sha256, config_digest: input.configDigest, source_revision: input.sourceRevision ?? null,
        repository: plan.repository, builds: [], targets, observations: [], diagnostics: [],
    };
}

async function reconcileWorkspace(input: { client: WorkspaceDeliveryClient; environment: string; mutationId?: string; configDigest: string }, plan: WorkspacePlan): Promise<WorkspaceExecutionResult> {
    if (!input.mutationId) return blocked("reconcile", "mutation-required", "Reconcile requires the existing mutation id and never allocates a new one.", plan);
    const targets: WorkspaceExecutionResult["targets"] = [];
    for (const application of plan.applications.filter(entry => entry.target)) {
        const target = application.target!;
        const reconciled = await input.client.reconcilePromotion({
            projectRef: target.project_ref, applicationId: application.id, environmentId: input.environment, mutationId: input.mutationId,
        });
        if (reconciled.mutationId !== input.mutationId) return blocked("reconcile", "mutation-identity-changed", "Reconcile changed the mutation id.", plan);
        targets.push({ application_id: application.id, environment_id: input.environment, project_ref: target.project_ref, release_id: null, mutation_id: input.mutationId, status: reconciled.status, reused_build: true, failure: null });
    }
    return {
        schema: "supacloud.workspace-execution.v1", operation: "reconcile", status: targets.some(target => target.status === "unknown") ? "unknown" : "completed",
        execution_performed: false, plan_sha256: plan.plan_sha256, config_digest: input.configDigest,
        source_revision: null, repository: plan.repository, builds: [], targets, observations: [], diagnostics: [],
    };
}

export async function runWorkspaceCommand(args: Record<string, unknown>, cwd = process.cwd(), client?: WorkspaceDeliveryClient): Promise<ToolResult> {
    if (!client) return textResult("Workspace delivery requires a Management API context. No build or deploy was started.", true);
    const environment = typeof args.environment === "string" ? args.environment : "";
    if (!environment) return textResult("workspace delivery requires --environment", true);
    const root = resolve(typeof args.root === "string" ? args.root : cwd);
    let configDigest = "";
    try {
        configDigest = createHash("sha256").update(await readFile(join(root, WORKSPACE_CONFIG_FILE))).digest("hex");
    } catch {
        return textResult("supacloud.workspace.json was not found", true);
    }
    const operation = args.action;
    if (operation !== "execute" && operation !== "retry" && operation !== "promote" && operation !== "rollback" && operation !== "reconcile" && operation !== "status") {
        return textResult("Unknown workspace action", true);
    }
    const changedFiles = typeof args.changed === "string"
        ? (await readFile(resolve(root, args.changed), "utf8")).split("\n").map(line => line.trim()).filter(Boolean)
        : [];
    const result = await executeWorkspace({
        root, operation, environment, changedFiles, execute: args.execute === true, configDigest, client,
        planSha256: typeof args.plan_sha256 === "string" ? args.plan_sha256 : undefined,
        sourceRevision: typeof args.source_revision === "string" ? args.source_revision : undefined,
        headRevision: typeof args.source_revision === "string" ? args.source_revision : undefined,
        approvalId: typeof args.approval_id === "string" ? args.approval_id : undefined,
        mutationId: typeof args.mutation_id === "string" ? args.mutation_id : undefined,
        releaseId: typeof args.release_id === "string" ? args.release_id : undefined,
        configurationId: typeof args.configuration_id === "string" ? args.configuration_id : undefined,
        activationId: typeof args.activation_id === "string" ? args.activation_id : undefined,
        expectedActivationId: args.expected_activation_id === "absent" ? null : typeof args.expected_activation_id === "string" ? args.expected_activation_id : undefined,
        sourceEnvironment: typeof args.source_environment === "string" ? args.source_environment : undefined,
    });
    const isError = result.status === "blocked" || result.targets.some(target => target.status === "failed" || target.status === "unknown");
    return args.format === "json" ? textResult(JSON.stringify(result, null, 2), isError) : textResult(formatWorkspaceExecution(result), isError);
}

export function formatWorkspaceExecution(result: WorkspaceExecutionResult): string {
    const lines = [
        `Workspace ${result.operation} ${result.schema}`,
        `status: ${result.status}`,
        `execution: ${result.execution_performed ? "performed" : "not performed"}`,
        `repository: ${result.repository ?? "(missing)"}`,
    ];
    for (const build of result.builds) lines.push(`build ${build.application_id} count=${build.count} manifest=${build.manifest_sha256}`);
    for (const target of result.targets) lines.push(`${target.application_id} ${target.environment_id} project=${target.project_ref} status=${target.status} release=${target.release_id ?? "(none)"} mutation=${target.mutation_id ?? "(none)"}`);
    for (const observation of result.observations) lines.push(`observed ${observation.application_id} ${observation.environment_id} project=${observation.project_ref} status=${observation.status} authoritative=false`);
    for (const diagnostic of result.diagnostics) lines.push(`error ${diagnostic.code}: ${diagnostic.message}`);
    return lines.join("\n");
}
