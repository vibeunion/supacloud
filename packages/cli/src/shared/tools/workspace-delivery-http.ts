import { applicationReleaseId } from "@supacloud/delivery";
import type { HttpTransport } from "../transports/http";
import type { ReleaseList, ReleaseOutcome, WorkspaceApprovalView, WorkspaceArtifact, WorkspaceDeliveryClient, WorkspacePromotion, WorkspaceTargetObservation, WorkspaceTargetStatus, WorkspaceWrite } from "./workspace-execute";

export interface WorkspaceHttp {
    get(path: string): Promise<{ ok: boolean; status: number; data: unknown; transportError?: boolean }>;
    post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown; transportError?: boolean }>;
    postMultipart?(path: string, body: FormData): Promise<{ ok: boolean; status: number; data: unknown; transportError?: boolean }>;
}

function unknownStatus(result: { ok: boolean; status: number; transportError?: boolean }): "failed" | "unknown" {
    return !result.ok && (result.transportError || result.status === 0 || result.status >= 500) ? "unknown" : "failed";
}

function artifact(projectRef: string, applicationId: string, manifestSha256: string): WorkspaceArtifact {
    return { manifestSha256, releaseId: applicationReleaseId(projectRef, applicationId, manifestSha256) };
}

/** Calls the existing application release, transfer, and promotion routes. It does not invent success. */
export function createHttpWorkspaceDeliveryClient(http: WorkspaceHttp, build: WorkspaceDeliveryClient["build"]): WorkspaceDeliveryClient {
    let manifestPath: string | undefined;
    return {
        build: async input => {
            const built = await build(input);
            manifestPath = built.manifestPath;
            return built;
        },
        async listReleases(projectRef, applicationId): Promise<ReleaseList> {
            const result = await http.get(`/v1/projects/${projectRef}/applications/${encodeURIComponent(applicationId)}/releases?limit=100`);
            if (!result.ok) return { availability: result.status === 401 || result.status === 403 ? "unauthorized" : "unavailable" };
            if (!result.data || typeof result.data !== "object" || !("releases" in result.data) || !Array.isArray(result.data.releases)) {
                return { availability: "unavailable" };
            }
            return {
                availability: "available",
                releases: result.data.releases.flatMap(value => {
                    if (!value || typeof value !== "object" || !("release_id" in value) || !("manifest_sha256" in value)) return [];
                    const releaseId = value.release_id, manifestSha256 = value.manifest_sha256;
                    return typeof releaseId === "string" && typeof manifestSha256 === "string" ? [{ releaseId, manifestSha256 }] : [];
                }),
            };
        },
        async upload(input) {
            if (!manifestPath || !http.postMultipart) throw new Error("WORKSPACE_UPLOAD_REQUIRES_MANIFEST");
            const { readDeliveryExecutableArchive } = await import("@supacloud/delivery");
            const { canonical, digest } = await import("@supacloud/delivery/files");
            const archive = await readDeliveryExecutableArchive(manifestPath);
            const manifest = canonical(archive.manifest);
            if (digest(manifest) !== input.manifestSha256) throw new Error("WORKSPACE_UPLOAD_DIGEST_MISMATCH");
            const form = new FormData();
            form.set("manifest", manifest);
            form.set("expected_objects", canonical(Object.fromEntries(archive.objects.map(({ object }) => [object.name, object.objectId]))));
            for (const { object, files } of archive.objects) {
                for (const [name, bytes] of files) form.set(`objects/${object.objectId}/${name}`, new Blob([Uint8Array.from(bytes)]), "artifact.bin");
            }
            const result = await http.postMultipart(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/releases`, form);
            if (!result.ok) throw new Error(unknownStatus(result) === "unknown" ? "WORKSPACE_UPLOAD_UNKNOWN" : "WORKSPACE_UPLOAD_FAILED");
            return artifact(input.projectRef, input.applicationId, input.manifestSha256);
        },
        async transfer(input) {
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/release-transfers`, {
                source_ref: input.sourceProjectRef, source_release_id: input.sourceReleaseId, expected_manifest_sha256: input.manifestSha256,
            });
            if (!result.ok) throw new Error(unknownStatus(result) === "unknown" ? "WORKSPACE_TRANSFER_UNKNOWN" : "WORKSPACE_TRANSFER_FAILED");
            return { ...artifact(input.projectRef, input.applicationId, input.manifestSha256), replayed: result.status === 200 };
        },
        async deploy(input) {
            if (!input.configurationId) return { mutationId: input.activationId ?? input.mutationId, status: "failed", replayed: false };
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-activations`, writeBody(input));
            if (!result.ok) return { mutationId: input.activationId ?? input.mutationId, status: unknownStatus(result), replayed: false };
            const activationId = result.data && typeof result.data === "object" && "activation_id" in result.data && typeof result.data.activation_id === "string"
                ? result.data.activation_id : input.activationId ?? input.mutationId;
            if (activationId !== (input.activationId ?? input.mutationId)) return { mutationId: input.activationId ?? input.mutationId, status: "unknown", replayed: false };
            return { mutationId: activationId, status: "accepted", replayed: false };
        },
        async readDeploy(input): Promise<ReleaseOutcome> {
            return input.operation === "promotion" ? readPromotion(http, input) : readActivation(http, input);
        },
        async reconcileDeploy(input): Promise<ReleaseOutcome> {
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-activations/${input.mutationId}/reconcile`, {});
            if (!result.ok) return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
            return receiptOutcome(input.mutationId, result.data);
        },
        async promote(input: WorkspacePromotion) {
            const query = new URLSearchParams({
                source_ref: input.sourceProjectRef, source_environment_id: input.sourceEnvironmentId, source_release_id: input.sourceReleaseId,
            });
            if (input.configurationId) query.set("configuration_id", input.configurationId);
            const planned = await http.get(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/promotion-plan?${query}`);
            if (!planned.ok) return { mutationId: input.mutationId, status: unknownStatus(planned), replayed: false };
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-promotions`, {
                mutation_id: input.mutationId, approval_id: input.approvalId, repository: input.repository,
                source_ref: input.sourceProjectRef, source_environment_id: input.sourceEnvironmentId, source_release_id: input.sourceReleaseId,
                configuration_id: input.configurationId, manifest_sha256: input.manifestSha256, config_digest: input.configDigest,
                source_revision: input.sourceRevision, workspace_plan_sha256: input.workspacePlanSha256, plan: planned.data,
            });
            if (!result.ok) return { mutationId: input.mutationId, status: unknownStatus(result), replayed: false };
            return { mutationId: input.mutationId, status: "accepted", replayed: false };
        },
        async reconcilePromotion(input): Promise<ReleaseOutcome> {
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-promotions/${input.mutationId}/reconcile`, {});
            if (!result.ok) return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
            return receiptOutcome(input.mutationId, result.data);
        },
        async readApproval(input): Promise<WorkspaceApprovalView | { availability: "missing" | "unauthorized" | "unavailable" }> {
            const result = await http.get(`/v1/projects/${input.projectRef}/workspace-approvals/${input.approvalId}`);
            if (result.status === 404) return { availability: "missing" };
            if (result.status === 401 || result.status === 403) return { availability: "unauthorized" };
            if (!result.ok || !result.data || typeof result.data !== "object") return { availability: "unavailable" };
            const record = result.data;
            const text = (key: string) => key in record && typeof record[key as keyof typeof record] === "string" ? record[key as keyof typeof record] as string : null;
            const repository = text("repository"), applicationId = text("application_id"), environmentId = text("environment_id");
            const projectRef = text("project_ref"), releaseId = text("release_id"), manifestSha256 = text("manifest_sha256");
            const configDigest = text("config_digest"), sourceRevision = text("source_revision"), workspacePlanSha256 = text("workspace_plan_sha256");
            if (!repository || !applicationId || !environmentId || !projectRef || !releaseId || !manifestSha256 || !configDigest || !sourceRevision || !workspacePlanSha256) {
                return { availability: "unavailable" };
            }
            return { availability: "available", repository, applicationId, environmentId, projectRef, releaseId, manifestSha256, configDigest, sourceRevision, workspacePlanSha256 };
        },
        async observe(input): Promise<WorkspaceTargetObservation> {
            const result = await http.get(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/runtime`);
            if (!result.ok) return { ...input, project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, release_id: null, manifest_sha256: null, status: unknownStatus(result), failure: "runtime observation failed", mutation_id: null, authoritative: false };
            const readiness = result.data && typeof result.data === "object" && "readiness" in result.data ? result.data.readiness : null;
            const releaseId = readiness && typeof readiness === "object" && readiness && "release_id" in readiness && typeof readiness.release_id === "string" ? readiness.release_id : null;
            return { project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, release_id: releaseId, manifest_sha256: null, status: releaseId ? "succeeded" : "absent", failure: null, mutation_id: null, authoritative: false };
        },
    };
}

function writeBody(input: WorkspaceWrite): Record<string, unknown> {
    const activation = {
        activation_id: input.activationId ?? input.mutationId, release_id: input.releaseId,
        configuration_id: input.configurationId, expected_activation_id: input.expectedActivationId,
    };
    if (input.environmentId !== "production") return activation;
    return {
        ...activation, approval_id: input.approvalId, repository: input.repository, manifest_sha256: input.manifestSha256,
        config_digest: input.configDigest, source_revision: input.sourceRevision, workspace_plan_sha256: input.workspacePlanSha256,
    };
}

function mutationState(status: unknown): WorkspaceTargetStatus {
    if (status === "succeeded") return "succeeded";
    if (status === "failed" || status === "failed_retryable" || status === "failed_terminal") return "failed";
    if (status === "absent") return "absent";
    return "unknown";
}

function receiptOutcome(mutationId: string, data: unknown): ReleaseOutcome {
    const record = data && typeof data === "object" ? data as { mutation?: { status?: unknown }; promotion?: { release_id?: unknown }; release_id?: unknown } : {};
    const release = typeof record.promotion?.release_id === "string" ? record.promotion.release_id : typeof record.release_id === "string" ? record.release_id : null;
    return { mutationId, status: mutationState(record.mutation?.status), releaseId: release, manifestSha256: null };
}

async function readActivation(http: WorkspaceHttp, input: { projectRef: string; applicationId: string; environmentId: string; mutationId: string }): Promise<ReleaseOutcome> {
    const result = await http.get(`/v1/projects/${input.projectRef}/mutations/${input.mutationId}`);
    if (result.status === 404) return { mutationId: input.mutationId, status: "absent", releaseId: null, manifestSha256: null };
    if (!result.ok) return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
    const status = mutationState(result.data && typeof result.data === "object" && "status" in result.data ? result.data.status : undefined);
    if (status !== "succeeded" && status !== "failed") return { mutationId: input.mutationId, status, releaseId: null, manifestSha256: null };
    const history = await http.get(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/history?limit=100`);
    const entries = history.ok && history.data && typeof history.data === "object" && "history" in history.data && Array.isArray(history.data.history) ? history.data.history : [];
    const entry = entries.find(value => value && typeof value === "object" && "activation_id" in value && value.activation_id === input.mutationId);
    const releaseId = entry && typeof entry === "object" && "release_id" in entry && typeof entry.release_id === "string" ? entry.release_id : null;
    if (!releaseId) return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
    return { mutationId: input.mutationId, status, releaseId, manifestSha256: null };
}

async function readPromotion(http: WorkspaceHttp, input: { projectRef: string; applicationId: string; environmentId: string; mutationId: string }): Promise<ReleaseOutcome> {
    const result = await http.get(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/promotions/${input.mutationId}`);
    if (result.status === 404) return { mutationId: input.mutationId, status: "absent", releaseId: null, manifestSha256: null };
    if (!result.ok) return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
    return receiptOutcome(input.mutationId, result.data);
}

export function workspaceHttpFromTransport(http: HttpTransport): WorkspaceHttp {
    return {
        get: async path => http.get(path),
        post: async (path, body) => http.post(path, body),
        postMultipart: async (path, body) => http.postMultipart(path, body),
    };
}
