import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  edgeFunctionActivationGenerationPath, writeEdgeFunctionActivationGeneration,
  replaceEdgeFunctionActivationManifest, confirmEdgeFunctionActivationManifestDurable,
} from "./edge-function-activation-manifest";
import {
  PROJECT_RELEASE_FILE, PROJECT_RELEASE_SCHEMA, PROJECT_RELEASE_SLUG, RELEASE_ID,
  parseProjectRelease, releaseAuthority, type ProjectRelease, type ProjectReleaseSnapshot,
} from "./project-release-contract";
import {
  prepareProjectReleaseMembers, projectFunctionDirectory, readProjectFunctionRelease,
  withProjectFunctionReleaseLock,
} from "./edge-function.service";
import { projectMutationFingerprint, type MutationPrincipal } from "./project-mutation.service";
import { projectReleaseMutations, type ReleaseMutationStore } from "./project-release-mutation";
import { ConflictError, ValidationError } from "../utils/errors";

export interface PublishProjectReleaseInput {
  projectRef: string;
  mutationId: string;
  expectedReleaseId: string | null;
  functions: Array<{ slug: string; version: string; expected_activation_id: string }>;
  principal: MutationPrincipal;
}

function normalize(input: PublishProjectReleaseInput): PublishProjectReleaseInput {
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(input.projectRef) || !RELEASE_ID.test(input.mutationId)
    || (input.expectedReleaseId !== null && !RELEASE_ID.test(input.expectedReleaseId))
    || !Array.isArray(input.functions) || input.functions.length < 1 || input.functions.length > 128) {
    throw new ValidationError("Invalid release identity or member count");
  }
  const functions = input.functions.map(({ slug, version, expected_activation_id }) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || slug === PROJECT_RELEASE_SLUG
      || !/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version))
      || (expected_activation_id !== "legacy" && !RELEASE_ID.test(expected_activation_id))) {
      throw new ValidationError("Invalid release member");
    }
    return { slug, version, expected_activation_id };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
  if (new Set(functions.map((entry) => entry.slug)).size !== functions.length) throw new ValidationError("Duplicate release function");
  return { ...input, functions };
}

interface ReleaseDependencies {
  directory: typeof projectFunctionDirectory;
  current: typeof readProjectFunctionRelease;
  lock: typeof withProjectFunctionReleaseLock;
  prepare: typeof prepareProjectReleaseMembers;
  mutations: ReleaseMutationStore;
  interruption?: (phase: "prepared" | "published") => void;
}

export class ProjectReleaseService {
  constructor(private readonly deps: ReleaseDependencies = {
    directory: projectFunctionDirectory, current: readProjectFunctionRelease,
    lock: withProjectFunctionReleaseLock, prepare: prepareProjectReleaseMembers, mutations: projectReleaseMutations,
  }) {}

  async status(projectRef: string, mutationId?: string) {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(projectRef) || (mutationId && !RELEASE_ID.test(mutationId))) {
      throw new Error("Invalid release status identity");
    }
    const active = await this.deps.current(projectRef);
    const mutation = mutationId ? await this.deps.mutations.read(projectRef, mutationId) : null;
    return {
      project_ref: projectRef, active_release_id: active?.release.mutation_id ?? null,
      generation: active?.authority.activation_generation ?? 0,
      functions: active ? Object.entries(active.release.members).map(([slug, member]) => ({
        slug, version: member.config.version, activation_id: member.authority.activation_id,
      })) : [],
      mutation: mutation ? { mutation_id: mutation.mutationId, status: mutation.status, failure_code: mutation.failureCode } : null,
    };
  }

  async publish(raw: PublishProjectReleaseInput) {
    const input = normalize(raw);
    const fingerprint = projectMutationFingerprint({
      project_ref: input.projectRef, expected_release_id: input.expectedReleaseId, functions: input.functions,
    });
    return this.deps.lock(input.projectRef, input.functions.map((entry) => entry.slug), async () => {
      const { state, lease } = await this.deps.mutations.begin({
        projectRef: input.projectRef, mutationId: input.mutationId,
        operation: "functions.release.publish", resource: { type: "function_release", id: "project" },
        requestFingerprint: fingerprint, principal: input.principal,
      });
      const directory = this.deps.directory(input.projectRef);
      const manifestPath = join(directory, PROJECT_RELEASE_FILE);
      let publishAttempted = false;
      try {
        const current = await this.deps.current(input.projectRef);
        if (state.status === "succeeded") return { ...(await this.status(input.projectRef, input.mutationId)), replayed: true };
        // 响应丢失后只回读、确认持久化并补回执，不重新执行发布。
        if (current?.release.mutation_id === input.mutationId) {
          publishAttempted = true;
          if (current.release.request_fingerprint !== fingerprint) throw new Error("Release authority fingerprint conflict");
          await confirmEdgeFunctionActivationManifestDurable(manifestPath, input.mutationId);
          if (state.status === "outcome_unknown") await this.deps.mutations.recover(state, fingerprint);
          else if (lease) await this.deps.mutations.success(lease, this.receipt(current));
          else throw new Error("Release mutation cannot be reconciled");
          return { ...(await this.status(input.projectRef, input.mutationId)), replayed: true };
        }
        if (!lease || state.status === "outcome_unknown") throw new Error("Release outcome requires authoritative reconciliation");
        if ((current?.release.mutation_id ?? null) !== input.expectedReleaseId) throw new ConflictError("Release CAS conflict");
        const requested = new Set(input.functions.map((entry) => entry.slug));
        if (current && Object.keys(current.release.members).some((slug) => !requested.has(slug))) {
          throw new ConflictError("Release must include all previously enrolled functions");
        }
        let candidate: ProjectReleaseSnapshot | null = null;
        const generationPath = edgeFunctionActivationGenerationPath(directory, PROJECT_RELEASE_SLUG, input.mutationId);
        try { candidate = parseProjectRelease(await readFile(generationPath, "utf8"), input.projectRef); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        // 重启后重新核验版本、租户环境和预热；已有候选的身份不得重写。
        const prepared = await this.deps.prepare(input.projectRef, input.functions);
        if (candidate) {
          if (candidate.release.request_fingerprint !== fingerprint
            || candidate.authority.previous_activation_id !== input.expectedReleaseId
            || candidate.authority.activation_generation !== (current?.authority.activation_generation ?? 0) + 1
            || projectMutationFingerprint(Object.fromEntries(Object.entries(prepared).map(([slug, member]) => [slug, { config: member.config, digest: member.authority.artifact_sha256 }])))
              !== projectMutationFingerprint(Object.fromEntries(Object.entries(candidate.release.members).map(([slug, member]) => [slug, { config: member.config, digest: member.authority.artifact_sha256 }])))) {
            throw new Error("Release candidate does not match recovered request");
          }
        } else {
          const release: ProjectRelease = {
            schema: PROJECT_RELEASE_SCHEMA, project_ref: input.projectRef, mutation_id: input.mutationId,
            request_fingerprint: fingerprint, members: prepared,
          };
          candidate = { release, authority: releaseAuthority(release, current) };
          await writeEdgeFunctionActivationGeneration({
            projectDirectory: directory, functionSlug: PROJECT_RELEASE_SLUG,
            config: release, authority: candidate.authority,
          });
        }
        this.deps.interruption?.("prepared");
        await this.deps.mutations.protect(lease, async () => {
          if (((await this.deps.current(input.projectRef))?.release.mutation_id ?? null) !== input.expectedReleaseId) {
            throw new ConflictError("Release CAS conflict at publication");
          }
          publishAttempted = true;
          await replaceEdgeFunctionActivationManifest({
            manifestPath, config: candidate!.release, authority: candidate!.authority,
          });
        });
        this.deps.interruption?.("published");
        await this.deps.mutations.success(lease, this.receipt(candidate));
        return { ...(await this.status(input.projectRef, input.mutationId)), replayed: false };
      } catch (error) {
        if (lease) await this.deps.mutations.failure(lease, publishAttempted, error instanceof ConflictError);
        throw error;
      }
    });
  }

  private receipt(snapshot: ProjectReleaseSnapshot) {
    return {
      schema: PROJECT_RELEASE_SCHEMA, release_id: snapshot.release.mutation_id,
      generation: snapshot.authority.activation_generation, manifest_sha256: snapshot.authority.artifact_sha256,
    };
  }
}

export const projectReleaseService = new ProjectReleaseService();
