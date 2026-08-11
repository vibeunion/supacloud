import { afterEach, describe, expect, test } from "bun:test";
import {
    constants,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    parseProjectCreateCredentials,
    parseProjectCreateWithoutCredentials,
    prepareProjectEnvFile,
    writeProjectEnvFile,
    type ProjectEnvFileOperations,
} from "./project-create-env";

const PROJECT_REF = "abcdefghijklmnopqrst";
const API_URL = "https://api.example.test";
const FUTURE_EXPIRATION = 4_102_444_800;
const sandboxes: string[] = [];

function descriptorPath(directory: { fd: number }, filename: string): string {
    return `/proc/self/fd/${directory.fd}/${filename}`;
}

function linuxTestOperations(): ProjectEnvFileOperations {
    return {
        platform: "linux",
        lstat,
        realpath,
        openDirectory: path => open(
            path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
        openExclusiveAt: (directory, filename, mode) =>
            open(descriptorPath(directory, filename), "wx", mode),
        lstatAt: (directory, filename) => lstat(descriptorPath(directory, filename)),
        unlinkAt: (directory, filename) => unlink(descriptorPath(directory, filename)),
    };
}

async function fileStatWithMode(
    file: Awaited<ReturnType<ProjectEnvFileOperations["openExclusiveAt"]>>,
    mode: number,
) {
    const stat = await file.stat();
    return {
        dev: stat.dev,
        ino: stat.ino,
        mode,
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
        isSymbolicLink: () => stat.isSymbolicLink(),
    };
}

function jwtSegment(claims: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function roleKey(
    role: string,
    issuer = "supabase",
    algorithm = "HS256",
    claims: Record<string, unknown> = { exp: FUTURE_EXPIRATION },
): string {
    return [
        jwtSegment({ alg: algorithm, typ: "JWT" }),
        jwtSegment({ role, iss: issuer, ...claims }),
        "s".repeat(43),
    ].join(".");
}

const SERVICE_ROLE_KEY = roleKey("service_role");

function sandbox(): string {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-project-env-")));
    sandboxes.push(path);
    return path;
}

function credentials() {
    return {
        projectRef: PROJECT_REF,
        apiUrl: API_URL,
        serviceRoleKey: SERVICE_ROLE_KEY,
    };
}

afterEach(() => {
    for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project create response parsing", () => {
    test("extracts only the fixed project and one-time credential fields", () => {
        const remoteSecret = "remote-secret-that-must-not-be-projected";
        const parsed = parseProjectCreateCredentials({
            ref: PROJECT_REF,
            api: { url: API_URL, token: remoteSecret },
            credentials: {
                service_role_key: SERVICE_ROLE_KEY,
                jwt_secret: remoteSecret,
                db_password: remoteSecret,
            },
            service_role_key: remoteSecret,
            secret_key: remoteSecret,
            message: remoteSecret.repeat(1_024),
        }, "https://api.example.test");

        expect(parsed).toEqual(credentials());
        expect(JSON.stringify(parsed)).not.toContain(remoteSecret);
    });

    test("rejects a credential-bearing response when delivery was not requested", () => {
        expect(parseProjectCreateWithoutCredentials({
            ref: PROJECT_REF,
            api: { url: API_URL },
            credentials: { service_role_key: SERVICE_ROLE_KEY },
        }, "https://api.example.test")).toBeNull();
    });

    test("rejects credential delivery without a complete expected API domain", () => {
        expect(parseProjectCreateCredentials({
            ref: PROJECT_REF,
            api: { url: `https://${PROJECT_REF}.attacker.example` },
            credentials: { service_role_key: SERVICE_ROLE_KEY },
        })).toBeNull();
    });

    test("binds credential delivery to the canonical API origin and port", () => {
        const response = (apiUrl: string) => ({
            ref: PROJECT_REF,
            api: { url: apiUrl },
            credentials: { service_role_key: SERVICE_ROLE_KEY },
        });

        expect(parseProjectCreateCredentials(
            response("https://api.example.test:443"),
            "https://api.example.test",
        )).toEqual(credentials());
        expect(parseProjectCreateCredentials(
            response("https://api.example.test:8443"),
            "https://api.example.test",
        )).toBeNull();
    });

    test.each([
        ["invalid ref", { ref: "secret-ref", api: { url: API_URL }, credentials: { service_role_key: SERVICE_ROLE_KEY } }],
        ["invalid API payload", { ref: PROJECT_REF, api: API_URL, credentials: { service_role_key: SERVICE_ROLE_KEY } }],
        ["wrong API origin", { ref: PROJECT_REF, api: { url: "https://wrong.example.test" }, credentials: { service_role_key: SERVICE_ROLE_KEY } }],
        ["credentialed URL", { ref: PROJECT_REF, api: { url: "https://secret@api.example.test" }, credentials: { service_role_key: SERVICE_ROLE_KEY } }],
        ["URL query", { ref: PROJECT_REF, api: { url: `${API_URL}?secret=value` }, credentials: { service_role_key: SERVICE_ROLE_KEY } }],
        ["external HTTP URL", { ref: PROJECT_REF, api: { url: "http://api.example.test" }, credentials: { service_role_key: SERVICE_ROLE_KEY } }],
        ["missing credentials", { ref: PROJECT_REF, api: { url: API_URL } }],
        ["short credential", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: "short" } }],
        ["anon credential", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: roleKey("anon") } }],
        ["wrong issuer", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: roleKey("service_role", "attacker") } }],
        ["unsafe algorithm", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: roleKey("service_role", "supabase", "none") } }],
        ["missing expiration", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: roleKey("service_role", "supabase", "HS256", {}) } }],
        ["expired credential", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: roleKey("service_role", "supabase", "HS256", { exp: 1 }) } }],
        ["non-numeric expiration", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: roleKey("service_role", "supabase", "HS256", { exp: "tomorrow" }) } }],
        ["multiline credential", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: `${SERVICE_ROLE_KEY}\nsecret` } }],
        ["shell credential", { ref: PROJECT_REF, api: { url: API_URL }, credentials: { service_role_key: "headerpart.payloadpart.$(private-command)" } }],
    ])("rejects %s without reflecting hostile fields", (_name, payload) => {
        expect(parseProjectCreateCredentials(
            payload,
            "https://api.example.test",
        )).toBeNull();
    });

    test.each([
        ["IPv4", "http://127.0.0.1"],
        ["IPv6", "http://[::1]"],
    ])("accepts %s loopback HTTP only for local development", (_family, apiUrl) => {
        expect(parseProjectCreateWithoutCredentials({
            ref: PROJECT_REF,
            api: { url: apiUrl },
        }, apiUrl)).toEqual({
            projectRef: PROJECT_REF,
            apiUrl,
        });
    });
});

describe.skipIf(process.platform !== "linux")("secure project env file", () => {
    test.each(["test", "production"] as const)(
        "exclusively writes four %s application settings with Unix mode 0600",
        async environment => {
            const directory = sandbox();
            const target = join(directory, `.env.project-credentials.${environment}`);
            const prepared = await prepareProjectEnvFile(target, environment);

            await writeProjectEnvFile(prepared, credentials());

            expect(readFileSync(target, "utf8")).toBe([
                `SUPACLOUD_ENV=${environment}`,
                `SUPACLOUD_PROJECT_REF=${PROJECT_REF}`,
                `SUPABASE_URL=${API_URL}`,
                `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`,
                "",
            ].join("\n"));
            expect(lstatSync(target).isFile()).toBe(true);
            if (process.platform !== "win32") expect(lstatSync(target).mode & 0o777).toBe(0o600);
            expect(readdirSync(directory)).toEqual([`.env.project-credentials.${environment}`]);
        },
    );

    test("rejects existing files, directories, symlinks, and dangling symlinks", async () => {
        const directory = sandbox();
        const existingFile = join(directory, "existing.env");
        const existingDirectory = join(directory, "existing-directory");
        const symlink = join(directory, "linked.env");
        const dangling = join(directory, "dangling.env");
        writeFileSync(existingFile, "existing");
        mkdirSync(existingDirectory);
        symlinkSync(existingFile, symlink);
        symlinkSync(join(directory, "missing.env"), dangling);

        for (const target of [existingFile, existingDirectory, symlink, dangling]) {
            await expect(prepareProjectEnvFile(target, "test")).rejects.toMatchObject({
                code: "ENV_FILE_EXISTS",
            });
        }
        expect(readFileSync(existingFile, "utf8")).toBe("existing");
    });

    test("rejects missing or symlinked parents and non-canonical paths", async () => {
        const directory = sandbox();
        const realDirectory = join(directory, "real-parent");
        const linkedDirectory = join(directory, "linked-parent");
        mkdirSync(realDirectory);
        symlinkSync(realDirectory, linkedDirectory);

        await expect(prepareProjectEnvFile(join(directory, "missing", ".env"), "test"))
            .rejects.toMatchObject({ code: "ENV_FILE_PARENT_INVALID" });
        await expect(prepareProjectEnvFile(join(linkedDirectory, ".env"), "test"))
            .rejects.toMatchObject({ code: "ENV_FILE_PARENT_INVALID" });
        await expect(prepareProjectEnvFile(`${directory}/real-parent/../.env`, "test"))
            .rejects.toMatchObject({ code: "ENV_FILE_PATH_INVALID" });
        await expect(prepareProjectEnvFile("relative.env", "test"))
            .rejects.toMatchObject({ code: "ENV_FILE_PATH_INVALID" });
    });

    test.each(["chmod", "write", "sync", "stat", "close"] as const)(
        "sanitizes %s failures and removes the reserved target",
        async failureStage => {
            const baseOperations = linuxTestOperations();
            let chmodCalls = 0;
            let credentialsWritten = false;
            const operations: ProjectEnvFileOperations = {
                ...baseOperations,
                async openExclusiveAt(directory, filename, mode) {
                    const handle = await baseOperations.openExclusiveAt(directory, filename, mode);
                    return {
                        chmod: async requestedMode => {
                            chmodCalls += 1;
                            if (failureStage === "chmod" && chmodCalls === 2) throw new Error("private-chmod");
                            await handle.chmod(requestedMode);
                        },
                        writeFile: async contents => {
                            if (failureStage === "write") throw new Error("private-write");
                            await handle.writeFile(contents);
                            credentialsWritten = true;
                        },
                        sync: async () => {
                            if (failureStage === "sync" && credentialsWritten) throw new Error("private-sync");
                            await handle.sync();
                        },
                        stat: async () => {
                            if (failureStage === "stat" && credentialsWritten) throw new Error("private-stat");
                            return handle.stat();
                        },
                        truncate: length => handle.truncate(length),
                        close: async () => {
                            await handle.close();
                            if (failureStage === "close") throw new Error("private-close");
                        },
                    };
                },
            };
            const directory = sandbox();
            const target = join(directory, `${failureStage}.env`);
            const prepared = await prepareProjectEnvFile(target, "test", operations);

            await expect(writeProjectEnvFile(prepared, credentials(), operations)).rejects.toMatchObject({
                code: "ENV_FILE_WRITE_FAILED",
            });
            expect(readdirSync(directory)).toEqual([]);
        },
    );

    test.each(["open", "chmod"] as const)(
        "fails closed when secure reservation %s fails",
        async failureStage => {
            const baseOperations = linuxTestOperations();
            const operations: ProjectEnvFileOperations = {
                ...baseOperations,
                async openExclusiveAt(directory, filename, mode) {
                    if (failureStage === "open") throw new Error("private-open");
                    const handle = await baseOperations.openExclusiveAt(directory, filename, mode);
                    return {
                        chmod: async () => { throw new Error("private-chmod"); },
                        writeFile: contents => handle.writeFile(contents),
                        sync: () => handle.sync(),
                        stat: () => handle.stat(),
                        truncate: length => handle.truncate(length),
                        close: () => handle.close(),
                    };
                },
            };
            const directory = sandbox();

            await expect(prepareProjectEnvFile(
                join(directory, `${failureStage}.env`),
                "test",
                operations,
            )).rejects.toMatchObject({ code: "ENV_FILE_WRITE_FAILED" });
            expect(readdirSync(directory)).toEqual([]);
        },
    );

    test("removes the reservation when its permission check fails", async () => {
        const baseOperations = linuxTestOperations();
        const operations: ProjectEnvFileOperations = {
            ...baseOperations,
            async openExclusiveAt(directory, filename, mode) {
                const openFile = await baseOperations.openExclusiveAt(directory, filename, mode);
                return {
                    chmod: requestedMode => openFile.chmod(requestedMode),
                    writeFile: contents => openFile.writeFile(contents),
                    sync: () => openFile.sync(),
                    stat: () => fileStatWithMode(openFile, 0o100644),
                    truncate: length => openFile.truncate(length),
                    close: () => openFile.close(),
                };
            },
        };
        const directory = sandbox();

        await expect(prepareProjectEnvFile(
            join(directory, "unsafe-mode.env"),
            "test",
            operations,
        )).rejects.toMatchObject({ code: "ENV_FILE_VERIFY_FAILED" });
        expect(readdirSync(directory)).toEqual([]);
    });

    test("reports unknown credential state when truncate and descriptor-relative unlink fail", async () => {
        const baseOperations = linuxTestOperations();
        let credentialsWritten = false;
        const operations: ProjectEnvFileOperations = {
            ...baseOperations,
            async openExclusiveAt(directory, filename, mode) {
                const openFile = await baseOperations.openExclusiveAt(directory, filename, mode);
                return {
                    chmod: requestedMode => openFile.chmod(requestedMode),
                    writeFile: async contents => {
                        await openFile.writeFile(contents);
                        credentialsWritten = true;
                    },
                    sync: () => openFile.sync(),
                    stat: () => fileStatWithMode(
                        openFile,
                        credentialsWritten ? 0o100644 : 0o100600,
                    ),
                    truncate: async () => { throw new Error("private-truncate-detail"); },
                    close: () => openFile.close(),
                };
            },
            unlinkAt: async () => { throw new Error("private-unlink-detail"); },
        };
        const directory = sandbox();
        const target = join(directory, "cleanup-unknown.env");
        const prepared = await prepareProjectEnvFile(target, "test", operations);

        await expect(writeProjectEnvFile(prepared, credentials(), operations)).rejects.toMatchObject({
            code: "ENV_FILE_CLEANUP_FAILED",
            credentialFileState: "unknown",
        });
        expect(readFileSync(target, "utf8")).toContain(SERVICE_ROLE_KEY);
    });

    test("reserves the target before credential delivery and never overwrites it", async () => {
        const directory = sandbox();
        const target = join(directory, "reserved.env");
        const prepared = await prepareProjectEnvFile(target, "test");

        expect(() => writeFileSync(target, "raced", { flag: "wx" })).toThrow();
        await writeProjectEnvFile(prepared, credentials());
        expect(readFileSync(target, "utf8")).toContain(SERVICE_ROLE_KEY);
    });

    test("blocks a real parent rename and replacement between binding and create", async () => {
        const baseOperations = linuxTestOperations();
        const root = sandbox();
        const parent = join(root, "parent");
        const movedParent = join(root, "moved-parent");
        mkdirSync(parent);
        const operations: ProjectEnvFileOperations = {
            ...baseOperations,
            async openExclusiveAt(directory, filename, mode) {
                renameSync(parent, movedParent);
                mkdirSync(parent);
                return baseOperations.openExclusiveAt(directory, filename, mode);
            },
        };

        await expect(prepareProjectEnvFile(
            join(parent, "credentials.env"),
            "test",
            operations,
        )).rejects.toMatchObject({ code: "ENV_FILE_PARENT_INVALID" });
        expect(readdirSync(parent)).toEqual([]);
        expect(readdirSync(movedParent)).toEqual([]);
    });

    test("cleans through the held descriptor when the parent changes before write", async () => {
        const root = sandbox();
        const parent = join(root, "write-parent");
        const movedParent = join(root, "write-parent-moved");
        const target = join(parent, "credentials.env");
        mkdirSync(parent);
        const prepared = await prepareProjectEnvFile(target, "test");
        renameSync(parent, movedParent);
        mkdirSync(parent);

        await expect(writeProjectEnvFile(prepared, credentials()))
            .rejects.toMatchObject({ code: "ENV_FILE_PARENT_INVALID" });
        expect(readdirSync(parent)).toEqual([]);
        expect(readdirSync(movedParent)).toEqual([]);
    });

    test("cleans through the held descriptor when the parent changes during write", async () => {
        const baseOperations = linuxTestOperations();
        const root = sandbox();
        const parent = join(root, "write-race-parent");
        const movedParent = join(root, "write-race-parent-moved");
        const target = join(parent, "credentials.env");
        mkdirSync(parent);
        const operations: ProjectEnvFileOperations = {
            ...baseOperations,
            async openExclusiveAt(directory, filename, mode) {
                const openFile = await baseOperations.openExclusiveAt(directory, filename, mode);
                return {
                    chmod: requestedMode => openFile.chmod(requestedMode),
                    async writeFile(contents) {
                        await openFile.writeFile(contents);
                        renameSync(parent, movedParent);
                        mkdirSync(parent);
                    },
                    sync: () => openFile.sync(),
                    stat: () => openFile.stat(),
                    truncate: length => openFile.truncate(length),
                    close: () => openFile.close(),
                };
            },
        };
        const prepared = await prepareProjectEnvFile(target, "test", operations);

        await expect(writeProjectEnvFile(prepared, credentials(), operations))
            .rejects.toMatchObject({ code: "ENV_FILE_PARENT_INVALID" });
        expect(readdirSync(parent)).toEqual([]);
        expect(readdirSync(movedParent)).toEqual([]);
    });
});

test.each(["darwin", "win32"] as const)(
    "fails closed on %s before creating a credential reservation",
    async platform => {
        const directory = sandbox();
        const target = join(directory, `${platform}.env`);
        const operations = { ...linuxTestOperations(), platform };

        await expect(prepareProjectEnvFile(target, "test", operations)).rejects.toMatchObject({
            code: "ENV_FILE_PLATFORM_UNSUPPORTED",
        });
        expect(readdirSync(directory)).toEqual([]);
    },
);
