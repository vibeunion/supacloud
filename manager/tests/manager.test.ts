
import { describe, expect, test, mock, beforeEach, spyOn } from "bun:test";
import { handler, createProject, getNextPorts, deps } from "../index";

// Mock Deps
const mockReaddir = spyOn(deps, "readdir");
const mockWrite = spyOn(deps, "write");
const mockFileExists = mock(() => Promise.resolve(false));
const mockFileText = mock(() => Promise.resolve(""));
const mockSpawn = spyOn(deps, "spawn");

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

    test("createProject - Success Path (Garage Provisioned)", async () => {
        const res = await createProject("test-proj");

        expect(res.success).toBe(true);
        expect(res.port).toBe(3010);

        // Verify .env was written and contains Garage Keys
        expect(mockWrite).toHaveBeenCalled();
        const callArgs = mockWrite.mock.calls[0];
        const envContent = callArgs[1] as unknown as string;
        expect(envContent).toContain("GK123456"); // Key ID from mock
    });

    test("createProject - Garage Fail, Fallback to Global Keys", async () => {
        // We want to simulate failure specifically when running garage commands.
        // The mockShellExec defined at top checks args strictly.
        // We can update it to throw if it sees "garage"

        mockShellExec.mockImplementation((strings, ...values) => {
            const cmdString = strings.join(" ");
            if (cmdString.includes("garage")) {
                throw new Error("Garage Down");
            }

            const outputText = "OK";
            const result = {
                exitCode: 0,
                stdout: new TextEncoder().encode(outputText),
                stderr: new Uint8Array(0),
                text: () => Promise.resolve(outputText),
                json: () => Promise.resolve({})
            };

            const thenable = {
                then: (onfulfilled: any, onrejected: any) => Promise.resolve(result).then(onfulfilled, onrejected),
                catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
                finally: (onfinally: any) => Promise.resolve(result).finally(onfinally),
                text: result.text,
                json: result.json
            };
            return thenable as any;
        });

        // Mock global keys file
        mockFileText.mockResolvedValueOnce("GARAGE_ACCESS_KEY=global-access\nGARAGE_SECRET_KEY=global-secret");

        const res = await createProject("test-fallback");
        expect(res.success).toBe(true); // Should succeed via fallback

        // Check if fallback keys were used
        // We need to find the write call to .env
        const writeCalls = mockWrite.mock.calls;
        const envWrite = writeCalls.find(c => (c[0] as unknown as string).endsWith(".env"));
        expect(envWrite).toBeDefined();
        const envContent = envWrite![1] as unknown as string;
        expect(envContent).toContain("global-access");
    });

    test("createProject - Fail if exists", async () => {
        mockFileExists.mockResolvedValueOnce(true);
        const res = await createProject("test-proj");
        expect(res.success).toBe(false);
        expect(res.message).toContain("exists");
    });

    test("Handler - Create Project Route", async () => {
        // Mock Auth header
        const authHeader = `Basic ${btoa("admin:test-password")}`;

        // Mock global ADMIN_PASSWORD
        // Since ADMIN_PASSWORD is a module-level variable in index.ts that is set via initManager
        // we might need to rely on the fact that initManager sets it.
        // However, initManager reads from file.
        // Let's mock the file read for AUTH_FILE (which is handled by mockFileText in beforeEach)

        // Update mock for AUTH_FILE
        mockFileText.mockResolvedValue("test-password");

        // We need to trigger initManager to load the password?
        // Actually, initManager isn't exported to be called here easily without side effects?
        // It is exported! Let's import it.
        const { initManager } = await import("../index");

        // Mock exists for AUTH_FILE to be true
        // Correct approach:
        // We need to customize deps.file to return a specific exists mock based on the path
        spyOn(deps, "file").mockImplementation((path) => {
            const pathStr = String(path);
            return {
                exists: () => {
                    if (pathStr.endsWith(".manager_auth")) return Promise.resolve(true);
                    return Promise.resolve(false);
                },
                text: () => {
                    if (pathStr.endsWith(".manager_auth")) return Promise.resolve("test-password");
                    return Promise.resolve("");
                },
                write: mockWrite
            } as any;
        });

        await initManager();

        const req = new Request("http://localhost:8888/projects", {
            method: "POST",
            headers: {
                "Authorization": authHeader,
                "Accept": "application/json"
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
