/**
 * Advanced — Split into 3 compound tools: edge_functions, secrets, platform
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
    closeSync,
    constants as fsConstants,
    existsSync,
    fstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import { projectRefPathSegment } from "../project-ref";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

const execFileAsync = promisify(execFile);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type OpenFileIdentity = {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
};

function openFileIdentity(descriptor: number): OpenFileIdentity {
    const state = fstatSync(descriptor, { bigint: true });
    if (!state.isFile()) throw new Error("Prebundled path must be a regular file");
    return {
        dev: state.dev,
        ino: state.ino,
        size: state.size,
        mtimeNs: state.mtimeNs,
        ctimeNs: state.ctimeNs,
    };
}

function sameOpenFile(left: OpenFileIdentity, right: OpenFileIdentity): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

function verifiedUtf8Code(bytes: Buffer): string {
    let code: string;
    try {
        code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
        if (error instanceof TypeError) throw new Error("Prebundled file is not valid UTF-8");
        throw error;
    }
    if (!Buffer.from(code, "utf8").equals(bytes)) {
        throw new Error("Prebundled file does not round-trip as UTF-8");
    }
    return code;
}

function assertExpectedSha256(bytes: Buffer, expectedSha256: string): void {
    if (!SHA256_HEX_PATTERN.test(expectedSha256)) {
        throw new Error("'--expected-sha256' must be a lowercase 64-character SHA-256");
    }
    const actualDigest = createHash("sha256").update(bytes).digest();
    const expectedDigest = Buffer.from(expectedSha256, "hex");
    if (!timingSafeEqual(actualDigest, expectedDigest)) {
        throw new Error("Prebundled file SHA-256 does not match --expected-sha256");
    }
}

function readVerifiedPrebundledCode(pathArg: string, expectedSha256: string): string {
    const descriptor = openSync(resolve(pathArg), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
        const identityBeforeRead = openFileIdentity(descriptor);
        const bytes = readFileSync(descriptor);
        const identityAfterRead = openFileIdentity(descriptor);
        if (BigInt(bytes.byteLength) !== identityBeforeRead.size
            || !sameOpenFile(identityBeforeRead, identityAfterRead)) {
            throw new Error("Prebundled file changed while it was being read");
        }
        assertExpectedSha256(bytes, expectedSha256);
        return verifiedUtf8Code(bytes);
    } finally {
        closeSync(descriptor);
    }
}

async function runBunBuild(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
        return await execFileAsync("bun", ["build", ...args], { maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
        const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (e.code === "ENOENT") {
            throw new Error("Bun is required for local edge function bundling. Install Bun or use deploy_bundle with explicit files.");
        }
        throw error;
    }
}

async function bundleEdgeFunctionPath(pathArg: string): Promise<string> {
    const entrypoint = resolveEntrypoint(pathArg);
    const tmpDir = mkdtempSync(join(tmpdir(), "supacloud-edge-"));
    const outfile = join(tmpDir, `${basename(entrypoint).replace(/\.[^.]+$/, "") || "index"}.js`);
    try {
        const { stderr } = await runBunBuild([entrypoint, "--target", "bun", "--outfile", outfile]);
        if (!existsSync(outfile)) throw new Error(`Bundle failed: ${stderr}`);
        return readFileSync(outfile, "utf-8");
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

type PreparedDeployCode =
    | { code: string; prebundled: false }
    | { code: string; prebundled: true; expectedSha256: string };

function prebundledDeployCode(
    pathArg: string,
    expectedSha256: unknown,
    minify: unknown,
): PreparedDeployCode {
    if (typeof expectedSha256 !== "string") {
        throw new Error("'--expected-sha256' required with '--prebundled-path'");
    }
    if (minify !== undefined) {
        throw new Error("'--minify' cannot be combined with '--prebundled-path'");
    }
    return {
        code: readVerifiedPrebundledCode(pathArg, expectedSha256),
        prebundled: true,
        expectedSha256,
    };
}

async function preparedDeployCode(args: Record<string, unknown>): Promise<PreparedDeployCode> {
    const codeArg = args.code;
    const pathArg = args.path;
    const prebundledPath = args["prebundled-path"];
    const sources = [codeArg, pathArg, prebundledPath].filter((source) => source !== undefined);
    if (sources.length !== 1) {
        throw new Error("Exactly one of '--code', '--path', or '--prebundled-path' is required for 'deploy'");
    }
    if (typeof prebundledPath === "string") {
        return prebundledDeployCode(prebundledPath, args["expected-sha256"], args.minify);
    }
    if (args["expected-sha256"] !== undefined) {
        throw new Error("'--expected-sha256' requires '--prebundled-path'");
    }
    if (typeof codeArg === "string") return { code: codeArg, prebundled: false };
    if (typeof pathArg !== "string") throw new Error("Function deploy source is invalid");
    return bundledDeployCode(pathArg);
}

async function bundledDeployCode(pathArg: string): Promise<PreparedDeployCode> {
    try {
        return { code: await bundleEdgeFunctionPath(pathArg), prebundled: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to bundle/read path ${pathArg}: ${message}`);
    }
}

function rejectPrebundledFlagsOutsideDeploy(action: string, args: Record<string, unknown>): void {
    for (const flag of ["prebundled-path", "expected-sha256"]) {
        if (action !== "deploy" && args[flag] !== undefined) {
            throw new Error(`'--${flag}' is not supported for '${action}'`);
        }
    }
}

function resolveEntrypoint(pathArg: string): string {
    const resolved = resolve(pathArg);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return resolved;
    const entrypoint = join(resolved, "index.ts");
    if (!existsSync(entrypoint)) {
        throw new Error(`Directory provided but no index.ts found at ${entrypoint}`);
    }
    return entrypoint;
}

const INVALID_BACKGROUND_ROUTES_MESSAGE = "Invalid background_routes JSON array. Use a valid JSON array or comma-separated routes like /queue/*,/render/*.";

function parseBackgroundRoutes(value: string | string[]): unknown {
    if (Array.isArray(value)) return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith("[")) return trimmed.split(",").map((route) => route.trim()).filter(Boolean);
    try {
        const routes = JSON.parse(trimmed);
        if (Array.isArray(routes) && routes.some((route) => typeof route === "string" && route.trim().startsWith("["))) {
            throw new Error(INVALID_BACKGROUND_ROUTES_MESSAGE);
        }
        return routes;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error(INVALID_BACKGROUND_ROUTES_MESSAGE);
    }
}

const backgroundRoutesSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), Type.Array(Type.String())]),
    Type.Array(Type.String()),
    parseBackgroundRoutes,
));

const functionFilesRecordSchema = Type.Record(Type.String(), Type.String());

function parseFunctionFiles(input: string | Record<string, string>): unknown {
    if (typeof input !== "string") return input;
    try {
        return JSON.parse(input);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Invalid files JSON object");
    }
}

const functionFilesSchema = decodedSchema(
    Type.Union([Type.String(), functionFilesRecordSchema]),
    functionFilesRecordSchema,
    parseFunctionFiles,
);

function positiveFunctionVersion(input: unknown, label: string): string {
    if (typeof input !== "string" && typeof input !== "number") {
        throw new Error(`${label} must be a canonical positive safe integer`);
    }
    const version = String(input);
    if (!POSITIVE_FUNCTION_VERSION_PATTERN.test(version)
        || !Number.isSafeInteger(Number(version))) {
        throw new Error(`${label} must be a canonical positive safe integer`);
    }
    return version;
}

const POSITIVE_FUNCTION_VERSION_PATTERN = /^[1-9][0-9]*$/;
const SAFE_FUNCTION_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FUNCTION_ACTIVATION_ARGUMENTS = new Set([
    "action", "ref", "slug", "version", "expected-active-version",
]);
const functionVersionSchema = Type.Optional(decodedSchema(
    Type.Union([
        Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        Type.String({ pattern: POSITIVE_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
    ]),
    Type.String({ pattern: POSITIVE_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
    (input) => positiveFunctionVersion(input, "Function version"),
));

function parseExpectedActiveVersion(input: unknown): unknown {
    if (input === "absent") return input;
    return positiveFunctionVersion(input, "Expected active version");
}

const expectedActiveVersionSchema = Type.Optional(decodedSchema(
    Type.Union([
        Type.Literal("absent"),
        Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        Type.String({ pattern: POSITIVE_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
    ]),
    Type.Union([
        Type.Literal("absent"),
        Type.String({ pattern: POSITIVE_FUNCTION_VERSION_PATTERN.source, maxLength: 16 }),
    ]),
    parseExpectedActiveVersion,
));

const secretListSchema = Type.Array(Type.Object({ name: Type.String(), value: Type.String() }));
const ENVIRONMENT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const MAX_SECRET_COUNT = 1024;
const MAX_ENVIRONMENT_SECRET_BYTES = 24 * 1024;
const MAX_SECRET_JSON_BYTES = 1024 * 1024;
const INVALID_ENVIRONMENT_SECRET_NAMES_MESSAGE = "Environment secret names are invalid";
const INVALID_ENVIRONMENT_SECRET_VALUES_MESSAGE = "Environment secret values are missing or exceed safe limits";
const INVALID_SECRET_LIST_RESPONSE = "❌ Project secret list response is invalid";

type SecretEntry = { name: string; value: string };

function parseSecrets(value: string | Array<{ name: string; value: string }>): unknown {
    if (Array.isArray(value)) return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw new Error("Invalid secrets JSON array");
        }
    }
    return trimmed.split(",").map((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0) return { name: entry.trim(), value: "" };
        return {
            name: entry.slice(0, separator).trim(),
            value: entry.slice(separator + 1),
        };
    }).filter((entry) => entry.name);
}

const secretsSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), secretListSchema]),
    secretListSchema,
    parseSecrets,
));

function validEnvironmentSecretNames(names: string[]): boolean {
    if (names.length === 0 || names.length > MAX_SECRET_COUNT) return false;
    const uniqueNames = new Set<string>();
    for (const name of names) {
        if (!ENVIRONMENT_SECRET_NAME_PATTERN.test(name) || uniqueNames.has(name)) return false;
        uniqueNames.add(name);
    }
    return true;
}

function parseEnvironmentSecretNames(input: string): unknown {
    const names = input.split(",", MAX_SECRET_COUNT + 1).map((name) => name.trim());
    if (!validEnvironmentSecretNames(names)) {
        throw new Error(INVALID_ENVIRONMENT_SECRET_NAMES_MESSAGE);
    }
    return names;
}

const environmentSecretNamesSchema = Type.Optional(decodedSchema(
    Type.String(),
    Type.Array(Type.String({ pattern: ENVIRONMENT_SECRET_NAME_PATTERN.source }), {
        minItems: 1,
        maxItems: MAX_SECRET_COUNT,
        uniqueItems: true,
    }),
    parseEnvironmentSecretNames,
));

function jsonWithinSecretLimit(payload: unknown): boolean {
    try {
        const serializedPayload = JSON.stringify(payload);
        return serializedPayload !== undefined
            && Buffer.byteLength(serializedPayload) <= MAX_SECRET_JSON_BYTES;
    } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
    }
}

function maskedSecretEntry(candidate: unknown): SecretEntry | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const { name, value } = candidate as Record<string, unknown>;
    if (typeof name !== "string" || !ENVIRONMENT_SECRET_NAME_PATTERN.test(name)) return null;
    if (value !== "********") return null;
    return { name, value: "********" };
}

function projectedMaskedSecrets(payload: unknown): SecretEntry[] | null {
    if (!Array.isArray(payload) || payload.length > MAX_SECRET_COUNT) return null;
    if (!jsonWithinSecretLimit(payload)) return null;
    const secretNames = new Set<string>();
    const projectedSecrets: SecretEntry[] = [];
    for (const candidate of payload) {
        const secret = maskedSecretEntry(candidate);
        if (!secret || secretNames.has(secret.name)) return null;
        secretNames.add(secret.name);
        projectedSecrets.push(secret);
    }
    return projectedSecrets;
}

function secretsFromEnvironment(
    names: string[],
    environment: NodeJS.ProcessEnv,
): SecretEntry[] {
    const secrets = names.map((name) => {
        const secretValue = environment[name];
        if (typeof secretValue !== "string" || secretValue.length === 0
            || Buffer.byteLength(secretValue) > MAX_ENVIRONMENT_SECRET_BYTES) {
            throw new Error(INVALID_ENVIRONMENT_SECRET_VALUES_MESSAGE);
        }
        return { name, value: secretValue };
    });
    if (!jsonWithinSecretLimit(secrets)) {
        throw new Error(INVALID_ENVIRONMENT_SECRET_VALUES_MESSAGE);
    }
    return secrets;
}

function secretsForUpsert(
    inlineSecrets: SecretEntry[] | undefined,
    environmentNames: string[] | undefined,
    environment: NodeJS.ProcessEnv,
): SecretEntry[] {
    if (inlineSecrets !== undefined && environmentNames !== undefined) {
        throw new Error("'--from-env' cannot be combined with '--secrets'");
    }
    if (environmentNames !== undefined) {
        return secretsFromEnvironment(environmentNames, environment);
    }
    if (!inlineSecrets?.length) throw new Error("'secrets' array required");
    return inlineSecrets;
}

type EdgeFunctionConfigInput = {
    verify_jwt?: boolean;
    background_routes?: string[];
};

const INVALID_FUNCTION_LIST_RESPONSE = "❌ Edge Function list response is invalid";
const INVALID_FUNCTION_SOURCE_RESPONSE = "❌ Edge Function source response is invalid";

function invalidFunctionReadResponse(message: string): ReleaseControlToolResponse {
    return { isError: true, content: [{ type: "text", text: message }] };
}

function safeFunctionList(payload: unknown): Array<Record<string, unknown>> | null {
    if (!Array.isArray(payload)) return null;
    const functionSlugs = new Set<string>();
    for (const candidate of payload) {
        const edgeFunction = objectRecord(candidate);
        const slug = edgeFunction?.slug;
        const version = edgeFunction?.version;
        if (typeof slug !== "string" || !SAFE_FUNCTION_SLUG_PATTERN.test(slug)
            || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1
            || functionSlugs.has(slug)) return null;
        functionSlugs.add(slug);
    }
    return payload as Array<Record<string, unknown>>;
}

function functionListResponse(response: HttpResult<unknown>): ReleaseControlToolResponse {
    if (!response.ok) return invalidFunctionReadResponse(`❌ Failed (${response.status})`);
    const functions = safeFunctionList(response.data);
    return functions
        ? { content: [{ type: "text", text: JSON.stringify(functions, null, 2) }] }
        : invalidFunctionReadResponse(INVALID_FUNCTION_LIST_RESPONSE);
}

function confirmedFunctionConfig(payload: unknown, expected: EdgeFunctionConfigInput): boolean {
    const response = objectRecord(payload);
    if (!response) return false;
    if (expected.verify_jwt !== undefined && response.verify_jwt !== expected.verify_jwt) return false;
    if (expected.background_routes !== undefined) {
        if (!Array.isArray(response.background_routes)) return false;
        if (JSON.stringify(response.background_routes) !== JSON.stringify(expected.background_routes)) return false;
    }
    return true;
}

function functionSourceCode(payload: unknown, field: "code" | "source_code" = "code"): string | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const code = (payload as Record<string, unknown>)[field];
    return typeof code === "string" ? code : null;
}

function requestedSourceVersion(candidate: unknown): string | undefined {
    return candidate === undefined
        ? undefined
        : positiveFunctionVersion(candidate, "Function source version");
}

function functionSourceOutput(
    slug: string,
    sourceCode: string,
    output?: string,
): ReleaseControlToolResponse {
    if (!output) {
        return { content: [{ type: "text", text: JSON.stringify({ code: sourceCode }, null, 2) }] };
    }
    const outputPath = resolve(output);
    writeFileSync(outputPath, sourceCode, { flag: "wx" });
    return {
        content: [{
            type: "text",
            text: `✅ Function ${slug} source written to ${outputPath} (${Buffer.byteLength(sourceCode)} bytes)`,
        }],
    };
}

function objectRecord(candidate: unknown): Record<string, unknown> | null {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function edgeFunctionResourcePath(ref: unknown, slug?: unknown): string {
    const root = `/v1/projects/${projectRefPathSegment(ref, "Edge Functions")}/functions`;
    if (slug === undefined) return root;
    if (typeof slug !== "string" || !SAFE_FUNCTION_SLUG_PATTERN.test(slug)) {
        throw new Error("'slug' is invalid for Edge Functions");
    }
    return `${root}/${encodeURIComponent(slug)}`;
}

async function readFunctionSource(
    http: HttpTransport,
    request: { projectRef: unknown; slug: string; version?: unknown; output?: string },
): Promise<ReleaseControlToolResponse> {
    const sourceVersion = requestedSourceVersion(request.version);
    const resourcePath = edgeFunctionResourcePath(request.projectRef, request.slug);
    const sourcePath = sourceVersion === undefined
        ? `${resourcePath}/source`
        : `${resourcePath}/versions/${encodeURIComponent(sourceVersion)}`;
    const response = await http.get(sourcePath);
    if (!response.ok) return invalidFunctionReadResponse(`❌ Failed (${response.status})`);
    const sourceCode = functionSourceCode(
        response.data,
        sourceVersion === undefined ? "code" : "source_code",
    );
    return sourceCode === null
        ? invalidFunctionReadResponse(INVALID_FUNCTION_SOURCE_RESPONSE)
        : functionSourceOutput(request.slug, sourceCode, request.output);
}

interface FunctionMutationExpectation {
    operation: "edge_functions.deploy" | "edge_functions.deploy_bundle" | "edge_functions.activate";
    projectRef: string;
    slug: string;
    expectedActiveVersion: string;
    targetVersion?: string;
    config?: EdgeFunctionConfigInput;
}

interface ConfirmedFunctionMutation {
    activeVersion: string;
    verifyJwt: boolean;
}

function mutationIdentityMatches(
    receipt: Record<string, unknown>,
    expectation: FunctionMutationExpectation,
): boolean {
    return receipt.success === true
        && receipt.project_ref === expectation.projectRef
        && receipt.slug === expectation.slug
        && receipt.previous_active_version === expectation.expectedActiveVersion;
}

function validReceiptVersion(activeVersion: unknown): activeVersion is string {
    return typeof activeVersion === "string"
        && POSITIVE_FUNCTION_VERSION_PATTERN.test(activeVersion)
        && Number.isSafeInteger(Number(activeVersion));
}

function confirmedMutationVersion(
    receipt: Record<string, unknown>,
    config: Record<string, unknown>,
    expectation: FunctionMutationExpectation,
): string | null {
    const activeVersion = receipt.active_version;
    if (!validReceiptVersion(activeVersion)
        || receipt.version !== activeVersion
        || config.version !== activeVersion
        || (expectation.targetVersion !== undefined && activeVersion !== expectation.targetVersion)) {
        return null;
    }
    return activeVersion;
}

function confirmedFunctionMutation(
    expectation: FunctionMutationExpectation,
    payload: unknown,
): ConfirmedFunctionMutation | null {
    const receipt = objectRecord(payload);
    const config = objectRecord(receipt?.config);
    if (!receipt || !config || !mutationIdentityMatches(receipt, expectation)) return null;
    const activeVersion = confirmedMutationVersion(receipt, config, expectation);
    if (activeVersion === null
        || typeof config.verify_jwt !== "boolean"
        || !confirmedFunctionConfig(config, expectation.config ?? {})) return null;
    return { activeVersion, verifyJwt: config.verify_jwt };
}

function functionMutationResponse(
    expectation: FunctionMutationExpectation,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse {
    if (!response.ok) return releaseControlMutationFailure(expectation.operation, response);
    const confirmed = confirmedFunctionMutation(expectation, response.data);
    if (!confirmed) {
        return releaseControlFailure(expectation.operation, "OUTCOME_UNKNOWN", response.status);
    }
    return releaseControlSuccess(expectation.operation, {
        project_ref: expectation.projectRef,
        slug: expectation.slug,
        previous_active_version: expectation.expectedActiveVersion,
        active_version: confirmed.activeVersion,
        version: confirmed.activeVersion,
        verify_jwt: confirmed.verifyJwt,
    });
}

interface FunctionActivationTarget {
    projectRef: string;
    functionSlug: string;
    version: string;
    expectedActiveVersion: string;
}

function readOnlyActivationResult(): ReleaseControlToolResponse {
    return {
        isError: true,
        content: [{ type: "text", text: "⚠️ Edge Function activation blocked in read-only mode." }],
    };
}

function functionActivationTarget(args: Record<string, unknown>): FunctionActivationTarget {
    const projectRef = typeof args.ref === "string" ? args.ref.trim() : "";
    const functionSlug = typeof args.slug === "string" ? args.slug.trim() : "";
    const version = positiveFunctionVersion(args.version, "Function activation version");
    projectRefPathSegment(projectRef, "Edge Function activation");
    if (!SAFE_FUNCTION_SLUG_PATTERN.test(functionSlug)) throw new Error("'slug' is invalid for 'activate'");
    const expectedActiveVersion = requiredExpectedActiveVersion(args, "activate");
    return { projectRef, functionSlug, version, expectedActiveVersion };
}

function requiredExpectedActiveVersion(args: Record<string, unknown>, action: string): string {
    const expected = args["expected-active-version"];
    if (expected === undefined) {
        throw new Error(`'--expected-active-version' required for '${action}'`);
    }
    const parsed = parseExpectedActiveVersion(expected);
    if (typeof parsed !== "string") throw new Error("Expected active version is invalid");
    return parsed;
}

async function activateFunctionVersion(
    http: HttpTransport,
    args: Record<string, unknown>,
    readOnly = false,
): Promise<ReleaseControlToolResponse> {
    if (readOnly) return readOnlyActivationResult();
    const unsupported = Object.keys(args).filter((name) => !FUNCTION_ACTIVATION_ARGUMENTS.has(name));
    if (unsupported.length > 0) throw new Error(`'${unsupported[0]}' is not supported for 'activate'`);
    const { projectRef, functionSlug, version, expectedActiveVersion } = functionActivationTarget(args);
    const endpoint = edgeFunctionResourcePath(projectRef, functionSlug)
        + `/versions/${encodeURIComponent(version)}/activate`;
    return functionMutationResponse({
        operation: "edge_functions.activate",
        projectRef,
        slug: functionSlug,
        expectedActiveVersion,
        targetVersion: version,
    }, await http.post(endpoint, { expected_active_version: expectedActiveVersion }));
}

export function registerAdvancedTools(
    server: { tool: (...args: any[]) => void },
    http: HttpTransport,
    environment: NodeJS.ProcessEnv = process.env,
    options: { readOnly?: boolean } = {},
): void {

    // ═══ Edge Functions (8→1) ═══
    server.tool(
        "edge_functions",
        `Edge Function management (Deno/Bun serverless). Source deploys are bundled; verified prebuilt artifacts stay byte-exact.
Actions: list, deploy, deploy_bundle, config, source, activate, delete, check`,
        {
            action: withDescription(stringEnum(["list", "deploy", "deploy_bundle", "config", "source", "activate", "delete", "check"]), "Action"),
            ref: withDescription(Type.String(), "Project ref"),
            slug: optional(Type.String(), "[deploy/deploy_bundle/config/source/activate/delete/check] Function name"),
            version: withDescription(functionVersionSchema, "[source/activate] Existing immutable Function version; source requires a positive version"),
            code: optional(Type.String(), "[deploy/check] Function source code (TypeScript)"),
            path: optional(Type.String(), "[deploy/check] Local file path to read code from (alternative to code)"),
            "prebundled-path": optional(
                Type.String(),
                "[deploy] Prebuilt runtime bundle to upload without rebuilding; requires expected-sha256",
            ),
            "expected-sha256": optional(
                Type.String({ pattern: SHA256_HEX_PATTERN.source, minLength: 64, maxLength: 64 }),
                "[deploy] Required lowercase SHA-256 of the exact prebundled-path bytes",
            ),
            output: optional(Type.String(), "[source] Write source to this local file instead of stdout; the file must not already exist"),
            files: optional(functionFilesSchema, "[deploy_bundle] File map as a JSON object: { 'index.ts': '...', '_shared/x.ts': '...' }"),
            entrypoint: optional(Type.String(), "[deploy_bundle] Entrypoint file (default: index.ts)"),
            minify: optional(Type.Boolean(), "[deploy/deploy_bundle] Minify bundle"),
            verify_jwt: optional(Type.Boolean(), "[deploy/deploy_bundle/config] Set JWT verification for this function"),
            background_routes: withDescription(backgroundRoutesSchema, "[deploy/deploy_bundle/config] Background route paths; pass comma-separated or JSON array in CLI"),
            "expected-active-version": withDescription(
                expectedActiveVersionSchema,
                "[deploy/deploy_bundle/activate] Required current active version, or 'absent' when none exists",
            ),
        },
        async (args: any) => {
            if (args.action === "activate") return activateFunctionVersion(http, args, options.readOnly);
            const { action, ref, slug, path: pathArg, output, files, entrypoint, minify, verify_jwt, background_routes } = args;
            rejectPrebundledFlagsOutsideDeploy(action, args);
            const expectedActiveVersion = action === "deploy" || action === "deploy_bundle"
                ? requiredExpectedActiveVersion(args, action)
                : undefined;
            let code = args.code as string | undefined;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };

            let text: string;

            const functionConfig = (): EdgeFunctionConfigInput => ({
                ...(typeof verify_jwt === "boolean" ? { verify_jwt } : {}),
                ...(Array.isArray(background_routes) ? { background_routes } : {}),
            });

            const hasFunctionConfig = () => Object.keys(functionConfig()).length > 0;

            const updateFunctionConfig = async (): Promise<string> => {
                need("slug", slug);
                if (!hasFunctionConfig()) {
                    throw new Error("'verify_jwt' or 'background_routes' required for 'config'");
                }
                const cr = await http.patch(`${edgeFunctionResourcePath(ref, slug)}/config`, functionConfig());
                return cr.ok
                    ? `✅ Function ${slug} config updated\n${JSON.stringify(cr.data, null, 2)}`
                    : `❌ Config update failed (${cr.status}): ${JSON.stringify(cr.data)}`;
            };

            const checkSyntax = async (sourceCode: string): Promise<{ ok: boolean; err?: string }> => {
                const tmpDir = mkdtempSync(join(tmpdir(), "supacloud-edge-check-"));
                const tmpFile = join(tmpDir, "index.ts");
                writeFileSync(tmpFile, sourceCode);
                try {
                    await runBunBuild([tmpFile, "--external", "*"]);
                    return { ok: true };
                } catch (e: any) {
                    return { ok: false, err: `${e.stdout || ""}\n${e.stderr || e.message}` };
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            };

            if (action === "check" && pathArg && !code) {
                try {
                    code = await bundleEdgeFunctionPath(pathArg);
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`Failed to bundle/read path ${pathArg}: ${message}`);
                }
            }

            switch (action) {
                case "list":
                    return functionListResponse(await http.get(edgeFunctionResourcePath(ref)));
                case "check":
                    need("code (or path)", code);
                    const checkRes = await checkSyntax(code!);
                    if (checkRes.ok) {
                        text = `✅ Syntax check passed for function`;
                    } else {
                        text = `❌ Syntax check failed:\n${checkRes.err}`;
                    }
                    break;
                case "deploy":
                    need("slug", slug);
                    const deployCode = await preparedDeployCode(args);
                    if (!deployCode.prebundled) {
                        const deployCheck = await checkSyntax(deployCode.code);
                        if (!deployCheck.ok) {
                            text = `❌ Deployment aborted. Syntax check failed:\n${deployCheck.err}`;
                            break;
                        }
                    }
                    const deploymentResponse = await http.post(edgeFunctionResourcePath(ref, slug), {
                        code: deployCode.code,
                        ...(deployCode.prebundled
                            ? { prebundled: true, expected_sha256: deployCode.expectedSha256 }
                            : { minify }),
                        expected_active_version: expectedActiveVersion,
                        ...functionConfig(),
                    });
                    return functionMutationResponse({
                        operation: "edge_functions.deploy",
                        projectRef: ref,
                        slug,
                        expectedActiveVersion: expectedActiveVersion!,
                        config: functionConfig(),
                    }, deploymentResponse);
                case "deploy_bundle":
                    need("slug", slug); need("files", files);
                    const bundleResponse = await http.post(`${edgeFunctionResourcePath(ref, slug)}/bundle`, {
                        files,
                        entrypoint,
                        minify,
                        expected_active_version: expectedActiveVersion,
                        ...functionConfig(),
                    });
                    return functionMutationResponse({
                        operation: "edge_functions.deploy_bundle",
                        projectRef: ref,
                        slug,
                        expectedActiveVersion: expectedActiveVersion!,
                        config: functionConfig(),
                    }, bundleResponse);
                case "config":
                    text = await updateFunctionConfig();
                    break;
                case "source":
                    need("slug", slug);
                    return readFunctionSource(http, {
                        projectRef: ref,
                        slug,
                        version: args.version,
                        output,
                    });
                case "delete":
                    need("slug", slug);
                    text = (await http.delete(edgeFunctionResourcePath(ref, slug))).ok ? `✅ Function ${slug} deleted` : `❌ Failed`;
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Secrets (3→1) ═══
    server.tool(
        "secrets",
        `Project secrets (environment variables for Edge Functions).
Actions: list, upsert, delete`,
        {
            action: withDescription(stringEnum(["list", "upsert", "delete"]), "Action"),
            ref: withDescription(Type.String(), "Project ref"),
            secrets: withDescription(secretsSchema, "[upsert] Secret list as JSON array or KEY=VALUE,KEY2=VALUE2"),
            "from-env": withDescription(
                environmentSecretNamesSchema,
                "[upsert] Comma-separated environment variable names; values are read from this CLI process",
            ),
            name: optional(Type.String(), "[delete] Secret name to delete"),
        },
        async (args: any) => {
            const { action, ref, secrets, name } = args;
            const environmentNames = args["from-env"] as string[] | undefined;
            let text: string;
            switch (action) {
                case "list": {
                    const response = await http.get(`/v1/projects/${ref}/secrets`, {
                        maxResponseBytes: MAX_SECRET_JSON_BYTES,
                    });
                    if (!response.ok) {
                        text = `❌ Failed (${response.status})`;
                        break;
                    }
                    const maskedSecrets = projectedMaskedSecrets(response.data);
                    text = maskedSecrets === null
                        ? INVALID_SECRET_LIST_RESPONSE
                        : JSON.stringify(maskedSecrets, null, 2);
                    break;
                }
                case "upsert":
                    const secretsToUpsert = secretsForUpsert(secrets, environmentNames, environment);
                    text = (await http.post(`/v1/projects/${ref}/secrets`, secretsToUpsert)).ok
                        ? `✅ Updated ${secretsToUpsert.length} secrets` : `❌ Failed`;
                    break;
                case "delete":
                    if (!name) throw new Error("'name' required");
                    text = (await http.delete(`/v1/projects/${ref}/secrets/${name}`)).ok
                        ? `✅ Secret ${name} deleted` : `❌ Failed`;
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Platform (metrics + backup + network + org → 1) ═══
    server.tool(
        "platform",
        `Platform monitoring, backups, network, and organizations.
Actions: metrics, list_backups, create_backup, network, update_network, list_orgs, get_org`,
        {
            action: withDescription(stringEnum([
                "metrics", "list_backups", "create_backup",
                "network", "update_network",
                "list_orgs", "get_org",
            ]), "Action"),
            ref: optional(Type.String(), "Project ref (for backup/network actions)"),
            slug: optional(Type.String(), "[get_org] Organization slug"),
            allowed_cidrs: optional(Type.Array(Type.String()), "[update_network] Allowed CIDRs"),
        },
        async (args: any) => {
            const { action, ref, slug, allowed_cidrs } = args;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };
            let text: string;
            switch (action) {
                case "metrics":
                    text = JSON.stringify((await http.get("/v1/monitor/system")).data, null, 2);
                    break;
                case "list_backups":
                    need("ref", ref);
                    text = JSON.stringify((await http.get(`/v1/projects/${ref}/database/backups`)).data, null, 2);
                    break;
                case "create_backup": {
                    need("ref", ref);
                    const r = await http.post(`/v1/projects/${ref}/database/backups`);
                    text = r.ok ? `✅ Backup created\n${JSON.stringify(r.data, null, 2)}` : `❌ Failed (${r.status})`;
                    break;
                }
                case "network":
                    need("ref", ref);
                    text = JSON.stringify((await http.get(`/v1/projects/${ref}/network-restrictions`)).data, null, 2);
                    break;
                case "update_network":
                    need("ref", ref); if (!allowed_cidrs) throw new Error("'allowed_cidrs' required");
                    text = (await http.put(`/v1/projects/${ref}/network-restrictions`, { allowedCidrs: allowed_cidrs })).ok
                        ? `✅ Network restrictions updated` : `❌ Failed`;
                    break;
                case "list_orgs":
                    text = JSON.stringify((await http.get("/v1/organizations")).data, null, 2);
                    break;
                case "get_org":
                    need("slug", slug);
                    text = JSON.stringify((await http.get(`/v1/organizations/${slug}`)).data, null, 2);
                    break;
                default: text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Task Events (3→1) ═══
    server.tool(
        "task_events",
        `Task lifecycle webhook configuration.
Actions: register_webhook, unregister_webhook, inspect_webhook`,
        {
            action: withDescription(stringEnum(["register_webhook", "unregister_webhook", "inspect_webhook"]), "Action"),
            ref: withDescription(Type.String(), "Project ref"),
            url: optional(Type.String(), "[register_webhook] HTTPS webhook URL for task lifecycle events"),
            secret: optional(Type.String(), "[register_webhook] Optional HMAC secret for webhook verification"),
        },
        async (args: any) => {
            const { action, ref, url, secret } = args;
            let text: string;
            switch (action) {
                case "register_webhook": {
                    if (!url) throw new Error("'url' is required for register_webhook");
                    const body: Record<string, unknown> = { url };
                    if (secret) body.secret = secret;
                    const r = await http.post(`/v1/projects/${ref}/task-events/webhook`, body);
                    text = r.ok
                        ? `✅ Webhook registered for project ${ref}\n${JSON.stringify(r.data, null, 2)}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "unregister_webhook": {
                    const r = await http.delete(`/v1/projects/${ref}/task-events/webhook`);
                    text = r.ok
                        ? `✅ Webhook unregistered for project ${ref}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "inspect_webhook": {
                    const r = await http.get(`/v1/projects/${ref}/task-events/webhook`);
                    text = r.ok
                        ? JSON.stringify(r.data, null, 2)
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                default:
                    text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );

    // ═══ Diagnostics (4→1) ═══
    server.tool(
        "diagnostics",
        `Platform and project diagnostics: health checks, diagnostic runs, and repair.
Actions: list_checks, run_checks, get_run, repair`,
        {
            action: withDescription(stringEnum(["list_checks", "run_checks", "get_run", "repair"]), "Action"),
            ref: optional(Type.String(), "Project ref (for project-scoped diagnostics)"),
            run_id: optional(Type.String(), "[get_run/repair] Diagnostic run ID"),
            check_id: optional(Type.String(), "[repair] Check result ID to repair"),
        },
        async (args: any) => {
            const { action, ref, run_id, check_id } = args;
            let text: string;
            switch (action) {
                case "list_checks": {
                    const path = ref
                        ? `/v1/projects/${ref}/diagnostics/checks`
                        : "/v1/diagnostics/checks";
                    text = JSON.stringify((await http.get(path)).data, null, 2);
                    break;
                }
                case "run_checks": {
                    const path = ref
                        ? `/v1/projects/${ref}/diagnostics/runs`
                        : "/v1/diagnostics/runs";
                    const r = await http.post(path);
                    text = r.ok
                        ? `✅ Diagnostic run started\n${JSON.stringify(r.data, null, 2)}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                case "get_run": {
                    if (!run_id) throw new Error("'run_id' is required for get_run");
                    const path = ref
                        ? `/v1/projects/${ref}/diagnostics/runs/${run_id}`
                        : `/v1/diagnostics/runs/${run_id}`;
                    text = JSON.stringify((await http.get(path)).data, null, 2);
                    break;
                }
                case "repair": {
                    if (!check_id) throw new Error("'check_id' is required for repair");
                    const path = `/v1/diagnostics/results/${check_id}/repair`;
                    const r = await http.post(path);
                    text = r.ok
                        ? `✅ Repair executed for ${check_id}\n${JSON.stringify(r.data, null, 2)}`
                        : `❌ Failed (${r.status}): ${JSON.stringify(r.data)}`;
                    break;
                }
                default:
                    text = `❌ Unknown action`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
