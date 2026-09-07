import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import { releaseControlFailure, releaseControlSuccess, type ReleaseControlToolResponse } from "./release-control-response";
import { PROJECT_ENDPOINT_RESPONSE_MAX_BYTES, projectApiOrigins } from "./project-endpoint-read";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>,
    ) => void;
};

type ReleaseOperation =
    | "release.logical_backup.list"
    | "release.logical_backup.create"
    | "release.logical_backup.restore"
    | "release.postgrest.status"
    | "release.postgrest.restart"
    | "release.release_canary.fixture_stage_replay"
    | "release.release_canary.fixture_disable_replay"
    | "release.scope_inspect"
    | "release.scope_rebind"
    | "release.scope_create";

type ReleaseCanaryStageReceipt = {
    fixtureId: string;
    tenantKey: string;
    state: "staged";
    idempotent: true;
};

type ReleaseCanaryDisableReceipt = {
    fixtureId: string;
    state: "disabled";
    idempotent: boolean;
};

type VerifiedLogicalBackup = {
    backup_id: string;
    project_ref: string;
    database: string;
    kind: "logical-full";
    created_at: string;
    completed_at: string;
    bytes: number;
    sha256: string;
};

type ReleasePostgrestStatus = {
    desired: "running" | "stopped";
    actual: "running" | "stopped" | "starting" | "error";
    health: "healthy" | "unhealthy" | "unknown";
};

const SAFE_PROJECT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_ID = /^logical-full_[A-Za-z0-9_-]{1,64}_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_DATABASE = /^[^\u0000-\u001f\u007f]{1,128}$/;
const INVENTORY_MAX_BYTES = 1024 * 1024;
const MUTATION_MAX_BYTES = 64 * 1024;
const BACKUP_TIMEOUT_MS = 36 * 60_000;
const RELEASE_READ_RESPONSE_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_CANARY_TENANT_KEY = /^release-canary-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_CANARY_STAGE_RECEIPT_KEYS = new Set(["fixtureId", "tenantKey", "state", "idempotent"]);
const RELEASE_CANARY_DISABLE_RECEIPT_KEYS = new Set(["fixtureId", "state", "idempotent"]);
const RELEASE_CANARY_DISABLE_RPC_PATH = "/rest/v1/rpc/fa_release_canary_fixture_disable";
const RELEASE_CANARY_PENDING_RPC_PATH = "/rest/v1/rpc/fa_release_canary_fixture_pending";
const RELEASE_CANARY_CLAIM_MAX_LENGTH = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validProjectRef(ref: string): boolean {
    return SAFE_PROJECT_REF.test(ref);
}

function backupBelongsToProject(backupId: string, projectRef: string): boolean {
    return BACKUP_ID.test(backupId) && backupId.startsWith(`logical-full_${projectRef}_`);
}

function verifiedBackup(value: unknown, projectRef: string): VerifiedLogicalBackup | null {
    if (!isRecord(value)
        || typeof value.backup_id !== "string"
        || !backupBelongsToProject(value.backup_id, projectRef)
        || value.project_ref !== projectRef
        || typeof value.database !== "string"
        || !SAFE_DATABASE.test(value.database)
        || value.kind !== "logical-full"
        || !canonicalTimestamp(value.created_at)
        || !canonicalTimestamp(value.completed_at)
        || new Date(value.completed_at).valueOf() < new Date(value.created_at).valueOf()
        || typeof value.bytes !== "number"
        || !Number.isSafeInteger(value.bytes)
        || value.bytes <= 0
        || typeof value.sha256 !== "string"
        || !SHA256.test(value.sha256)) return null;
    return {
        backup_id: value.backup_id,
        project_ref: projectRef,
        database: value.database,
        kind: "logical-full",
        created_at: value.created_at,
        completed_at: value.completed_at,
        bytes: value.bytes,
        sha256: value.sha256,
    };
}

function backupInventory(value: unknown, projectRef: string): VerifiedLogicalBackup[] | null {
    if (!isRecord(value) || !Array.isArray(value.backups)) return null;
    const backups = value.backups.map((backup) => verifiedBackup(backup, projectRef));
    if (backups.some((backup) => backup === null)) return null;
    const inventory = backups as VerifiedLogicalBackup[];
    return new Set(inventory.map((backup) => backup.backup_id)).size === inventory.length
        ? inventory
        : null;
}

function publicBackup(backup: VerifiedLogicalBackup) {
    return {
        backup_id: backup.backup_id,
        project_ref: backup.project_ref,
        kind: backup.kind,
        created_at: backup.created_at,
        completed_at: backup.completed_at,
        bytes: backup.bytes,
        sha256: backup.sha256,
    };
}

function equalBackup(left: VerifiedLogicalBackup, right: VerifiedLogicalBackup): boolean {
    return left.backup_id === right.backup_id
        && left.project_ref === right.project_ref
        && left.database === right.database
        && left.kind === right.kind
        && left.created_at === right.created_at
        && left.completed_at === right.completed_at
        && left.bytes === right.bytes
        && left.sha256 === right.sha256;
}

function newlyCreatedBackup(
    before: readonly VerifiedLogicalBackup[],
    after: readonly VerifiedLogicalBackup[],
): VerifiedLogicalBackup | null {
    const afterById = new Map(after.map((backup) => [backup.backup_id, backup]));
    for (const previous of before) {
        const current = afterById.get(previous.backup_id);
        if (!current || !equalBackup(previous, current)) return null;
    }
    const known = new Set(before.map((backup) => backup.backup_id));
    const additions = after.filter((backup) => !known.has(backup.backup_id));
    return additions.length === 1 ? additions[0]! : null;
}

function restoreRequest(
    projectRef: string,
    backupId: unknown,
    expectedSha256: unknown,
    restoreConfirmation: unknown,
): { backup_id: string; expected_sha256: string; confirmation: string } {
    if (typeof backupId !== "string" || !backupBelongsToProject(backupId, projectRef)) {
        throw new Error("'backup_id' must identify a logical-full backup for 'ref'");
    }
    if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
        throw new Error("'expected_sha256' must be a lowercase SHA-256 digest");
    }
    const confirmation = `RESTORE_PROJECT:${projectRef}:${backupId}:${expectedSha256}`;
    if (restoreConfirmation !== confirmation) {
        throw new Error("'restore_confirmation' must exactly confirm the selected logical backup restore");
    }
    return { backup_id: backupId, expected_sha256: expectedSha256, confirmation };
}

function endpoint(projectRef: string): string {
    if (!validProjectRef(projectRef)) throw new Error("'ref' is invalid for release controls");
    return `/v1/projects/${encodeURIComponent(projectRef)}`;
}

function httpFailure(operation: ReleaseOperation, response: HttpResult<unknown>): ReleaseControlToolResponse {
    if (response.responseReadError) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", response.status);
    }
    return releaseControlFailure(operation, "HTTP_ERROR", response.transportError ? null : response.status);
}

function mutationFailure(operation: ReleaseOperation, response: HttpResult<unknown>): ReleaseControlToolResponse {
    if (response.responseReadError || response.transportError || response.status === 408 || response.status >= 500) {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.transportError ? null : response.status);
    }
    return releaseControlFailure(operation, "HTTP_ERROR", response.status);
}

async function readInventory(
    http: HttpTransport,
    projectRef: string,
): Promise<{ response: HttpResult<unknown>; inventory: VerifiedLogicalBackup[] | null }> {
    const response = await http.get(`${endpoint(projectRef)}/database/backups/logical`, {
        maxJsonBytes: INVENTORY_MAX_BYTES,
        responseTimeoutMs: RELEASE_READ_RESPONSE_TIMEOUT_MS,
    });
    return { response, inventory: response.ok && response.status === 200 ? backupInventory(response.data, projectRef) : null };
}

function readInventoryFailure(
    operation: ReleaseOperation,
    read: { response: HttpResult<unknown>; inventory: VerifiedLogicalBackup[] | null },
): ReleaseControlToolResponse | null {
    if (!read.response.ok) return httpFailure(operation, read.response);
    if (read.response.status !== 200 || !read.inventory) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", read.response.status);
    }
    return null;
}

function postgrestStatus(value: unknown): ReleasePostgrestStatus | null {
    if (!isRecord(value)
        || value.component !== "postgrest"
        || !["running", "stopped"].includes(String(value.desired))
        || !["running", "stopped", "starting", "error"].includes(String(value.actual))
        || !["healthy", "unhealthy", "unknown"].includes(String(value.health))) return null;
    return {
        desired: value.desired as ReleasePostgrestStatus["desired"],
        actual: value.actual as ReleasePostgrestStatus["actual"],
        health: value.health as ReleasePostgrestStatus["health"],
    };
}

async function readPostgrestStatus(
    http: HttpTransport,
    projectRef: string,
): Promise<{ response: HttpResult<unknown>; status: ReleasePostgrestStatus | null }> {
    const response = await http.get(`${endpoint(projectRef)}/services/postgrest/status`, {
        maxJsonBytes: MUTATION_MAX_BYTES,
        responseTimeoutMs: RELEASE_READ_RESPONSE_TIMEOUT_MS,
    });
    return { response, status: response.ok && response.status === 200 ? postgrestStatus(response.data) : null };
}

function readPostgrestFailure(
    operation: ReleaseOperation,
    read: { response: HttpResult<unknown>; status: ReleasePostgrestStatus | null },
): ReleaseControlToolResponse | null {
    if (!read.response.ok) return httpFailure(operation, read.response);
    return read.response.status === 200 && read.status
        ? null
        : releaseControlFailure(operation, "INVALID_RESPONSE", read.response.status);
}

function isRestartReceipt(value: unknown): boolean {
    return isRecord(value)
        && value.service === "postgrest"
        && value.action === "restart"
        && value.success === true;
}

function releaseCanaryStageInput(subject: unknown, requestId: unknown): { p_subject: string; p_request_id: string } {
    if (typeof subject !== "string" || !UUID.test(subject)) throw new Error("'subject' must be a canonical UUID");
    if (typeof requestId !== "string" || !UUID.test(requestId)) throw new Error("'request_id' must be a canonical UUID");
    return { p_subject: subject, p_request_id: requestId };
}

function releaseCanaryStageReceipt(value: unknown): ReleaseCanaryStageReceipt | null {
    if (!isRecord(value)
        || Object.keys(value).some((key) => !RELEASE_CANARY_STAGE_RECEIPT_KEYS.has(key))
        || Object.keys(value).length !== RELEASE_CANARY_STAGE_RECEIPT_KEYS.size
        || typeof value.fixtureId !== "string"
        || !UUID.test(value.fixtureId)
        || typeof value.tenantKey !== "string"
        || !RELEASE_CANARY_TENANT_KEY.test(value.tenantKey)
        || value.state !== "staged"
        || value.idempotent !== true) return null;
    return {
        fixtureId: value.fixtureId,
        tenantKey: value.tenantKey,
        state: "staged",
        idempotent: true,
    };
}

function releaseCanaryIssuer(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > RELEASE_CANARY_CLAIM_MAX_LENGTH
        || value !== value.trim()
        || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error("'issuer' must be a bounded absolute HTTP(S) issuer");
    }
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("'issuer' must be a bounded absolute HTTP(S) issuer");
    }
    const loopbackHttp = parsed.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
        && parsed.port.length > 0;
    if ((parsed.protocol !== "https:" && !loopbackHttp)
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash) {
        throw new Error("'issuer' must be a bounded absolute HTTP(S) issuer");
    }
    return value;
}

function releaseCanaryDisableInput(
    fixtureId: unknown,
    disableRequestId: unknown,
    issuer: unknown,
    subject: unknown,
): { p_fixture_id: string; p_disable_request_id: string; p_issuer: string; p_subject: string } {
    if (typeof fixtureId !== "string" || !UUID.test(fixtureId)) {
        throw new Error("'fixture_id' must be a canonical UUID");
    }
    if (typeof disableRequestId !== "string" || !UUID.test(disableRequestId)) {
        throw new Error("'disable_request_id' must be a canonical UUID");
    }
    if (typeof subject !== "string" || !UUID.test(subject)) {
        throw new Error("'subject' must be a canonical UUID");
    }
    return {
        p_fixture_id: fixtureId,
        p_disable_request_id: disableRequestId,
        p_issuer: releaseCanaryIssuer(issuer),
        p_subject: subject,
    };
}

function releaseCanaryDisableReceipt(receiptCandidate: unknown, fixtureId: string): ReleaseCanaryDisableReceipt | null {
    if (!isRecord(receiptCandidate)
        || Object.keys(receiptCandidate).some((key) => !RELEASE_CANARY_DISABLE_RECEIPT_KEYS.has(key))
        || Object.keys(receiptCandidate).length !== RELEASE_CANARY_DISABLE_RECEIPT_KEYS.size
        || receiptCandidate.fixtureId !== fixtureId
        || receiptCandidate.state !== "disabled"
        || typeof receiptCandidate.idempotent !== "boolean") return null;
    return { fixtureId, state: "disabled", idempotent: receiptCandidate.idempotent };
}

function releaseCanaryPendingPath(request: {
    p_issuer: string;
    p_subject: string;
}): string {
    const params = new URLSearchParams({
        p_issuer: request.p_issuer,
        p_subject: request.p_subject,
    });
    return `${RELEASE_CANARY_PENDING_RPC_PATH}?${params.toString()}`;
}

function releaseCanaryPendingReadback(readbackCandidate: unknown): boolean {
    return readbackCandidate === false;
}

async function applicationOriginMatches(http: HttpTransport, projectRef: string, applicationOrigin: string): Promise<boolean> {
    const endpointRead = await http.get(
        `${endpoint(projectRef)}/endpoint/projection`,
        { maxJsonBytes: PROJECT_ENDPOINT_RESPONSE_MAX_BYTES, responseTimeoutMs: RELEASE_READ_RESPONSE_TIMEOUT_MS },
    );
    return projectApiOrigins(endpointRead, projectRef)?.includes(applicationOrigin) === true;
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]));
}

function genericScopedReleaseScopeJson(scope: unknown): string {
    return JSON.stringify(canonicalValue(scope));
}

function genericScopedReleaseScopeSha256(scope: unknown): string {
    return createHash("sha256").update(genericScopedReleaseScopeJson(scope)).digest("hex");
}

function resolveGitBaseCommit(cwd: string, explicitRef?: unknown): string {
    if (typeof explicitRef === "string" && explicitRef.trim()) {
        const trimmed = explicitRef.trim();
        if (/^[0-9a-f]{40}$/.test(trimmed)) {
            try {
                const verified = execFileSync("git", ["rev-parse", "--verify", `${trimmed}^{commit}`], {
                    cwd,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                }).trim();
                if (/^[0-9a-f]{40}$/.test(verified)) return verified;
            } catch {
                return trimmed;
            }
            return trimmed;
        }
        try {
            const sha = execFileSync("git", ["rev-parse", "--verify", `${trimmed}^{commit}`], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            if (/^[0-9a-f]{40}$/.test(sha)) return sha;
        } catch {
            throw new Error(`Unable to resolve base commit from git ref '${trimmed}'`);
        }
    }
    const candidateRefs = ["origin/main", "main", "HEAD^", "HEAD"];
    for (const candidate of candidateRefs) {
        try {
            const sha = execFileSync("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            if (/^[0-9a-f]{40}$/.test(sha)) return sha;
        } catch {
            continue;
        }
    }
    throw new Error("Unable to resolve git base commit. Pass --base_commit explicitly.");
}

function gitCommitInfo(cwd: string): { head: string | null; originMain: string | null; parent: string | null } {
    let head: string | null = null;
    let originMain: string | null = null;
    let parent: string | null = null;
    try {
        head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {}
    try {
        originMain = execFileSync("git", ["rev-parse", "--verify", "origin/main^{commit}"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {}
    try {
        parent = execFileSync("git", ["rev-parse", "HEAD^"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {}
    return { head, originMain, parent };
}

function collectScopeFiles(
    cwd: string,
    file?: unknown,
    files?: unknown,
    dir?: unknown,
    task?: unknown,
): string[] {
    const results: string[] = [];
    const resolvePathWithFallbacks = (filePath: string): string => {
        const trimmed = filePath.trim();
        const resolved = resolve(cwd, trimmed);
        if (existsSync(resolved)) return resolved;
        const candidates = [
            resolve(cwd, "supacloud/fa/release-scopes", trimmed),
            resolve(cwd, "release-scopes", trimmed),
            resolve(cwd, "scopes", trimmed),
        ];
        const found = candidates.find(existsSync);
        if (found) return found;
        throw new Error(`Scope file not found: ${filePath}`);
    };
    if (typeof file === "string" && file.trim()) {
        results.push(resolvePathWithFallbacks(file));
    }
    if (typeof files === "string" && files.trim()) {
        const parts = files.split(",").map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
            results.push(resolvePathWithFallbacks(part));
        }
    }
    if (results.length > 0) {
        return [...new Set(results)];
    }

    const taskFilter = typeof task === "string" && task.trim() ? task.trim().toLowerCase() : null;
    if (!taskFilter && (!dir || typeof dir !== "string" || !dir.trim())) {
        throw new Error("At least one of --file, --files, or --task is required for scope_rebind");
    }

    const candidates = typeof dir === "string" && dir.trim()
        ? [resolve(cwd, dir.trim())]
        : [
            resolve(cwd, "supacloud/fa/release-scopes"),
            resolve(cwd, "release-scopes"),
            resolve(cwd, "scopes"),
        ];

    for (const directory of candidates) {
        if (existsSync(directory)) {
            try {
                const entries = readdirSync(directory, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith(".json")) {
                        const fullPath = join(directory, entry.name);
                        if (!taskFilter) {
                            results.push(fullPath);
                        } else if (entry.name.toLowerCase().includes(taskFilter)) {
                            results.push(fullPath);
                        } else {
                            try {
                                const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
                                if (typeof parsed?.taskId === "string" && parsed.taskId.toLowerCase() === taskFilter) {
                                    results.push(fullPath);
                                }
                            } catch {}
                        }
                    }
                }
                if (results.length > 0) break;
            } catch {}
        }
    }
    if (results.length === 0) {
        throw new Error("No release scope files found to rebind");
    }
    return [...new Set(results)];
}

interface ScopeRebindItem {
    file: string;
    task_id: string;
    target_project_ref: string;
    previous_base_commit: string;
    new_base_commit: string;
    scope_sha256: string;
    updated: boolean;
}

function handleScopeRebind(args: Record<string, unknown>): ReleaseControlToolResponse {
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? resolve(args.cwd.trim()) : process.cwd();
    const targetBaseCommit = resolveGitBaseCommit(cwd, args.base_commit);
    const scopeFiles = collectScopeFiles(cwd, args.file, args.files, args.dir, args.task);
    const dryRun = args.dry_run === true;

    const scopes: ScopeRebindItem[] = [];
    for (const filePath of scopeFiles) {
        let content: string;
        try {
            content = readFileSync(filePath, "utf8");
        } catch (cause) {
            throw new Error(`Failed to read scope file '${filePath}': ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new Error(`Scope file '${filePath}' is not valid JSON`);
        }
        if (!isRecord(parsed) || typeof parsed.baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(parsed.baseCommit)) {
            throw new Error(`Scope file '${filePath}' has missing or invalid baseCommit`);
        }
        const previousBaseCommit = parsed.baseCommit;
        const updated = previousBaseCommit !== targetBaseCommit;
        if (updated) {
            parsed.baseCommit = targetBaseCommit;
        }
        const canonicalJson = genericScopedReleaseScopeJson(parsed);
        const scopeSha256 = genericScopedReleaseScopeSha256(parsed);
        if (updated && !dryRun) {
            const formatted = JSON.stringify(canonicalValue(parsed), null, 2) + "\n";
            writeFileSync(filePath, formatted, "utf8");
        }
        scopes.push({
            file: relative(cwd, filePath),
            task_id: typeof parsed.taskId === "string" ? parsed.taskId : "",
            target_project_ref: typeof parsed.targetProjectRef === "string" ? parsed.targetProjectRef : "",
            previous_base_commit: previousBaseCommit,
            new_base_commit: targetBaseCommit,
            scope_sha256: scopeSha256,
            updated,
        });
    }

    return releaseControlSuccess("release.scope_rebind", {
        base_commit: targetBaseCommit,
        dry_run: dryRun,
        count: scopes.length,
        updated_count: scopes.filter((s) => s.updated).length,
        scopes,
    });
}

function handleScopeInspect(args: Record<string, unknown>): ReleaseControlToolResponse {
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? resolve(args.cwd.trim()) : process.cwd();
    if (typeof args.file !== "string" || !args.file.trim()) {
        throw new Error("'file' is required for scope_inspect");
    }
    const trimmed = args.file.trim();
    let filePath = resolve(cwd, trimmed);
    if (!existsSync(filePath)) {
        const candidates = [
            resolve(cwd, "supacloud/fa/release-scopes", trimmed),
            resolve(cwd, "release-scopes", trimmed),
            resolve(cwd, "scopes", trimmed),
        ];
        const found = candidates.find(existsSync);
        if (found) filePath = found;
        else throw new Error(`Scope file not found: ${args.file}`);
    }
    let content: string;
    try {
        content = readFileSync(filePath, "utf8");
    } catch (cause) {
        throw new Error(`Failed to read scope file '${args.file}': ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error(`Scope file '${args.file}' is not valid JSON`);
    }
    if (!isRecord(parsed) || typeof parsed.baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(parsed.baseCommit)) {
        throw new Error(`Scope file '${args.file}' has missing or invalid baseCommit`);
    }
    const scopeSha256 = genericScopedReleaseScopeSha256(parsed);
    const git = gitCommitInfo(cwd);

    return releaseControlSuccess("release.scope_inspect", {
        file: relative(cwd, filePath),
        scope: {
            task_id: parsed.taskId,
            target_project_ref: parsed.targetProjectRef,
            base_commit: parsed.baseCommit,
            functions: parsed.functions,
            excluded_functions: parsed.excludedFunctions,
            migrations: parsed.migrations,
            deferred_migrations: parsed.deferredMigrations,
            baseline_migrations: parsed.baselineMigrations,
            web: parsed.web,
            scope_sha256: scopeSha256,
        },
        git: {
            matches_head: git.head !== null && parsed.baseCommit === git.head,
            matches_origin_main: git.originMain !== null && parsed.baseCommit === git.originMain,
            matches_parent: git.parent !== null && parsed.baseCommit === git.parent,
            current_head: git.head,
            origin_main: git.originMain,
        },
    });
}

function parseCommaList(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return [...new Set(value.map(String).map((s) => s.trim()).filter(Boolean))].sort();
    }
    if (typeof value === "string") {
        return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))].sort();
    }
    return [];
}

function handleScopeCreate(args: Record<string, unknown>, fallbackRef?: string): ReleaseControlToolResponse {
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? resolve(args.cwd.trim()) : process.cwd();
    if (typeof args.file !== "string" || !args.file.trim()) {
        throw new Error("'file' is required for scope_create");
    }
    if (typeof args.task !== "string" || !args.task.trim()) {
        throw new Error("'task' is required for scope_create");
    }
    const projectRef = (typeof args.ref === "string" && args.ref.trim()) || fallbackRef;
    if (!projectRef) {
        throw new Error("'ref' is required for scope_create");
    }
    if (!validProjectRef(projectRef)) {
        throw new Error("'ref' is invalid for release controls");
    }
    const targetBaseCommit = resolveGitBaseCommit(cwd, args.base_commit);
    const filePath = resolve(cwd, args.file.trim());
    mkdirSync(dirname(filePath), { recursive: true });

    const scope = {
        baseCommit: targetBaseCommit,
        excludedFunctions: parseCommaList(args.excluded_functions),
        functions: parseCommaList(args.functions),
        migrations: parseCommaList(args.migrations),
        targetProjectRef: projectRef,
        taskId: String(args.task).trim(),
        web: Boolean(args.web),
    };

    const canonicalJson = genericScopedReleaseScopeJson(scope);
    const scopeSha256 = genericScopedReleaseScopeSha256(scope);
    const formatted = JSON.stringify(canonicalValue(scope), null, 2) + "\n";
    writeFileSync(filePath, formatted, "utf8");

    return releaseControlSuccess("release.scope_create", {
        file: relative(cwd, filePath),
        task_id: scope.taskId,
        target_project_ref: projectRef,
        base_commit: targetBaseCommit,
        scope_sha256: scopeSha256,
        scope,
    });
}

export function registerReleaseTools(
    server: ToolServer,
    http?: HttpTransport,
    options: {
        localOnly?: boolean;
        projectRef?: string;
        applicationHttp?: HttpTransport;
        applicationOrigin?: string;
    } = {},
): void {
    const localActions = ["scope_inspect", "scope_rebind", "scope_create"] as const;
    const remoteActions = [
        "logical_backup_list", "logical_backup_create", "logical_backup_restore",
        "postgrest_status", "postgrest_restart",
        "release_canary_fixture_stage_replay", "release_canary_fixture_disable_replay",
    ] as const;
    const allActions = [...remoteActions, ...localActions] as const;

    server.tool(
        "release",
        "Verified release controls. Scope management actions operate locally; management actions use the Management API; release canary stage/disable replay additionally require the selected project's SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        {
            action: withDescription(stringEnum(allActions as unknown as [string, ...string[]]), "Release control action"),
            ref: optional(Type.String(), options.projectRef ? "Optional override when not auto-linked" : "Project ref"),
            file: optional(Type.String(), "[scope_inspect/scope_rebind/scope_create] Path to release scope JSON file"),
            files: optional(Type.String(), "[scope_rebind] Comma-separated list of release scope JSON files"),
            dir: optional(Type.String(), "[scope_rebind] Directory containing release scope JSON files (defaults to supacloud/fa/release-scopes, release-scopes, or scopes)"),
            task: optional(Type.String(), "[scope_rebind/scope_create] Task ID or prefix filter for scope files"),
            base_commit: optional(Type.String(), "[scope_rebind/scope_create] Target 40-character base commit SHA or git ref (defaults to origin/main -> main -> HEAD^ -> HEAD)"),
            functions: optional(Type.String(), "[scope_create] Comma-separated list of functions to deploy"),
            excluded_functions: optional(Type.String(), "[scope_create] Comma-separated list of functions to exclude"),
            migrations: optional(Type.String(), "[scope_create] Comma-separated list of migrations to apply"),
            web: optional(Type.Boolean(), "[scope_create] Whether web assets are included in release scope"),
            dry_run: optional(Type.Boolean(), "[scope_rebind] Perform calculation and validation without writing files"),
            cwd: optional(Type.String(), "[scope_inspect/scope_rebind/scope_create] Base directory for relative file and git resolution"),
            backup_id: optional(Type.String(), "[logical_backup_restore] Exact verified logical-full backup ID from the selected project inventory"),
            expected_sha256: optional(Type.String(), "[logical_backup_restore] Exact lowercase SHA-256 from the selected project inventory"),
            restore_confirmation: optional(Type.String(), "[logical_backup_restore] Exact RESTORE_PROJECT:<ref>:<backup_id>:<sha256> confirmation"),
            subject: optional(Type.String(), "[release_canary_fixture_stage_replay/disable_replay] Exact central subject UUID"),
            request_id: optional(Type.String(), "[release_canary_fixture_stage_replay] Exact idempotent stage request UUID"),
            fixture_id: optional(Type.String(), "[release_canary_fixture_disable_replay] Exact staged fixture UUID"),
            disable_request_id: optional(Type.String(), "[release_canary_fixture_disable_replay] Exact idempotent disable request UUID"),
            issuer: optional(Type.String(), "[release_canary_fixture_disable_replay] Exact HTTP(S) issuer"),
        },
        async (args: any) => {
            const { action } = args;
            if (action === "scope_rebind") {
                return handleScopeRebind(args);
            }
            if (action === "scope_inspect") {
                return handleScopeInspect(args);
            }
            if (action === "scope_create") {
                return handleScopeCreate(args, options.projectRef);
            }

            if (options.localOnly || !http) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: "⚠️ This command requires Management API context. Run `supacloud-cli status` to inspect current detection.",
                        },
                    ],
                };
            }

            const { ref, backup_id, expected_sha256, restore_confirmation, subject, request_id, fixture_id, disable_request_id, issuer } = args;
            const projectRef = typeof ref === "string" && ref || options.projectRef;
            if (!projectRef) throw new Error("'ref' is required for release controls");
            if (!validProjectRef(projectRef)) throw new Error("'ref' is invalid for release controls");

            if (action === "logical_backup_list") {
                const read = await readInventory(http, projectRef);
                const failure = readInventoryFailure("release.logical_backup.list", read);
                return failure ?? releaseControlSuccess("release.logical_backup.list", {
                    project_ref: projectRef,
                    backups: read.inventory!.map(publicBackup),
                });
            }
            if (action === "logical_backup_create") {
                const before = await readInventory(http, projectRef);
                const beforeFailure = readInventoryFailure("release.logical_backup.create", before);
                if (beforeFailure) return beforeFailure;
                const mutation = await http.postReleaseMutation(`${endpoint(projectRef)}/database/backups/logical`, {}, {
                    timeoutMs: BACKUP_TIMEOUT_MS,
                });
                const after = await readInventory(http, projectRef);
                if (!mutation.ok || mutation.status !== 200) {
                    return mutationFailure("release.logical_backup.create", mutation);
                }
                const responseBackup = isRecord(mutation.data) ? verifiedBackup(mutation.data.backup, projectRef) : null;
                const afterFailure = readInventoryFailure("release.logical_backup.create", after);
                const addedBackup = after.inventory && newlyCreatedBackup(before.inventory!, after.inventory);
                if (!responseBackup || afterFailure || !addedBackup || !equalBackup(responseBackup, addedBackup)) {
                    return releaseControlFailure("release.logical_backup.create", "OUTCOME_UNKNOWN", mutation.status);
                }
                return releaseControlSuccess("release.logical_backup.create", {
                    project_ref: projectRef,
                    backup: publicBackup(addedBackup),
                });
            }
            if (action === "logical_backup_restore") {
                const request = restoreRequest(projectRef, backup_id, expected_sha256, restore_confirmation);
                const before = await readInventory(http, projectRef);
                const beforeFailure = readInventoryFailure("release.logical_backup.restore", before);
                if (beforeFailure) return beforeFailure;
                const selectedBackup = before.inventory!.find((backup) =>
                    backup.backup_id === request.backup_id && backup.sha256 === request.expected_sha256,
                );
                if (!selectedBackup) {
                    return releaseControlFailure("release.logical_backup.restore", "MUTATION_NOT_SUCCEEDED", null);
                }
                const mutation = await http.postReleaseMutation(
                    `${endpoint(projectRef)}/database/backups/logical/restore`,
                    request,
                    { timeoutMs: BACKUP_TIMEOUT_MS },
                );
                if (!mutation.ok || mutation.status !== 200) {
                    return mutationFailure("release.logical_backup.restore", mutation);
                }
                const responseBackup = isRecord(mutation.data)
                    ? verifiedBackup(mutation.data.restored_backup, projectRef)
                    : null;
                const after = await readInventory(http, projectRef);
                const afterFailure = readInventoryFailure("release.logical_backup.restore", after);
                const restoredInventoryBackup = after.inventory?.find((backup) => backup.backup_id === request.backup_id);
                if (!responseBackup
                    || !equalBackup(responseBackup, selectedBackup)
                    || afterFailure
                    || !restoredInventoryBackup
                    || !equalBackup(restoredInventoryBackup, selectedBackup)) {
                    return releaseControlFailure("release.logical_backup.restore", "OUTCOME_UNKNOWN", mutation.status);
                }
                return releaseControlSuccess("release.logical_backup.restore", {
                    project_ref: projectRef,
                    backup: publicBackup(selectedBackup),
                });
            }
            if (action === "postgrest_status") {
                const read = await readPostgrestStatus(http, projectRef);
                const failure = readPostgrestFailure("release.postgrest.status", read);
                return failure ?? releaseControlSuccess("release.postgrest.status", {
                    project_ref: projectRef,
                    postgrest: read.status!,
                });
            }
            if (action === "release_canary_fixture_stage_replay") {
                if (!options.applicationHttp || !options.applicationOrigin) {
                    throw new Error("release_canary_fixture_stage_replay requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
                }
                const request = releaseCanaryStageInput(subject, request_id);
                if (!await applicationOriginMatches(http, projectRef, options.applicationOrigin)) {
                    return releaseControlFailure("release.release_canary.fixture_stage_replay", "INVALID_RESPONSE", null);
                }
                const response = await options.applicationHttp.postReleaseMutation(
                    "/rest/v1/rpc/fa_release_canary_fixture_stage",
                    request,
                );
                if (!response.ok || response.status !== 200) {
                    return mutationFailure("release.release_canary.fixture_stage_replay", response);
                }
                const receipt = releaseCanaryStageReceipt(response.data);
                if (!receipt || !await applicationOriginMatches(http, projectRef, options.applicationOrigin)) {
                    return releaseControlFailure("release.release_canary.fixture_stage_replay", "OUTCOME_UNKNOWN", response.status);
                }
                return releaseControlSuccess("release.release_canary.fixture_stage_replay", {
                    project_ref: projectRef,
                    receipt,
                });
            }
            if (action === "release_canary_fixture_disable_replay") {
                if (!options.applicationHttp || !options.applicationOrigin) {
                    throw new Error("release_canary_fixture_disable_replay requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
                }
                const request = releaseCanaryDisableInput(fixture_id, disable_request_id, issuer, subject);
                if (!await applicationOriginMatches(http, projectRef, options.applicationOrigin)) {
                    return releaseControlFailure("release.release_canary.fixture_disable_replay", "INVALID_RESPONSE", null);
                }
                const response = await options.applicationHttp.postReleaseMutation(
                    RELEASE_CANARY_DISABLE_RPC_PATH,
                    request,
                );
                if (!response.ok || response.status !== 200) {
                    return mutationFailure("release.release_canary.fixture_disable_replay", response);
                }
                const receipt = releaseCanaryDisableReceipt(response.data, request.p_fixture_id);
                if (!receipt) {
                    return releaseControlFailure("release.release_canary.fixture_disable_replay", "OUTCOME_UNKNOWN", response.status);
                }
                const pendingRequest = {
                    p_issuer: request.p_issuer,
                    p_subject: request.p_subject,
                };
                const pendingResponse = await options.applicationHttp.get(
                    releaseCanaryPendingPath(pendingRequest),
                    { maxJsonBytes: MUTATION_MAX_BYTES, responseTimeoutMs: RELEASE_READ_RESPONSE_TIMEOUT_MS },
                );
                if (!pendingResponse.ok || pendingResponse.status !== 200
                    || !releaseCanaryPendingReadback(pendingResponse.data)
                    || !await applicationOriginMatches(http, projectRef, options.applicationOrigin)) {
                    return releaseControlFailure(
                        "release.release_canary.fixture_disable_replay",
                        "OUTCOME_UNKNOWN",
                        pendingResponse.transportError ? null : pendingResponse.status,
                    );
                }
                return releaseControlSuccess("release.release_canary.fixture_disable_replay", {
                    project_ref: projectRef,
                    receipt,
                    pending: false,
                });
            }
            if (action !== "postgrest_restart") throw new Error("Unknown release control action");
            const mutation = await http.postReleaseMutation(`${endpoint(projectRef)}/services/postgrest/restart`);
            const read = await readPostgrestStatus(http, projectRef);
            if (!mutation.ok || mutation.status !== 200) {
                return mutationFailure("release.postgrest.restart", mutation);
            }
            const readFailure = readPostgrestFailure("release.postgrest.restart", read);
            if (!isRestartReceipt(mutation.data) || readFailure
                || read.status!.desired !== "running"
                || read.status!.actual !== "running"
                || read.status!.health !== "healthy") {
                return releaseControlFailure("release.postgrest.restart", "OUTCOME_UNKNOWN", mutation.status);
            }
            return releaseControlSuccess("release.postgrest.restart", {
                project_ref: projectRef,
                postgrest: read.status,
            });
        },
    );
}
