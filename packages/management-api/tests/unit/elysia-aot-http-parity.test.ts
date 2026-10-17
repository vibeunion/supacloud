import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { platformBuildEnvironment } from "../../../../scripts/elysia-aot-ab";

const execFileAsync = promisify(execFile);
const builder = resolve(import.meta.dir, "../fixtures/aot-http-parity-build.ts");
const runtimeToken = "parity-runtime-only-token-not-build";
type Snapshot = { status: number; contentType: string | null; retryAfter: string | null; body: unknown };
type Case = { name: string; path: string; init?: () => RequestInit; expected: Pick<Snapshot, "status" | "body"> };
const json = (body: string): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body,
});
const validation = { status: 400, body: { message: "Validation failed", code: "VALIDATION_ERROR" } };
const cases: Case[] = [
  { name: "missing query field", path: "/__aot_parity/validation", expected: validation },
  { name: "invalid numeric coercion", path: "/__aot_parity/validation?limit=bad", expected: validation },
  { name: "numeric lower bound", path: "/__aot_parity/validation?limit=0", expected: validation },
  { name: "valid numeric coercion", path: "/__aot_parity/validation?limit=2", expected: { status: 200, body: { value: 2, type: "number" } } },
  { name: "missing body field", path: "/__aot_parity/body", init: () => json("{}"), expected: validation },
  { name: "wrong body type", path: "/__aot_parity/body", init: () => json('{"name":3}'), expected: validation },
  { name: "malformed JSON", path: "/__aot_parity/body", init: () => json('{"name":'), expected: { status: 400, body: { message: "Invalid JSON body", code: "PARSE_ERROR" } } },
  { name: "storage parse envelope", path: "/storage/v1/__aot_parity/body", init: () => json('{"name":'), expected: { status: 400, body: { statusCode: "400", error: "Bad Request", message: "Invalid JSON body" } } },
  { name: "valid body", path: "/__aot_parity/body", init: () => json('{"name":"ok"}'), expected: { status: 200, body: { name: "ok" } } },
  { name: "missing authorization", path: "/__aot_parity/auth", expected: { status: 401, body: { message: "Missing Authorization header", code: "401" } } },
  { name: "malformed authorization", path: "/__aot_parity/auth", init: () => ({ headers: { authorization: "Basic invalid" } }), expected: { status: 401, body: { message: "Invalid Authorization format", code: "401" } } },
  { name: "runtime-only master authorization", path: "/__aot_parity/auth", init: () => ({ headers: { authorization: `Bearer ${runtimeToken}` } }), expected: { status: 200, body: { authorized: true } } },
  { name: "real API auth guard", path: "/v1/projects", expected: { status: 401, body: { message: "Missing Authorization header", code: "401" } } },
  { name: "real disabled reconciliation rejects before parsing", path: "/v1/projects/proj/mutations/not-a-uuid/reconcile", init: () => json('{"private-sentinel":'), expected: { status: 403, body: { error: "Mutation reconciliation is not permitted" } } },
  { name: "real API missing route", path: "/v1/__aot_parity_missing", expected: { status: 404, body: { message: "Route not found", code: "404" } } },
  ...Object.entries({ bad_request: 400, forbidden: 403, conflict: 409, validation: 422, internal: 500, unavailable: 503 }).map(([code, status]) => ({
    name: `AppError ${status}`, path: `/__aot_parity/error/${code}`,
    expected: { status, body: { message: "Controlled error", code: "PARITY_ERROR", details: "safe detail", hint: "safe hint" } },
  })),
  { name: "multipart upload", path: "/__aot_parity/upload", init: () => {
    const body = new FormData();
    body.set("file", new File(["file content"], "test.txt", { type: "text/plain" }));
    return { method: "POST", body };
  }, expected: { status: 200, body: { name: "test.txt", content: "file content" } } },
  { name: "stream response", path: "/__aot_parity/stream", expected: { status: 200, body: "first\nsecond\n" } },
];

async function snapshot(baseUrl: string, scenario: Case): Promise<Snapshot> {
  const response = await fetch(`${baseUrl}${scenario.path}`, {
    ...scenario.init?.(), signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* Streaming text is not JSON. */ }
  return {
    status: response.status, contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"), body,
  };
}

describe("Management API Elysia AOT public HTTP contract", () => {
  const children: Bun.Subprocess[] = [];
  const drains: Promise<unknown>[] = [];
  let directory: string | undefined;
  const urls: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "supacloud-management-aot-parity-"));
    for (const mode of ["plain", "aot"]) {
      const { stderr } = await execFileAsync(process.execPath, ["--no-env-file", builder, mode, directory], {
        cwd: directory, env: platformBuildEnvironment(directory),
        timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      });
      if (stderr.includes("coercion/codec")) console.info(`${mode}: coercion/codec warning retained; HTTP parity required`);
      const artifact = join(directory, `management-api-${mode}.js`);
      expect((await stat(artifact)).size).toBeGreaterThan(100_000);
      const child = Bun.spawn([process.execPath, "--no-env-file", artifact], {
        cwd: directory,
        env: { ...platformBuildEnvironment(directory), MASTER_TOKEN: runtimeToken },
        stdout: "pipe", stderr: "pipe",
      });
      children.push(child);
      let buffer = "";
      const errors = new Response(child.stderr).text();
      drains.push(errors);
      const ready = new Promise<string>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error(`${mode} startup timed out`)), 10_000);
        const output = (async () => {
          for await (const chunk of child.stdout) {
            buffer = (buffer + new TextDecoder().decode(chunk)).slice(-32_768);
            const match = buffer.match(/PARITY_READY=(\d+)/);
            if (match) {
              clearTimeout(timeout);
              resolveReady(`http://127.0.0.1:${match[1]}`);
            }
          }
        })();
        drains.push(output);
        void output.catch(rejectReady);
        void child.exited.then(async (code) => {
          clearTimeout(timeout);
          rejectReady(new Error(`${mode} exited (${code}): ${buffer}\n${await errors}`));
        });
      });
      urls.push(await ready);
    }
  }, 90_000);

  afterAll(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await Promise.all(drains);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test.each(cases)("$name", async (scenario) => {
    const [plain, compiled] = await Promise.all(urls.map((url) => snapshot(url, scenario)));
    expect(plain && { status: plain.status, body: plain.body }).toEqual(scenario.expected);
    expect(compiled && { status: compiled.status, body: compiled.body }).toEqual(scenario.expected);
    expect(compiled).toEqual(plain);
  });

  test("production OpenAPI JSON", async () => {
    const [plain, compiled] = await Promise.all(urls.map(url => snapshot(url, {
      name: "openapi", path: "/swagger/json", expected: { status: 200, body: {} },
    })));
    expect(plain?.status).toBe(200);
    expect(plain?.body).toMatchObject({ info: { title: "SupaCloud Management API" } });
    expect(compiled).toEqual(plain);
  });

  test("WebSocket upgrade and message", async () => {
    const replies = await Promise.all(urls.map(url => new Promise<string>((resolveReply, rejectReply) => {
      const socket = new WebSocket(url.replace("http:", "ws:") + "/__aot_parity/ws");
      const timer = setTimeout(() => { socket.close(); rejectReply(new Error("WebSocket timed out")); }, 3_000);
      socket.onopen = () => socket.send("parity-echo");
      socket.onmessage = event => {
        clearTimeout(timer);
        socket.close();
        resolveReply(String(event.data));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        socket.close();
        rejectReply(new Error("WebSocket failed"));
      };
    })));
    expect(replies).toEqual(["parity-echo", "parity-echo"]);
  });
});
