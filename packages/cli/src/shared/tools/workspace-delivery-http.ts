import { applicationReleaseId } from "@supacloud/delivery";
import type { HttpTransport } from "../transports/http";
import type { WorkspaceArtifact, WorkspaceDeliveryClient, WorkspacePromotion, WorkspaceTargetObservation, WorkspaceWrite } from "./workspace-execute";

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
        async listReleases(projectRef, applicationId) {
            const result = await http.get(`/v1/projects/${projectRef}/applications/${encodeURIComponent(applicationId)}/releases?limit=100`);
            if (!result.ok || !result.data || typeof result.data !== "object" || !("releases" in result.data) || !Array.isArray(result.data.releases)) return [];
            return result.data.releases.flatMap(value => {
                if (!value || typeof value !== "object" || !("release_id" in value) || !("manifest_sha256" in value)) return [];
                const releaseId = value.release_id, manifestSha256 = value.manifest_sha256;
                return typeof releaseId === "string" && typeof manifestSha256 === "string" ? [{ releaseId, manifestSha256 }] : [];
            });
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
            const path = input.environmentId === "production"
                ? `/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-activations`
                : `/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/activations`;
            const result = await http.post(path, writeBody(input));
            if (!result.ok) return { mutationId: input.activationId ?? input.mutationId, status: unknownStatus(result), replayed: false };
            const activationId = result.data && typeof result.data === "object" && "activation_id" in result.data && typeof result.data.activation_id === "string"
                ? result.data.activation_id : input.activationId ?? input.mutationId;
            if (activationId !== (input.activationId ?? input.mutationId)) return { mutationId: input.activationId ?? input.mutationId, status: "unknown", replayed: false };
            return { mutationId: activationId, status: "accepted", replayed: false };
        },
        async readDeploy(input) {
            const result = await http.get(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/promotions/${input.mutationId}`);
            if (!result.ok) return { mutationId: input.mutationId, status: unknownStatus(result) };
            return { mutationId: input.mutationId, status: "succeeded" };
        },
        async reconcileDeploy(input) {
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-activations/${input.mutationId}/reconcile`, {});
            if (!result.ok) return { mutationId: input.mutationId, status: unknownStatus(result) };
            return { mutationId: input.mutationId, status: "succeeded" };
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
        async reconcilePromotion(input) {
            const result = await http.post(`/v1/projects/${input.projectRef}/applications/${encodeURIComponent(input.applicationId)}/environments/${encodeURIComponent(input.environmentId)}/workspace-promotions/${input.mutationId}/reconcile`, {});
            if (!result.ok) return { mutationId: input.mutationId, status: unknownStatus(result) };
            return { mutationId: input.mutationId, status: "succeeded" };
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

export function workspaceHttpFromTransport(http: HttpTransport): WorkspaceHttp {
    return {
        get: async path => http.get(path),
        post: async (path, body) => http.post(path, body),
        postMultipart: async (path, body) => http.postMultipart(path, body),
    };
}
