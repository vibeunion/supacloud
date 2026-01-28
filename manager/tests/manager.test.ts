
import { describe, expect, test, mock, beforeEach, spyOn } from "bun:test";
import { handler, createProject, getNextPorts, deps } from "../index";

// Mock Deps
const mockReaddir = spyOn(deps, "readdir");
const mockWrite = spyOn(deps, "write");
const mockFileExists = mock(() => Promise.resolve(false));
const mockFileText = mock(() => Promise.resolve(""));
const mockSpawn = spyOn(deps, "spawn");
const mockStat = spyOn(deps, "stat");

// Mock deps.stat to behave like file existence check
// If we want it to NOT exist, we reject. If exist, we resolve.
mockStat.mockImplementation(async (path: any) => {
    const exists = await mockFileExists();
    if (!exists) throw new Error("File not found");
    return {} as any;
});

// Mock Bun.file
spyOn(deps, "file").mockImplementation((path) => ({
    exists: mockFileExists,
    text: mockFileText
} as any));

// Mock Bun.Glob
deps.Glob = class MockGlob {
    scan() {
        return {
            async *[Symbol.asyncIterator]() {
                // yield nothing
            }
        } as any;
    }
} as any;


// Mock $ shell - correctly simulating "Thenable" with methods
const mockShellExec = mock((strings, ...values) => {
    let outputText = "OK";

    // Check if it's key info command to return keys
    const cmdString = strings.join(" ");
    if (cmdString.includes("key info")) {
        outputText = "Key ID: GK123456\nSecret key: 1234567890abcdef";
    }

    const result = {
        exitCode: 0,
        stdout: new TextEncoder().encode(outputText),
        stderr: new Uint8Array(0),
        text: () => Promise.resolve(outputText),
        json: () => Promise.resolve({})
    };

    // Create a Thenable
    const thenable = {
        then: (onfulfilled: any, onrejected: any) => Promise.resolve(result).then(onfulfilled, onrejected),
        catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
        finally: (onfinally: any) => Promise.resolve(result).finally(onfinally),
        text: result.text,
        json: result.json
    };

    return thenable;
});
deps.$ = mockShellExec as any;


describe("Manager Service Coverage", () => {
    beforeEach(() => {
        mockReaddir.mockReset();
        mockWrite.mockReset();
        mockFileExists.mockReset();
        mockFileText.mockReset();
        mockSpawn.mockReset();
        mockShellExec.mockClear();

        // Default behaviors
        // Default behaviors for simple mocks
        mockReaddir.mockResolvedValue([]);
        mockWrite.mockResolvedValue(undefined as never);
        mockFileExists.mockResolvedValue(false);
        mockFileText.mockResolvedValue("");
        mockSpawn.mockReturnValue({ exited: Promise.resolve(0) } as any);

        // Reset Shell Exec to default success behavior
        mockShellExec.mockImplementation((strings, ...values) => {
            let outputText = "OK";
            const cmdString = strings.join(" ");
            if (cmdString.includes("key info")) {
                outputText = "Key ID: GK123456\nSecret key: 1234567890abcdef";
            }
            const result = {
                exitCode: 0,
                stdout: new TextEncoder().encode(outputText),
                stderr: new Uint8Array(0),
                text: () => Promise.resolve(outputText),
                json: () => Promise.resolve({})
            };
            return {
                then: (onfulfilled: any, onrejected: any) => Promise.resolve(result).then(onfulfilled, onrejected),
                catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
                finally: (onfinally: any) => Promise.resolve(result).finally(onfinally),
                text: result.text,
                json: result.json
            } as any;
        });
    });

    test("getNextPorts (Empty)", async () => {
        const ports = await getNextPorts();
        expect(ports.offset).toBe(10);
    });

    test("createProject - Fail if exists", async () => {
        mockFileExists.mockResolvedValueOnce(true);
        const res = await createProject("test-proj");
        expect(res.success).toBe(false);
        expect(res.message).toContain("exists");
    });

    test("Handler - Create Project Route", async () => {
        // Mock Cookie with JWT
        // We can't easily mock valid JWT verification without importing the secret or mocking verify
        // Ideally we should mock 'verify' from 'hono/jwt' 
        // But since we can't easily mock module imports in Bun test for Hono internals,
        // we might mock 'getCookie' behavior? No, getCookie is imported.

        // Simpler approach: We just test redirection if not logged in, 
        // OR we mock the middleware logic? Hard with integration test style.

        // Mock ADMIN_PASSWORD by re-initializing the manager with a mocked auth file
        // We need to ensure initManager picks up "test-password"

        mockFileText.mockResolvedValue("test-password");

        const authPathCheck = (path: any) => String(path).endsWith(".manager_auth");

        spyOn(deps, "file").mockImplementation((path) => {
            const pathStr = String(path);
            return {
                exists: () => Promise.resolve(authPathCheck(pathStr)),
                text: () => {
                    if (pathStr.endsWith(".manager_auth")) return Promise.resolve("test-password");
                    return Promise.resolve("");
                },
                write: mockWrite
            } as any;
        });

        // Also mock stat for the auth file check in initManager
        mockStat.mockImplementation(async (path: any) => {
            if (authPathCheck(path)) return {} as any;
            throw new Error("File not found");
        });

        const { initManager } = await import("../index");
        await initManager();

        // Let's create a valid token using the same secret.
        // We know the ADMIN_PASSWORD is "test-password" from the setup above.
        const { sign } = await import("hono/jwt");
        const token = await sign({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, "test-password");

        const req = new Request("http://localhost:8888/projects", {
            method: "POST",
            headers: {
                "Cookie": `auth_token=${token}`,
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ name: "api-test" })
        });

        const res = await handler(req);

        // Debugging output if status is not 200 (Clone first)
        if (res.status !== 200) {
            console.error("Handler failed with status:", res.status);
            try {
                const clone = res.clone();
                console.error("Response text:", await clone.text());
            } catch (e) {
                console.error("Could not read response body:", e);
            }
        }

        const data = await res.json();
        expect(data.success).toBe(true);
    });
});
