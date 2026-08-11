import { constants } from "node:fs";
import { isAbsolute, basename, dirname, normalize, resolve } from "node:path";
import {
    lstat,
    open,
    realpath,
    unlink,
    type FileHandle,
} from "node:fs/promises";

const PROJECT_REF = /^[a-z]{20}$/;
const SERVICE_ROLE_KEY = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}$/;
const SERVICE_ROLE_ALGORITHMS = new Set(["HS256", "ES256"]);
const MAX_ENV_FILE_PATH_BYTES = 4_096;
const ENV_FILE_MODE = 0o600;
const PROC_SELF_FD = "/proc/self/fd";

export type ProjectCreateEnvErrorCode =
    | "ENV_FILE_PATH_INVALID"
    | "ENV_FILE_PLATFORM_UNSUPPORTED"
    | "ENV_FILE_PARENT_INVALID"
    | "ENV_FILE_EXISTS"
    | "ENV_FILE_WRITE_FAILED"
    | "ENV_FILE_VERIFY_FAILED"
    | "ENV_FILE_CLEANUP_FAILED";

export type CredentialFileState = "absent" | "unknown";
export type ProjectEnvironment = "test" | "production";

export class ProjectCreateEnvError extends Error {
    constructor(
        public readonly code: ProjectCreateEnvErrorCode,
        public readonly credentialFileState: CredentialFileState = "absent",
    ) {
        super(code);
        this.name = "ProjectCreateEnvError";
    }
}

interface ProjectEnvFileStat {
    dev: number;
    ino: number;
    mode: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}

interface ProjectEnvFileHandle {
    chmod(mode: number): Promise<void>;
    writeFile(contents: string): Promise<void>;
    sync(): Promise<void>;
    stat(): Promise<ProjectEnvFileStat>;
    truncate(length?: number): Promise<void>;
    close(): Promise<void>;
}

interface ProjectEnvDirectoryHandle {
    fd: number;
    stat(): Promise<ProjectEnvFileStat>;
    close(): Promise<void>;
}

export interface ProjectEnvFileOperations {
    platform: NodeJS.Platform;
    lstat(path: string): Promise<ProjectEnvFileStat>;
    realpath(path: string): Promise<string>;
    openDirectory(path: string): Promise<ProjectEnvDirectoryHandle>;
    openExclusiveAt(
        directory: ProjectEnvDirectoryHandle,
        filename: string,
        mode: number,
    ): Promise<ProjectEnvFileHandle>;
    lstatAt(directory: ProjectEnvDirectoryHandle, filename: string): Promise<ProjectEnvFileStat>;
    unlinkAt(directory: ProjectEnvDirectoryHandle, filename: string): Promise<void>;
}

function descriptorRelativePath(directory: ProjectEnvDirectoryHandle, filename: string): string {
    return `${PROC_SELF_FD}/${directory.fd}/${filename}`;
}

const nodeProjectEnvFileOperations: ProjectEnvFileOperations = {
    platform: process.platform,
    lstat,
    realpath,
    openDirectory: path => open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ) as Promise<FileHandle>,
    openExclusiveAt: (directory, filename, mode) => open(
        descriptorRelativePath(directory, filename),
        "wx",
        mode,
    ) as Promise<FileHandle>,
    lstatAt: (directory, filename) => lstat(descriptorRelativePath(directory, filename)),
    unlinkAt: (directory, filename) => unlink(descriptorRelativePath(directory, filename)),
};

interface ProjectEnvFileIdentity {
    dev: number;
    ino: number;
}

interface ProjectEnvParentIdentity extends ProjectEnvFileIdentity {
    canonicalPath: string;
}

interface FailedProjectEnvFileCleanup {
    directoryHandle: ProjectEnvDirectoryHandle;
    filename: string;
    openFile: ProjectEnvFileHandle | null;
    fileIdentity: ProjectEnvFileIdentity | null;
    operations: ProjectEnvFileOperations;
}

export interface PreparedProjectEnvFile {
    path: string;
    filename: string;
    environment: ProjectEnvironment;
    parentIdentity: ProjectEnvParentIdentity;
    fileIdentity: ProjectEnvFileIdentity;
    directoryHandle: ProjectEnvDirectoryHandle | null;
    openFile: ProjectEnvFileHandle | null;
}

export interface ProjectCreateIdentity {
    projectRef: string;
    apiUrl: string;
}

export interface ProjectCreateCredentials extends ProjectCreateIdentity {
    serviceRoleKey: string;
}

function fileSystemErrorCode(candidate: unknown): string | null {
    if (!candidate || typeof candidate !== "object" || !("code" in candidate)) return null;
    return typeof candidate.code === "string" ? candidate.code : null;
}

async function assertTargetAbsent(
    path: string,
    operations: ProjectEnvFileOperations,
): Promise<void> {
    try {
        await operations.lstat(path);
    } catch (error: unknown) {
        if (fileSystemErrorCode(error) === "ENOENT") return;
        throw new ProjectCreateEnvError("ENV_FILE_PATH_INVALID");
    }
    throw new ProjectCreateEnvError("ENV_FILE_EXISTS");
}

async function assertSafeParent(
    directory: string,
    operations: ProjectEnvFileOperations,
): Promise<ProjectEnvParentIdentity> {
    try {
        const parentBeforeRealpath = await operations.lstat(directory);
        const canonicalParent = await operations.realpath(directory);
        const parentAfterRealpath = await operations.lstat(directory);
        if (
            !parentBeforeRealpath.isDirectory()
            || parentBeforeRealpath.isSymbolicLink()
            || !parentAfterRealpath.isDirectory()
            || parentAfterRealpath.isSymbolicLink()
            || canonicalParent !== directory
            || !sameFileIdentity(parentBeforeRealpath, parentAfterRealpath)
        ) {
            throw new ProjectCreateEnvError("ENV_FILE_PARENT_INVALID");
        }
        return {
            canonicalPath: canonicalParent,
            dev: parentAfterRealpath.dev,
            ino: parentAfterRealpath.ino,
        };
    } catch (error: unknown) {
        if (error instanceof ProjectCreateEnvError) throw error;
        throw new ProjectCreateEnvError("ENV_FILE_PARENT_INVALID");
    }
}

function sameFileIdentity(
    first: ProjectEnvFileIdentity,
    second: ProjectEnvFileIdentity,
): boolean {
    return first.dev === second.dev && first.ino === second.ino;
}

function hasSafeRequestedPath(requestedPath: string): boolean {
    return Boolean(requestedPath)
        && isAbsolute(requestedPath)
        && requestedPath === normalize(requestedPath)
        && requestedPath === resolve(requestedPath)
        && Buffer.byteLength(requestedPath, "utf8") <= MAX_ENV_FILE_PATH_BYTES
        && !/[\0\r\n]/.test(requestedPath)
        && ![".", ".."].includes(basename(requestedPath));
}

export async function prepareProjectEnvFile(
    requestedPath: string,
    environment: ProjectEnvironment,
    operations: ProjectEnvFileOperations = nodeProjectEnvFileOperations,
): Promise<PreparedProjectEnvFile> {
    if (operations.platform !== "linux") {
        throw new ProjectCreateEnvError("ENV_FILE_PLATFORM_UNSUPPORTED");
    }
    if (!hasSafeRequestedPath(requestedPath)) {
        throw new ProjectCreateEnvError("ENV_FILE_PATH_INVALID");
    }
    const directory = dirname(requestedPath);
    const filename = basename(requestedPath);
    const parentIdentity = await assertSafeParent(directory, operations);
    await assertTargetAbsent(requestedPath, operations);
    let directoryHandle: ProjectEnvDirectoryHandle | null = null;
    let openFile: ProjectEnvFileHandle | null = null;
    let fileIdentity: ProjectEnvFileIdentity | null = null;
    try {
        directoryHandle = await operations.openDirectory(directory);
        await assertDirectoryBinding(directory, directoryHandle, parentIdentity, operations);
        openFile = await openProjectEnvFile(directoryHandle, filename, operations);
        const openFileStat = await openFile.stat();
        assertSecureFileType(openFileStat);
        fileIdentity = { dev: openFileStat.dev, ino: openFileStat.ino };
        await openFile.chmod(ENV_FILE_MODE);
        const prepared = {
            path: requestedPath,
            filename,
            environment,
            parentIdentity,
            fileIdentity,
            directoryHandle,
            openFile,
        };
        await assertPreparedFileBinding(prepared, operations);
        return prepared;
    } catch (error: unknown) {
        if (directoryHandle) {
            const credentialFileState = await removeFailedEnvFile(
                { directoryHandle, filename, openFile, fileIdentity, operations },
            );
            if (credentialFileState === "unknown") {
                throw new ProjectCreateEnvError("ENV_FILE_CLEANUP_FAILED", "unknown");
            }
        }
        if (error instanceof ProjectCreateEnvError) throw error;
        throw new ProjectCreateEnvError("ENV_FILE_WRITE_FAILED");
    }
}

function environmentFileContent(
    credentials: ProjectCreateCredentials,
    environment: ProjectEnvironment,
): string {
    return [
        `SUPACLOUD_ENV=${environment}`,
        `SUPACLOUD_PROJECT_REF=${credentials.projectRef}`,
        `SUPABASE_URL=${credentials.apiUrl}`,
        `SUPABASE_SERVICE_ROLE_KEY=${credentials.serviceRoleKey}`,
        "",
    ].join("\n");
}

async function sanitizeAndClose(openFile: ProjectEnvFileHandle): Promise<boolean> {
    let sanitized = true;
    try {
        await openFile.truncate(0);
        await openFile.sync();
    } catch {
        sanitized = false;
    }
    try {
        await openFile.close();
    } catch {
        // Unlink does not require the file descriptor to close successfully.
    }
    return sanitized;
}

async function removeFailedEnvFile(
    cleanup: FailedProjectEnvFileCleanup,
): Promise<CredentialFileState> {
    const { directoryHandle, filename, openFile, fileIdentity, operations } = cleanup;
    if (!openFile) {
        try {
            await directoryHandle.close();
        } catch {
            // No credential file was created, so descriptor cleanup cannot change its state.
        }
        return "absent";
    }
    const sanitized = await sanitizeAndClose(openFile);
    let credentialFileState: CredentialFileState = "absent";
    try {
        const targetStat = await operations.lstatAt(directoryHandle, filename);
        if (!fileIdentity || !sameFileIdentity(targetStat, fileIdentity)) {
            credentialFileState = "unknown";
        } else {
            await operations.unlinkAt(directoryHandle, filename);
        }
    } catch (error: unknown) {
        if (fileSystemErrorCode(error) !== "ENOENT" || !sanitized) {
            credentialFileState = "unknown";
        }
    }
    try {
        await directoryHandle.close();
    } catch {
        // Closing the held directory does not change the verified credential file state.
    }
    return credentialFileState;
}

function assertSecureFileType(fileStat: ProjectEnvFileStat): void {
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new ProjectCreateEnvError("ENV_FILE_VERIFY_FAILED");
    }
}

function assertSecureOpenFile(fileStat: ProjectEnvFileStat): void {
    assertSecureFileType(fileStat);
    if ((fileStat.mode & 0o777) !== ENV_FILE_MODE) {
        throw new ProjectCreateEnvError("ENV_FILE_VERIFY_FAILED");
    }
}

async function openProjectEnvFile(
    directory: ProjectEnvDirectoryHandle,
    filename: string,
    operations: ProjectEnvFileOperations,
): Promise<ProjectEnvFileHandle> {
    try {
        return await operations.openExclusiveAt(directory, filename, ENV_FILE_MODE);
    } catch (error: unknown) {
        if (fileSystemErrorCode(error) === "EEXIST") {
            throw new ProjectCreateEnvError("ENV_FILE_EXISTS");
        }
        throw error;
    }
}

async function assertDirectoryBinding(
    path: string,
    directoryHandle: ProjectEnvDirectoryHandle,
    expectedIdentity: ProjectEnvParentIdentity,
    operations: ProjectEnvFileOperations,
): Promise<void> {
    const heldDirectoryStat = await directoryHandle.stat();
    const currentPathIdentity = await assertSafeParent(path, operations);
    if (
        !heldDirectoryStat.isDirectory()
        || !sameFileIdentity(heldDirectoryStat, expectedIdentity)
        || !sameFileIdentity(currentPathIdentity, expectedIdentity)
    ) {
        throw new ProjectCreateEnvError("ENV_FILE_PARENT_INVALID");
    }
}

async function assertPreparedFileBinding(
    prepared: PreparedProjectEnvFile,
    operations: ProjectEnvFileOperations,
): Promise<void> {
    if (!prepared.directoryHandle || !prepared.openFile) {
        throw new ProjectCreateEnvError("ENV_FILE_VERIFY_FAILED");
    }
    await assertDirectoryBinding(
        dirname(prepared.path),
        prepared.directoryHandle,
        prepared.parentIdentity,
        operations,
    );
    const openFileStat = await prepared.openFile.stat();
    const targetStat = await operations.lstatAt(prepared.directoryHandle, prepared.filename);
    assertSecureOpenFile(openFileStat);
    assertSecureFileType(targetStat);
    if (
        !sameFileIdentity(openFileStat, prepared.fileIdentity)
        || !sameFileIdentity(targetStat, prepared.fileIdentity)
    ) {
        throw new ProjectCreateEnvError("ENV_FILE_VERIFY_FAILED");
    }
}

export async function discardPreparedProjectEnvFile(
    prepared: PreparedProjectEnvFile,
    operations: ProjectEnvFileOperations = nodeProjectEnvFileOperations,
): Promise<CredentialFileState> {
    if (!prepared.directoryHandle) return "absent";
    const directoryHandle = prepared.directoryHandle;
    const openFile = prepared.openFile;
    prepared.directoryHandle = null;
    prepared.openFile = null;
    return removeFailedEnvFile(
        {
            directoryHandle,
            filename: prepared.filename,
            openFile,
            fileIdentity: prepared.fileIdentity,
            operations,
        },
    );
}

export async function writeProjectEnvFile(
    prepared: PreparedProjectEnvFile,
    credentials: ProjectCreateCredentials,
    operations: ProjectEnvFileOperations = nodeProjectEnvFileOperations,
): Promise<void> {
    if (!prepared.directoryHandle || !prepared.openFile) {
        throw new ProjectCreateEnvError("ENV_FILE_WRITE_FAILED");
    }
    const directoryHandle = prepared.directoryHandle;
    const openFile = prepared.openFile;
    try {
        await assertPreparedFileBinding(prepared, operations);
        await openFile.chmod(ENV_FILE_MODE);
        await assertPreparedFileBinding(prepared, operations);
        await openFile.writeFile(environmentFileContent(credentials, prepared.environment));
        await openFile.sync();
        await assertPreparedFileBinding(prepared, operations);
        await openFile.close();
        prepared.openFile = null;
        await directoryHandle.close();
        prepared.directoryHandle = null;
    } catch (error: unknown) {
        prepared.directoryHandle = null;
        prepared.openFile = null;
        const credentialFileState = await removeFailedEnvFile(
            {
                directoryHandle,
                filename: prepared.filename,
                openFile,
                fileIdentity: prepared.fileIdentity,
                operations,
            },
        );
        if (credentialFileState === "unknown") {
            throw new ProjectCreateEnvError("ENV_FILE_CLEANUP_FAILED", "unknown");
        }
        if (error instanceof ProjectCreateEnvError) throw error;
        throw new ProjectCreateEnvError("ENV_FILE_WRITE_FAILED");
    }
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
    return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function decodedJwtPart(encodedPart: string): Record<string, unknown> | null {
    try {
        const decodedPart = JSON.parse(Buffer.from(encodedPart, "base64url").toString("utf8"));
        return isRecord(decodedPart) ? decodedPart : null;
    } catch {
        return null;
    }
}

function isServiceRoleKey(candidate: unknown): candidate is string {
    if (typeof candidate !== "string" || !SERVICE_ROLE_KEY.test(candidate)) return false;
    const [encodedHeader, encodedClaims] = candidate.split(".");
    const jwtHeader = decodedJwtPart(encodedHeader);
    const jwtClaims = decodedJwtPart(encodedClaims);
    return jwtHeader?.typ === "JWT"
        && typeof jwtHeader.alg === "string"
        && SERVICE_ROLE_ALGORITHMS.has(jwtHeader.alg)
        && jwtClaims?.role === "service_role"
        && jwtClaims.iss === "supabase"
        && typeof jwtClaims.exp === "number"
        && Number.isFinite(jwtClaims.exp)
        && jwtClaims.exp > Date.now() / 1_000;
}

function parsedProjectApiUrl(candidate: unknown): URL | null {
    if (typeof candidate !== "string" || candidate.length > 2_048) return null;
    try {
        return new URL(candidate);
    } catch {
        return null;
    }
}

function hasSafeProjectApiUrlShape(parsedUrl: URL): boolean {
    const loopbackHttp = parsedUrl.protocol === "http:"
        && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname);
    return (parsedUrl.protocol === "https:" || loopbackHttp)
        && !parsedUrl.username
        && !parsedUrl.password
        && !parsedUrl.search
        && !parsedUrl.hash
        && (parsedUrl.pathname === "/" || parsedUrl.pathname === "");
}

function hasExpectedProjectApiOrigin(
    parsedUrl: URL,
    projectRef: string,
    expectedApiOrigin?: string,
): boolean {
    const hostname = parsedUrl.hostname.toLowerCase();
    if (expectedApiOrigin) return parsedUrl.origin === expectedApiOrigin;
    return !parsedUrl.port && hostname.split(".")[0] === projectRef;
}

function projectApiUrl(
    candidate: unknown,
    projectRef: string,
    expectedApiOrigin?: string,
): string | null {
    const parsedUrl = parsedProjectApiUrl(candidate);
    if (!parsedUrl || !hasSafeProjectApiUrlShape(parsedUrl)) return null;
    if (!hasExpectedProjectApiOrigin(parsedUrl, projectRef, expectedApiOrigin)) return null;
    return parsedUrl.origin;
}

export function parseProjectCreateIdentity(
    responsePayload: unknown,
    expectedApiOrigin?: string,
): ProjectCreateIdentity | null {
    if (!isRecord(responsePayload) || typeof responsePayload.ref !== "string") return null;
    if (!PROJECT_REF.test(responsePayload.ref) || !isRecord(responsePayload.api)) return null;
    const apiUrl = projectApiUrl(responsePayload.api.url, responsePayload.ref, expectedApiOrigin);
    return apiUrl ? { projectRef: responsePayload.ref, apiUrl } : null;
}

export function parseProjectCreateWithoutCredentials(
    responsePayload: unknown,
    expectedApiOrigin?: string,
): ProjectCreateIdentity | null {
    const identity = parseProjectCreateIdentity(responsePayload, expectedApiOrigin);
    if (!identity || !isRecord(responsePayload)) return null;
    return Object.hasOwn(responsePayload, "credentials") ? null : identity;
}

export function parseProjectCreateCredentials(
    responsePayload: unknown,
    expectedApiOrigin?: string,
): ProjectCreateCredentials | null {
    if (!expectedApiOrigin) return null;
    const identity = parseProjectCreateIdentity(responsePayload, expectedApiOrigin);
    if (!identity || !isRecord(responsePayload)) return null;
    if (!isRecord(responsePayload.credentials)) return null;
    const serviceRoleKey = responsePayload.credentials.service_role_key;
    return isServiceRoleKey(serviceRoleKey) ? { ...identity, serviceRoleKey } : null;
}
