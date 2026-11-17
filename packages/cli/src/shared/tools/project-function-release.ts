import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { projectRefPathSegment } from "../project-ref";
import type { HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";
import {
    projectedFunctionIdentity,
    validObservedFunctionActivationId,
} from "./edge-function-response";

const SAFE_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RELEASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const POSITIVE_VERSION_PATTERN = /^[1-9][0-9]*$/;
const ARTIFACT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FRAMEWORKS = ["fetch", "elysia", "hono", "sveltekit-function"] as const;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FUNCTIONS = 128;
const RELEASE_OPERATION = "edge_functions.deploy_manifest";

type FunctionFramework = typeof FRAMEWORKS[number];
type FunctionCapabilities = {
    secrets?: string[];
    outbound_hosts?: string[];
    bindings?: string[];
    background?: boolean;
};
type FunctionLimits = {
    timeout_ms?: number;
    max_request_body_bytes?: number;
    max_response_body_bytes?: number;
    wait_until_timeout_ms?: number;
    max_heap_bytes?: number;
};
type ManifestEntry = {
    slug: string;
    entrypoint: string;
    verify_jwt?: boolean;
    bytecode?: "off" | "auto" | "required";
    background_routes?: string[];
    framework?: FunctionFramework;
    capabilities?: FunctionCapabilities;
    limits?: FunctionLimits;
};
type FunctionReleaseStatus = {
    project_ref: string;
    active_release_id: string | null;
    functions: Array<{ slug: string; version: string; activation_id: string }>;
};

function record(candidate: unknown): Record<string, unknown> | null {
    return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function requiredString(candidate: unknown, field: string): string {
    if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`Manifest field '${field}' is required`);
    return candidate.trim();
}

function optionalString(candidate: unknown, field: string): string | undefined {
    if (candidate === undefined) return undefined;
    return requiredString(candidate, field);
}

function validStringArray(candidate: unknown, field: string): string[] | undefined {
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || candidate.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error(`Manifest field '${field}' must be an array of strings`);
    }
    return candidate.map((value) => (value as string).trim());
}

function validObject(candidate: unknown, field: string): Record<string, unknown> | undefined {
    if (candidate === undefined) return undefined;
    const value = record(candidate);
    if (!value) throw new Error(`Manifest field '${field}' must be an object`);
    return value;
}

function functionCapabilities(candidate: unknown): FunctionCapabilities | undefined {
    const value = validObject(candidate, "capabilities");
    if (!value) return undefined;
    const result: FunctionCapabilities = {};
    for (const field of ["secrets", "outbound_hosts", "bindings"] as const) {
        const entries = value[field];
        if (entries === undefined) continue;
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
            throw new Error(`Manifest field 'capabilities.${field}' must be an array of strings`);
        }
        result[field] = entries.map((entry) => (entry as string).trim());
    }
    if (value.background !== undefined) {
        if (typeof value.background !== "boolean") throw new Error("Manifest field 'capabilities.background' must be boolean");
        result.background = value.background;
    }
    return result;
}

function functionLimits(candidate: unknown): FunctionLimits | undefined {
    const value = validObject(candidate, "limits");
    if (!value) return undefined;
    const result: FunctionLimits = {};
    for (const field of ["timeout_ms", "max_request_body_bytes", "max_response_body_bytes", "wait_until_timeout_ms", "max_heap_bytes"] as const) {
        const entry = value[field];
        if (entry === undefined) continue;
        if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1) {
            throw new Error(`Manifest field 'limits.${field}' must be a positive safe integer`);
        }
        result[field] = entry;
    }
    return result;
}

function parseManifest(path: string): ManifestEntry[] {
    const source = readFileSync(resolve(path), "utf8");
    if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES) throw new Error("Function release manifest exceeds 1 MiB");
    let parsed: unknown;
    try {
        parsed = JSON.parse(source) as unknown;
    } catch {
        throw new Error("Function release manifest must be valid JSON");
    }
    const root = record(parsed);
    const entries = root?.functions;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_FUNCTIONS) {
        throw new Error("Function release manifest must contain 1-128 functions");
    }
    const slugs = new Set<string>();
    return entries.map((candidate) => {
        const value = record(candidate);
        if (!value) throw new Error("Function release manifest contains an invalid function");
        const slug = requiredString(value.slug, "slug");
        if (!SAFE_SLUG_PATTERN.test(slug) || slug === "_project-release" || slugs.has(slug)) {
            throw new Error(`Function release manifest contains an invalid or duplicate slug '${slug}'`);
        }
        slugs.add(slug);
        const entrypoint = requiredString(value.entrypoint, "entrypoint");
        if (entrypoint.startsWith("/") || entrypoint.split(/[\\/]/u).includes("..")) {
            throw new Error(`Manifest entrypoint must stay within the project: ${entrypoint}`);
        }
        const framework = optionalString(value.framework, "framework");
        if (framework !== undefined && !FRAMEWORKS.includes(framework as FunctionFramework)) {
            throw new Error(`Manifest field 'framework' is invalid for '${slug}'`);
        }
        const bytecode = optionalString(value.bytecode, "bytecode");
        if (bytecode !== undefined && !["off", "auto", "required"].includes(bytecode)) {
            throw new Error(`Manifest field 'bytecode' is invalid for '${slug}'`);
        }
        if (value.verify_jwt !== undefined && typeof value.verify_jwt !== "boolean") {
            throw new Error(`Manifest field 'verify_jwt' must be boolean for '${slug}'`);
        }
        const verifyJwt = value.verify_jwt as boolean | undefined;
        const backgroundRoutes = validStringArray(value.backgroundRoutes ?? value.background_routes, "background_routes");
        const capabilities = functionCapabilities(value.capabilities);
        const limits = functionLimits(value.limits);
        return {
            slug,
            entrypoint,
            ...(verifyJwt === undefined ? {} : { verify_jwt: verifyJwt }),
            ...(bytecode === undefined ? {} : { bytecode: bytecode as ManifestEntry["bytecode"] }),
            ...(backgroundRoutes === undefined ? {} : { background_routes: backgroundRoutes }),
            ...(framework === undefined ? {} : { framework: framework as FunctionFramework }),
            ...(capabilities === undefined ? {} : { capabilities }),
            ...(limits === undefined ? {} : { limits }),
        };
    });
}

function projectPath(ref: string, suffix: string): string {
    return `/v1/projects/${projectRefPathSegment(ref, "Function release")}${suffix}`;
}

function validUuid(candidate: unknown): candidate is string {
    return typeof candidate === "string" && RELEASE_ID_PATTERN.test(candidate);
}

function positiveVersion(candidate: unknown): candidate is string {
    return typeof candidate === "string"
        && POSITIVE_VERSION_PATTERN.test(candidate)
        && Number.isSafeInteger(Number(candidate));
}

function parseReleaseStatus(payload: unknown, projectRef: string): FunctionReleaseStatus | null {
    const value = record(payload);
    if (!value || value.project_ref !== projectRef
        || (value.active_release_id !== null && !validUuid(value.active_release_id))
        || !Array.isArray(value.functions)) return null;
    const slugs = new Set<string>();
    const functions: FunctionReleaseStatus["functions"] = [];
    for (const candidate of value.functions) {
        const entry = record(candidate);
        if (!entry || typeof entry.slug !== "string" || !SAFE_SLUG_PATTERN.test(entry.slug)
            || slugs.has(entry.slug) || !positiveVersion(entry.version)
            || !validObservedFunctionActivationId(entry.activation_id)) return null;
        slugs.add(entry.slug);
        functions.push({
            slug: entry.slug,
            version: entry.version,
            activation_id: entry.activation_id,
        });
    }
    return {
        project_ref: projectRef,
        active_release_id: value.active_release_id as string | null,
        functions,
    };
}

function stageCodePath(entrypoint: string, bundlesDir: string | undefined, slug: string): string {
    if (bundlesDir) {
        const bundleRoot = resolve(bundlesDir);
        const candidate = join(bundleRoot, `${slug}.js`);
        if (!existsSync(candidate)) throw new Error(`Prebuilt Function bundle is missing: ${candidate}`);
        return candidate;
    }
    const projectRoot = process.cwd();
    const candidate = resolve(projectRoot, entrypoint);
    const relativePath = relative(projectRoot, candidate);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        throw new Error(`Manifest entrypoint must stay within the project: ${entrypoint}`);
    }
    if (!existsSync(candidate)) throw new Error(`Function entrypoint does not exist: ${candidate}`);
    return candidate;
}

async function bundleSource(entrypoint: string, bundlesDir: string | undefined, slug: string): Promise<string> {
    const sourcePath = stageCodePath(entrypoint, bundlesDir, slug);
    if (bundlesDir) return readFileSync(sourcePath, "utf8");
    const directory = mkdtempSync(join(tmpdir(), "supacloud-function-release-"));
    const output = join(directory, `${basename(sourcePath).replace(/\.[^.]+$/u, "") || "index"}.js`);
    try {
        const process = Bun.spawn(["bun", "build", sourcePath, "--target", "bun", "--outfile", output], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
        ]);
        if (exitCode !== 0) throw new Error(`Failed to bundle '${slug}': ${stderr || stdout}`);
        return readFileSync(output, "utf8");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function stageConfig(entry: ManifestEntry): Record<string, unknown> {
    return {
        ...(entry.verify_jwt === undefined ? {} : { verify_jwt: entry.verify_jwt }),
        ...(entry.bytecode === undefined ? {} : { bytecode: entry.bytecode }),
        ...(entry.background_routes === undefined ? {} : { background_routes: entry.background_routes }),
        ...(entry.framework === undefined ? {} : { framework: entry.framework }),
        ...(entry.capabilities === undefined ? {} : { capabilities: entry.capabilities }),
        ...(entry.limits === undefined ? {} : { limits: entry.limits }),
    };
}

function stagedVersion(payload: unknown): string | null {
    const value = record(payload);
    if (!value || !positiveVersion(value.version)
        || typeof value.artifact_sha256 !== "string"
        || !ARTIFACT_SHA256_PATTERN.test(value.artifact_sha256)) return null;
    return value.version;
}

type ExpectedReleaseMember = { slug: string; version: string };

function releaseReceipt(
    payload: unknown,
    projectRef: string,
    mutationId: string,
    expectedMembers: readonly ExpectedReleaseMember[],
): Record<string, unknown> | null {
    const value = record(payload);
    if (!value || value.project_ref !== projectRef
        || value.active_release_id !== mutationId || typeof value.generation !== "number"
        || !Number.isSafeInteger(value.generation) || value.generation < 1
        || !Array.isArray(value.functions) || value.functions.length !== expectedMembers.length) return null;
    const observed = new Map<string, { slug: string; version: string; activation_id: string }>();
    for (const candidate of value.functions) {
        const entry = record(candidate);
        if (!entry || typeof entry.slug !== "string" || !SAFE_SLUG_PATTERN.test(entry.slug)
            || observed.has(entry.slug) || !positiveVersion(entry.version)
            || !validObservedFunctionActivationId(entry.activation_id)) return null;
        observed.set(entry.slug, {
            slug: entry.slug,
            version: entry.version,
            activation_id: entry.activation_id,
        });
    }
    for (const expected of expectedMembers) {
        const actual = observed.get(expected.slug);
        if (!actual || actual.version !== expected.version) return null;
    }
    const mutation = record(value.mutation);
    if (!mutation || mutation.mutation_id !== mutationId || mutation.status !== "succeeded") return null;
    return {
        project_ref: projectRef,
        mutation_id: mutationId,
        active_release_id: mutationId,
        generation: value.generation,
        functions: [...observed.values()],
        mutation: { mutation_id: mutationId, status: "succeeded" },
    };
}

function requiredArg(args: Record<string, unknown>, name: string): string {
    const value = args[name];
    if (typeof value !== "string" || !value.trim()) throw new Error(`'--${name}' is required`);
    return value.trim();
}

export async function deployFunctionManifest(
    http: HttpTransport,
    args: Record<string, unknown>,
    options: { readOnly?: boolean } = {},
): Promise<ReleaseControlToolResponse> {
    if (options.readOnly) {
        return { isError: true, content: [{ type: "text", text: "⚠️ Edge Function release publication blocked in read-only mode." }] };
    }
    if (args.atomic !== true) throw new Error("'--atomic' is required for 'deploy_manifest'");
    const projectRef = requiredArg(args, "ref");
    const manifestPath = requiredArg(args, "manifest");
    const bundlesDir = typeof args["bundles-dir"] === "string" ? args["bundles-dir"].trim() : undefined;
    const mutationId = typeof args["mutation-id"] === "string" && args["mutation-id"].trim()
        ? args["mutation-id"].trim()
        : crypto.randomUUID();
    if (!validUuid(mutationId)) throw new Error("'--mutation-id' must be a UUIDv4");
    const entries = parseManifest(manifestPath);

    const statusResponse = await http.get(projectPath(projectRef, "/function-releases"), { maxJsonBytes: 256 * 1024 });
    const status = parseReleaseStatus(statusResponse.data, projectRef);
    if (!statusResponse.ok || !status) {
        return releaseControlFailure(RELEASE_OPERATION, "INVALID_RESPONSE", statusResponse.status, { project_ref: projectRef, mutation_id: mutationId });
    }

    const requested = new Map(entries.map((entry) => [entry.slug, entry]));
    const memberVersions = new Map(status.functions.map((entry) => [entry.slug, entry]));
    const staged: Array<{ slug: string; version: string; expected_activation_id: string }> = [];
    for (const entry of entries) {
        const identityResponse = await http.get(projectPath(projectRef, `/functions/${encodeURIComponent(entry.slug)}/config`), {
            maxJsonBytes: 128 * 1024,
        });
        const identity = projectedFunctionIdentity(identityResponse.data, projectRef, entry.slug);
        if (!identityResponse.ok || !identity) {
            return releaseControlFailure(RELEASE_OPERATION, "INVALID_RESPONSE", identityResponse.status, {
                project_ref: projectRef, mutation_id: mutationId, slug: entry.slug,
            });
        }
        const code = await bundleSource(entry.entrypoint, bundlesDir, entry.slug);
        const stageResponse = await http.postReleaseMutation(
            projectPath(projectRef, `/functions/${encodeURIComponent(entry.slug)}/stage`),
            { code, config: stageConfig(entry) },
            { timeoutMs: 5 * 60_000 },
        );
        const version = stagedVersion(stageResponse.data);
        if (!stageResponse.ok) {
            return releaseControlMutationFailure(RELEASE_OPERATION, stageResponse, {
                project_ref: projectRef, mutation_id: mutationId, slug: entry.slug,
            });
        }
        if (!version) {
            return releaseControlFailure(RELEASE_OPERATION, "OUTCOME_UNKNOWN", stageResponse.status, {
                project_ref: projectRef, mutation_id: mutationId, slug: entry.slug,
            });
        }
        staged.push({ slug: entry.slug, version, expected_activation_id: identity.activation_id });
    }

    const members = new Map(
        [...memberVersions.values()].map((member) => [
            member.slug,
            { slug: member.slug, version: member.version, expected_activation_id: member.activation_id },
        ] as const),
    );
    for (const member of staged) members.set(member.slug, member);
    const missing = [...memberVersions.keys()].filter((slug) => !requested.has(slug));
    const releaseResponse = await http.postReleaseMutation(
        projectPath(projectRef, "/function-releases"),
        {
            mutation_id: mutationId,
            expected_release_id: status.active_release_id,
            functions: [...members.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
        },
        { timeoutMs: 5 * 60_000 },
    );
    if (!releaseResponse.ok) {
        return releaseControlMutationFailure(RELEASE_OPERATION, releaseResponse, {
            project_ref: projectRef,
            mutation_id: mutationId,
            expected_release_id: status.active_release_id,
            staged_functions: staged.map(({ slug, version }) => ({ slug, version })),
            retained_functions: missing,
        });
    }
    const receipt = releaseReceipt(releaseResponse.data, projectRef, mutationId, [...members.values()]);
    if (!receipt) {
        return releaseControlFailure(RELEASE_OPERATION, "OUTCOME_UNKNOWN", releaseResponse.status, {
            project_ref: projectRef,
            mutation_id: mutationId,
            expected_release_id: status.active_release_id,
            staged_functions: staged.map(({ slug, version }) => ({ slug, version })),
            retained_functions: missing,
        });
    }
    return releaseControlSuccess(RELEASE_OPERATION, {
        ...receipt,
        expected_release_id: status.active_release_id,
        staged_functions: staged.map(({ slug, version }) => ({ slug, version })),
        retained_functions: missing,
    });
}
