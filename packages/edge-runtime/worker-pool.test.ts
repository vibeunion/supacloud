import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { WorkerPool } from "./worker-pool";
import {
  EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA,
  type EdgeRuntimePreheatIdentity,
} from "./preheat-attestation";

const pools: WorkerPool[] = [];
const linuxDescriptorTest = process.platform === "linux" ? test : test.skip;

async function functionArtifactSha256(functionPath: string): Promise<string> {
  const artifactBytes = Buffer.from(await Bun.file(functionPath).arrayBuffer());
  return createHash("sha256").update(artifactBytes).digest("hex");
}

function preheatIdentity(request: {
  projectRef: string;
  functionSlug: string;
  version: string;
  artifactSha256: string;
  requestedVersion?: string | null;
}): EdgeRuntimePreheatIdentity {
  return {
    schema: EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA,
    project_ref: request.projectRef,
    function_slug: request.functionSlug,
    requested_version: request.requestedVersion ?? null,
    target_version: request.version,
    resolved_version: request.version,
    artifact_sha256: request.artifactSha256,
    verify_jwt: true,
    activation_id: null,
    runtime_instance_id: "00000000-0000-4000-8000-000000000001",
    execution_profile: "foreground",
    module_env_proof: `hmac-sha256:${"c".repeat(64)}`,
    tenant_env: {
      loaded_revision: `hmac-sha256:${"a".repeat(64)}`,
      env_proof: `hmac-sha256:${"b".repeat(64)}`,
      load_state: "loaded",
      load_source: "management_api",
    },
  };
}

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    await pool.shutdown();
  }
});

describe("WorkerPool runtime-owned response metadata", () => {
  test("overwrites tenant version headers and removes them for legacy dispatches", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-function-version-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default (request) => new Response(
        request.headers.get("x-supacloud-function-version") || "absent",
        {
          headers: { "x-supacloud-function-version": "tenant-forged" },
        },
      );
    `);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const versioned = await pool.dispatch({
        functionId: "proj_versioned_v12",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "12",
        env: {},
        request: new Request("http://edge.local/functions/v1/versioned", {
          headers: { "x-supacloud-function-version": "client-spoof" },
        }),
      });
      expect(versioned.headers.get("x-supacloud-function-version")).toBe("12");
      expect(await versioned.text()).toBe("absent");

      const legacy = await pool.dispatch({
        functionId: "proj_versioned",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: null,
        env: {},
        request: new Request("http://edge.local/functions/v1/versioned"),
      });
      expect(legacy.headers.has("x-supacloud-function-version")).toBe(false);

      const omittedLegacy = await pool.dispatch({
        functionId: "proj_versioned_omitted",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/versioned"),
      });
      expect(omittedLegacy.headers.has("x-supacloud-function-version")).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects non-canonical active versions before worker dispatch", async () => {
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const invalidVersions = [
      "0",
      "01",
      "-1",
      "v12",
      "9007199254740992",
      "1".repeat(128),
    ];

    for (const functionVersion of invalidVersions) {
      await expect(pool.dispatch({
        functionId: "proj_invalid_version",
        projectRef: "test-project",
        functionPath: "/unused/fn.ts",
        projectRoot: "/unused",
        functionVersion,
        env: {},
        request: new Request("http://edge.local/functions/v1/versioned"),
      })).rejects.toThrow("Function version must be a canonical positive safe integer");
    }
  });

  test("marks tenant failures with the dispatched active version", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-function-version-error-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `export default () => { throw new Error("tenant failure"); };`);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_versioned_error_v13",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "13",
        env: {},
        request: new Request("http://edge.local/functions/v1/versioned-error"),
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("x-supacloud-function-version")).toBe("13");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps response metadata bound across active version ABA changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-function-version-aba-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `export default () => new Response("ok");`);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      for (const functionVersion of ["31", "32", "31"]) {
        const response = await pool.dispatch({
          functionId: `proj_versioned_v${functionVersion}`,
          projectRef: "test-project",
          functionPath,
          projectRoot,
          functionVersion,
          moduleVersion: functionVersion,
          env: {},
          request: new Request("http://edge.local/functions/v1/versioned"),
        });
        expect(response.headers.get("x-supacloud-function-version")).toBe(functionVersion);
        expect(await response.text()).toBe("ok");
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("does not attach a version when postMessage fails synchronously", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-function-version-post-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `export default () => new Response("unused");`);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const [worker] = (pool as unknown as {
      idle: Array<{ postMessage: (message: unknown) => void }>;
    }).idle;
    worker.postMessage = () => {
      throw new Error("postMessage failed");
    };

    try {
      const response = await pool.dispatch({
        functionId: "proj_versioned_post_v14",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "14",
        env: {},
        request: new Request("http://edge.local/functions/v1/versioned-post"),
      });
      expect(response.status).toBe(500);
      expect(response.headers.has("x-supacloud-function-version")).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Bun.file(path).text();
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForMetric(
  pool: WorkerPool,
  metric: string,
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pool.snapshotMetrics("test")[`test_${metric}`] === expected) return;
    await Bun.sleep(10);
  }
  const currentMetricValue = pool.snapshotMetrics("test")[`test_${metric}`];
  throw new Error(`Timed out waiting for ${metric}=${expected}; current=${currentMetricValue}`);
}

async function waitForResponse(
  responsePromise: Promise<Response>,
  timeoutMs: number,
): Promise<Response | null> {
  return Promise.race([
    responsePromise,
    Bun.sleep(timeoutMs).then(() => null),
  ]);
}

describe("WorkerPool EdgeRuntime.waitUntil", () => {
  test("keeps tenant env available after the HTTP response is returned", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-waituntil-"));
    const outputPath = join(projectRoot, "waituntil.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          globalThis.EdgeRuntime.waitUntil((async () => {
            await Bun.sleep(25);
            await Bun.write(process.env.OUT_FILE, process.env.SUPABASE_URL || "missing");
          })());
          return new Response("queued", { status: 202 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_waituntil",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {
          OUT_FILE: outputPath,
          SUPABASE_URL: "http://tenant.local",
        },
        request: new Request("http://edge.local/functions/v1/waituntil", { method: "POST" }),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("queued");
      expect(await waitForFile(outputPath)).toBe("http://tenant.local");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool subprocess guard", () => {
  test("allows import.meta.require aliases to load safe Node builtins", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-import-meta-require-"));
    const functionPath = join(projectRoot, "entry.js");
    await Bun.write(functionPath, `
      var __require = import.meta.require;
      var ttyModule = __require("tty");
      var utilModule = __require("util");
      export default () => {
        const supported = typeof ttyModule.isatty === "function"
          && utilModule.format("%s", "safe") === "safe";
        return new Response(supported ? "safe" : "mismatch");
      };
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_import_meta_require",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/import-meta-require"),
      });
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 200,
        body: "safe",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("allows safe Node builtins that use internal bindings during initialization", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-internal-builtin-"));
    const functionPath = join(projectRoot, "entry.js");
    await Bun.write(functionPath, `
      import * as netModule from "net";
      import * as tlsModule from "tls";
      export default () => {
        const supported = typeof netModule.createServer === "function"
          && typeof tlsModule.createServer === "function";
        return new Response(supported ? "safe" : "mismatch");
      };
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_internal_builtin",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/internal-builtin"),
      });
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 200,
        body: "safe",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("allows CJS dependencies to load explicitly allowed Node builtins", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-safe-builtin-module-"));
    const dependencyPath = join(projectRoot, "dependency.cjs");
    const functionPath = join(projectRoot, "entry.ts");
    await Bun.write(dependencyPath, `
      const nodeCrypto = require("node:crypto");
      const bareCrypto = require("crypto");
      const ttyModule = require("tty");
      const utilModule = require("util");
      module.exports = () => {
        const digest = nodeCrypto.createHash("sha256").update("safe").digest("hex");
        const formatted = utilModule.format("%s", digest);
        const hasTtyApi = typeof ttyModule.isatty === "function";
        return bareCrypto.timingSafeEqual(Buffer.from(digest), Buffer.from(digest))
          && hasTtyApi
          && formatted === digest
          ? digest
          : "mismatch";
      };
    `);
    await Bun.write(functionPath, `
      import hash from "./dependency.cjs";
      export default () => new Response(hash());
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_safe_builtin_module",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/safe-builtin-module"),
      });
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 200,
        body: "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects non-allowlisted runtime builtins", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-denied-builtin-module-"));
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      for (const [index, builtinSpecifier] of ["bun:sqlite", "node:sqlite", "wasi"].entries()) {
        const functionPath = join(projectRoot, `denied-${index}.ts`);
        await Bun.write(functionPath, `
          import * as denied from ${JSON.stringify(builtinSpecifier)};
          export default () => new Response(String(denied));
        `);
        const response = await pool.dispatch({
          functionId: `proj_denied_builtin_${index}`,
          projectRef: "test-project",
          functionPath,
          projectRoot,
          env: {},
          request: new Request(`http://edge.local/functions/v1/denied-builtin-${index}`),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Native and builtin module loaders are disabled in the multi-tenant Edge Runtime.",
          name: "Error",
        });
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks direct and computed imports for every fs module alias", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-filesystem-module-"));
    const dynamicPath = join(projectRoot, "dynamic.ts");
    await Bun.write(dynamicPath, `
      export default async function () {
        Error.prepareStackTrace = () => "";
        const moduleName = process.env.FS_MODULE;
        const fs = await import(moduleName);
        const contents = fs.readFileSync
          ? fs.readFileSync("/etc/hosts", "utf8")
          : await fs.readFile("/etc/hosts", "utf8");
        return new Response(contents);
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (functionId: string, functionPath: string, fsModule: string) => pool.dispatch({
      functionId,
      projectRef: "test-project",
      functionPath,
      projectRoot,
      env: { FS_MODULE: fsModule },
      request: new Request(`http://edge.local/functions/v1/${functionId}`),
    });

    try {
      for (const [index, fsModule] of [
        "fs",
        "node:fs",
        "fs/promises",
        "node:fs/promises",
      ].entries()) {
        const directPath = join(projectRoot, `direct-${index}.ts`);
        await Bun.write(directPath, `
          import * as fs from ${JSON.stringify(fsModule)};
          export default () => new Response(String(fs));
        `);
        const directResponse = await dispatch(`proj_fs_direct_${index}`, directPath, fsModule);
        expect(directResponse.status).toBe(500);
        expect(await directResponse.json()).toEqual({
          error: "Direct file system module access is disabled in the multi-tenant Edge Runtime.",
          name: "Error",
        });

        const dynamicResponse = await dispatch(`proj_fs_dynamic_${index}`, dynamicPath, fsModule);
        expect(dynamicResponse.status).toBe(500);
        expect(await dynamicResponse.json()).toEqual({
          error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
          name: "Error",
        });
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks computed filesystem imports before runtime dependency reads", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-runtime-read-root-"));
    const functionPath = join(projectRoot, "runtime-read.ts");
    const dependencyPath = Bun.resolveSync("elysia", import.meta.dir);
    const runtimePath = join(import.meta.dir, "package.json");
    await Bun.write(functionPath, `
      export default async function () {
        const moduleName = ["node", "fs"].join(":");
        const fs = await import(moduleName);
        let runtime;
        try {
          runtime = fs.readFileSync(process.env.RUNTIME_PATH, "utf8");
        } catch (error) {
          runtime = error.message;
        }
        return Response.json({
          dependency: fs.readFileSync(process.env.DEPENDENCY_PATH, "utf8"),
          runtime,
        });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_runtime_read_root",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { DEPENDENCY_PATH: dependencyPath, RUNTIME_PATH: runtimePath },
        request: new Request("http://edge.local/functions/v1/runtime-read"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects project-external modules under untrusted node_modules directories", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-module-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "supacloud-untrusted-module-"));
    const outsideModule = join(outsideRoot, "node_modules", "untrusted", "index.ts");
    const functionPath = join(projectRoot, "entry.ts");
    await mkdir(join(outsideRoot, "node_modules", "untrusted"), { recursive: true });
    await Bun.write(outsideModule, `export default "outside";`);
    await Bun.write(functionPath, `
      import outside from ${JSON.stringify(outsideModule)};
      export default () => new Response(outside);
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_untrusted_module_root",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/untrusted-module"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: `Access denied: module "${outsideModule}" is outside the project directory`,
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("allows literal dynamic imports and blocks computed module targets", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-dynamic-module-project-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "supacloud-dynamic-module-outside-"));
    const localModulePath = join(projectRoot, "local.ts");
    const outsideModulePath = join(outsideRoot, "outside.ts");
    const literalFunctionPath = join(projectRoot, "literal-import.ts");
    const computedFunctionPath = join(projectRoot, "computed-import.ts");
    await Bun.write(localModulePath, `export default "project-module";`);
    await Bun.write(outsideModulePath, `export default "outside-module";`);
    await Bun.write(literalFunctionPath, `
      export default async function () {
        const imported = await import("./local.ts");
        return new Response(imported.default);
      }
    `);
    await Bun.write(computedFunctionPath, `
      export default async function () {
        const imported = await import(process.env.MODULE_PATH);
        return new Response(imported.default);
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (functionId: string, functionPath: string, modulePath: string) => pool.dispatch({
      functionId,
      projectRef: "test-project",
      functionPath,
      projectRoot,
      env: { MODULE_PATH: modulePath },
      request: new Request(`http://edge.local/functions/v1/${functionId}`),
    });

    try {
      const localResponse = await dispatch("proj_dynamic_local", literalFunctionPath, localModulePath);
      expect(localResponse.status).toBe(200);
      expect(await localResponse.text()).toBe("project-module");

      const outsideResponse = await dispatch("proj_dynamic_outside", computedFunctionPath, outsideModulePath);
      expect(outsideResponse.status).toBe(500);
      expect(await outsideResponse.json()).toEqual({
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("reports the worker error when preheat rejects a computed dynamic import", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-import-project-"));
    const functionPath = join(projectRoot, "computed-import.ts");
    const recoveryPath = join(projectRoot, "recovery.ts");
    await Bun.write(functionPath, `
      const moduleName = process.env.MODULE_PATH;
      export default async function () {
        return new Response(String(await import(moduleName)));
      }
    `);
    await Bun.write(recoveryPath, `export default () => new Response("replacement");`);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheat = await pool.preheatIdleWorkers(
        "proj_preheat_computed",
        functionPath,
        projectRoot,
        { MODULE_PATH: "./local.ts" },
        { projectRef: "proj_preheat" },
      );

      expect(preheat.succeeded).toBe(0);
      expect(preheat.error).toBe("Computed dynamic imports are disabled in the multi-tenant Edge Runtime.");
      expect(pool.snapshotMetrics("failed_preheat")["failed_preheat_total_worker_retirements"]).toBe(1);

      const response = await pool.dispatch({
        functionId: "proj_preheat_recovery",
        projectRef: "test-project",
        functionPath: recoveryPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/recovery"),
      });
      expect(await response.text()).toBe("replacement");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  linuxDescriptorTest("returns a matching worker preheat attestation", async () => {
    const projectRoot = await mkdtemp(join(homedir(), ".supacloud-preheat-attested-"));
    const functionPath = join(projectRoot, "attested.ts");
    await Bun.write(functionPath, `export default () => new Response("attested");`);
    const artifactSha256 = await functionArtifactSha256(functionPath);
    const attestation = preheatIdentity({
      projectRef: "proj_preheat_attested",
      functionSlug: "attested",
      version: "1",
      artifactSha256,
    });
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheat = await pool.preheatIdleWorkers(
        "proj_preheat_attested_attested_v1",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat_attested", moduleVersion: "v1", attestation },
      );

      expect(preheat).toMatchObject({ succeeded: 1, cacheMisses: 1 });
      expect(preheat.attestation).toEqual({ ...attestation, module_loaded: true });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  linuxDescriptorTest("preheats a legacy version-zero artifact with a matching attestation", async () => {
    const projectRoot = await mkdtemp(join(homedir(), ".supacloud-preheat-legacy-zero-"));
    const functionPath = join(projectRoot, "legacy-zero.ts");
    await Bun.write(functionPath, `export default () => new Response("legacy-zero");`);
    const artifactSha256 = await functionArtifactSha256(functionPath);
    const attestation = preheatIdentity({
      projectRef: "proj_preheat_legacy_zero",
      functionSlug: "legacy_zero",
      version: "0",
      requestedVersion: "0",
      artifactSha256,
    });
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheat = await pool.preheatVersionedIdleWorkers({
        functionId: "proj_preheat_legacy_zero_legacy_zero_v0",
        functionPath,
        projectRoot,
        env: {},
        projectRef: "proj_preheat_legacy_zero",
        moduleVersion: "v0",
        attestation,
      });

      expect(preheat).toMatchObject({ succeeded: 1, cacheMisses: 1 });
      expect(preheat.attestation).toEqual({ ...attestation, module_loaded: true });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  linuxDescriptorTest("rejects a worker preheat whose artifact hash changed", async () => {
    const projectRoot = await mkdtemp(join(homedir(), ".supacloud-preheat-hash-mismatch-"));
    const functionPath = join(projectRoot, "attested.ts");
    await Bun.write(functionPath, `export default () => new Response("actual");`);
    const attestation = preheatIdentity({
      projectRef: "proj_preheat_hash",
      functionSlug: "attested",
      version: "1",
      artifactSha256: "c".repeat(64),
    });
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheat = await pool.preheatIdleWorkers(
        "proj_preheat_hash_attested_v1",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat_hash", moduleVersion: "v1", attestation },
      );

      expect(preheat.succeeded).toBe(0);
      expect(preheat.error).toBe("Function artifact SHA-256 does not match activation authority");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  linuxDescriptorTest("does not reuse a module cache entry after artifact replacement", async () => {
    const projectRoot = await mkdtemp(join(homedir(), ".supacloud-preheat-artifact-aba-"));
    const functionPath = join(projectRoot, "attested.ts");
    const projectRef = "proj_preheat_aba";
    const functionSlug = "attested";
    const functionId = `${projectRef}_${functionSlug}_v1`;
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const preheatCurrentArtifact = async () => {
      const artifactSha256 = await functionArtifactSha256(functionPath);
      return pool.preheatIdleWorkers(functionId, functionPath, projectRoot, {}, {
        projectRef,
        moduleVersion: "stable-version-metadata",
        attestation: preheatIdentity({ projectRef, functionSlug, version: "1", artifactSha256 }),
      });
    };

    try {
      await Bun.write(functionPath, `export default () => new Response("A");`);
      expect(await preheatCurrentArtifact()).toMatchObject({ succeeded: 1, cacheMisses: 1 });

      await Bun.write(functionPath, `export default () => new Response("B");`);
      const artifactSha256 = await functionArtifactSha256(functionPath);
      expect(await preheatCurrentArtifact()).toMatchObject({ succeeded: 1, cacheMisses: 1 });
      const response = await pool.dispatch({
        functionId,
        functionPath,
        projectRoot,
        projectRef,
        moduleVersion: "stable-version-metadata",
        artifactSha256,
        env: {},
        request: new Request("http://edge.local/functions/v1/attested"),
      });
      expect(await response.text()).toBe("B");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  linuxDescriptorTest("rejects an attested cache hit before execution after artifact replacement", async () => {
    const projectRoot = await mkdtemp(join(homedir(), ".supacloud-dispatch-artifact-cache-"));
    const functionPath = join(projectRoot, "attested.ts");
    const artifactSource = `export default () => new Response("authority");`;
    await Bun.write(functionPath, artifactSource);
    const artifactSha256 = await functionArtifactSha256(functionPath);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    let executions = 0;

    const dispatch = () => pool.dispatch({
      functionId: "proj_dispatch_artifact_attested_v1",
      functionPath,
      projectRoot,
      projectRef: "proj_dispatch_artifact",
      functionVersion: "1",
      moduleVersion: "activation-1",
      artifactSha256,
      env: {},
      request: new Request("http://edge.local/functions/v1/attested"),
      onExecutionStarted: () => executions++,
    });

    try {
      const first = await dispatch();
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("authority");
      expect(executions).toBe(1);

      await Bun.write(functionPath, `export default () => new Response("replacement");`);
      const rejected = await dispatch();
      expect(rejected.status).toBe(500);
      expect(await rejected.text()).not.toContain("replacement");
      expect(executions).toBe(1);

      await Bun.write(functionPath, artifactSource);
      const restored = await dispatch();
      expect(restored.status).toBe(200);
      expect(await restored.text()).toBe("authority");
      expect(executions).toBe(2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks computed imports from exposing runtime filesystem capabilities", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-runtime-module-project-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "supacloud-runtime-module-outside-"));
    const outsideAssetPath = join(outsideRoot, "secret.txt");
    const runtimeModulePath = join(import.meta.dir, "deno-compat.ts");
    const functionPath = join(projectRoot, "runtime-import.ts");
    await Bun.write(outsideAssetPath, "outside-secret");
    await Bun.write(functionPath, `
      export default async function () {
        const runtime = await import(process.env.RUNTIME_MODULE_PATH);
        const direct = await runtime.runtimeFile(process.env.OUTSIDE_ASSET_PATH).text();
        runtime.setProjectRoot(process.env.OUTSIDE_ROOT);
        const rerooted = await Bun.file(process.env.OUTSIDE_ASSET_PATH).text();
        return Response.json({ direct, rerooted });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_runtime_module_escape",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {
          OUTSIDE_ASSET_PATH: outsideAssetPath,
          OUTSIDE_ROOT: outsideRoot,
          RUNTIME_MODULE_PATH: runtimeModulePath,
        },
        request: new Request("http://edge.local/functions/v1/runtime-import"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("blocks file URL imports and hidden dynamic code generation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-module-protocol-project-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "supacloud-module-protocol-outside-"));
    const outsideModulePath = join(outsideRoot, "outside.ts");
    const fileUrlFunctionPath = join(projectRoot, "file-url.ts");
    const unsupportedUrlFunctionPath = join(projectRoot, "unsupported-url.ts");
    const generatedImportFunctionPath = join(projectRoot, "generated-import.ts");
    const outsideModuleUrl = pathToFileURL(outsideModulePath).href;
    await Bun.write(outsideModulePath, `export default "outside-module";`);
    await Bun.write(fileUrlFunctionPath, `
      import outside from ${JSON.stringify(outsideModuleUrl)};
      export default () => new Response(outside);
    `);
    await Bun.write(unsupportedUrlFunctionPath, `
      import outside from "data:text/javascript,export default 'outside'";
      export default () => new Response(outside);
    `);
    await Bun.write(generatedImportFunctionPath, `
      function capture(create) {
        try {
          create();
          return "allowed";
        } catch (error) {
          return error.message;
        }
      }

      export default function () {
        return Response.json({
          eval: capture(() => eval("import(process.env.MODULE_PATH)")),
          function: capture(() => Function("return import(process.env.MODULE_PATH)")),
          constructor: capture(() => (() => {}).constructor("return import(process.env.MODULE_PATH)")),
        });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (functionId: string, functionPath: string) => pool.dispatch({
      functionId,
      projectRef: "test-project",
      functionPath,
      projectRoot,
      env: { MODULE_PATH: outsideModulePath },
      request: new Request(`http://edge.local/functions/v1/${functionId}`),
    });

    try {
      const fileUrlResponse = await dispatch("proj_file_url", fileUrlFunctionPath);
      expect(fileUrlResponse.status).toBe(500);
      expect(await fileUrlResponse.json()).toEqual({
        error: `Access denied: module "${outsideModuleUrl}" is outside the project directory`,
        name: "Error",
      });

      const unsupportedUrlResponse = await dispatch(
        "proj_unsupported_url",
        unsupportedUrlFunctionPath,
      );
      expect(unsupportedUrlResponse.status).toBe(500);
      expect(await unsupportedUrlResponse.json()).toEqual({
        error: "Unsupported module URL protocol in the multi-tenant Edge Runtime.",
        name: "Error",
      });

      const generatedImportResponse = await dispatch(
        "proj_generated_import",
        generatedImportFunctionPath,
      );
      expect(generatedImportResponse.status).toBe(200);
      expect(await generatedImportResponse.json()).toEqual({
        eval: "Dynamic code generation is disabled in the multi-tenant Edge Runtime.",
        function: "Dynamic code generation is disabled in the multi-tenant Edge Runtime.",
        constructor: "Dynamic code generation is disabled in the multi-tenant Edge Runtime.",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("allows project-local file URL imports", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-local-file-url-project-"));
    const localModulePath = join(projectRoot, "local.ts");
    const functionPath = join(projectRoot, "file-url.ts");
    await Bun.write(localModulePath, `export default "project-module";`);
    await Bun.write(functionPath, `
      import local from ${JSON.stringify(pathToFileURL(localModulePath).href)};
      export default () => new Response(local);
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    try {
      const response = await pool.dispatch({
        functionId: "proj_local_file_url",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/local-file-url"),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("project-module");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks Bun host capabilities that bypass project guards", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-host-capability-project-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "supacloud-host-capability-outside-"));
    const outsideAssetPath = join(outsideRoot, "secret.txt");
    const functionPath = join(projectRoot, "host-capabilities.ts");
    await Bun.write(outsideAssetPath, "outside-secret");
    await Bun.write(functionPath, `
      async function capture(call) {
        try {
          await call();
          return "allowed";
        } catch (error) {
          return error.message;
        }
      }

      export default async function () {
        return Response.json({
          build: await capture(() => Bun.build({ entrypoints: [process.env.OUTSIDE_ASSET] })),
          mmap: await capture(() => Bun.mmap(process.env.OUTSIDE_ASSET)),
          heap: await capture(() => Bun.generateHeapSnapshot()),
          listen: await capture(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {} })),
          ffi: await capture(() => Bun.FFI.ptr(new ArrayBuffer(8))),
        });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_host_capabilities",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { OUTSIDE_ASSET: outsideAssetPath },
        request: new Request("http://edge.local/functions/v1/host-capabilities"),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        build: "Dynamic code generation is disabled in the multi-tenant Edge Runtime.",
        mmap: "Direct file system module access is disabled in the multi-tenant Edge Runtime.",
        heap: "Host runtime capabilities are disabled in the multi-tenant Edge Runtime.",
        listen: "Host runtime capabilities are disabled in the multi-tenant Edge Runtime.",
        ffi: "Native and builtin module loaders are disabled in the multi-tenant Edge Runtime.",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("confines Bun file APIs to the active project including symlinks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-bun-file-project-"));
    const siblingRoot = await mkdtemp(join(tmpdir(), "supacloud-bun-file-sibling-"));
    const functionPath = join(projectRoot, "files.ts");
    const projectAsset = join(projectRoot, "asset.txt");
    const siblingAsset = join(siblingRoot, "secret.txt");
    const symlinkPath = join(projectRoot, "escape");
    const symlinkAsset = join(symlinkPath, "secret.txt");
    const symlinkWrite = join(symlinkPath, "written.txt");
    await Bun.write(projectAsset, "project-asset");
    await Bun.write(siblingAsset, "sibling-secret");
    await symlink(siblingRoot, symlinkPath, "dir");
    await Bun.write(functionPath, `
      import { file, write } from "bun";

      async function capture(read) {
        try {
          return await read();
        } catch (error) {
          return error.message;
        }
      }

      export default async function () {
        return Response.json({
          project: await file(process.env.PROJECT_ASSET).text(),
          hosts: await capture(() => file("/etc/hosts").text()),
          sibling: await capture(() => file(process.env.SIBLING_ASSET).text()),
          symlink: await capture(() => file(process.env.SYMLINK_ASSET).text()),
          symlinkWrite: await capture(() => write(process.env.SYMLINK_WRITE, "escaped")),
        });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_bun_file_boundary",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {
          PROJECT_ASSET: projectAsset,
          SIBLING_ASSET: siblingAsset,
          SYMLINK_ASSET: symlinkAsset,
          SYMLINK_WRITE: symlinkWrite,
        },
        request: new Request("http://edge.local/functions/v1/files"),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as Record<string, string>;
      expect(result.project).toBe("project-asset");
      expect(result.hosts).toContain("outside the project directory");
      expect(result.sibling).toContain("outside the project directory");
      expect(result.symlink).toContain("escapes through a symbolic link");
      expect(result.symlinkWrite).toContain("escapes through a symbolic link");
      expect(await Bun.file(siblingAsset).text()).toBe("sibling-secret");
      expect(await Bun.file(symlinkWrite).exists()).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(siblingRoot, { recursive: true, force: true });
    }
  });

  test("blocks computed native loader imports", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-native-loader-"));
    const functionPath = join(projectRoot, "native.ts");
    await Bun.write(functionPath, `
      function capture(call) {
        try {
          call();
          return "allowed";
        } catch (error) {
          return error.message;
        }
      }

      export default async function () {
        const moduleName = ["node", "module"].join(":");
        const moduleApi = await import(moduleName);
        return Response.json({
          dlopen: capture(() => process.dlopen()),
          binding: capture(() => process.binding()),
          linkedBinding: capture(() => process._linkedBinding()),
          getBuiltinModule: capture(() => process.getBuiltinModule("node:fs")),
          createRequire: capture(() => moduleApi.createRequire(import.meta.url)("node:fs")),
        });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_native_loader",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/native"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks Bun spawn imported by tenant code", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-subprocess-"));
    const functionPath = join(projectRoot, "spawn.ts");
    await Bun.write(functionPath, `
      import { spawn } from "bun";
      export default async function () {
        const child = spawn(["true"]);
        await child.exited;
        return new Response("spawned");
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_subprocess",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/spawn"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Subprocess execution is disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks tenant workers before they can regain subprocess APIs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-worker-subprocess-"));
    const functionPath = join(projectRoot, "worker-spawn.ts");
    await Bun.write(functionPath, `
      export default async function () {
        const moduleName = ["node", "worker_threads"].join(":");
        const { Worker } = await import(moduleName);
        const worker = new Worker(
          'postMessage(Bun.spawnSync(["true"]).exitCode)',
          { eval: true },
        );
        return new Response(String(await new Promise((resolve) => {
          worker.once("message", resolve);
        })));
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_worker_subprocess",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/worker-spawn"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks bun:ffi before tenant code can call native process APIs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-ffi-subprocess-"));
    const functionPath = join(projectRoot, "ffi.ts");
    await Bun.write(functionPath, `
      export default async function () {
        const moduleName = ["bun", "ffi"].join(":");
        const { dlopen, FFIType } = await import(moduleName);
        const libc = dlopen("libc.so.6", {
          system: { args: [FFIType.cstring], returns: FFIType.i32 },
        });
        return new Response(String(libc.symbols.system(Buffer.from("true\\0"))));
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_ffi_subprocess",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/ffi"),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
        name: "Error",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("allows Bun text assets while scanning tenant module imports", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-text-import-"));
    const functionPath = join(projectRoot, "asset.ts");
    await Bun.write(join(projectRoot, "message.txt"), "asset-loaded");
    await Bun.write(functionPath, `
      import message from "./message.txt" with { type: "text" };
      export default function () {
        return new Response(message);
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_text_import",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/text-import"),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("asset-loaded");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool framework routing", () => {
  test("keeps a cached binding facade tenant-scoped without exposing its token", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-pgredis-binding-"));
    const functionPath = join(projectRoot, "cache.ts");
    const service = Bun.serve({
      port: 0,
      async fetch(request) {
        const authorization = request.headers.get("authorization") || "";
        return Response.json({ value: authorization.endsWith("tenant-capability-a") ? "tenant-a" : "tenant-b" });
      },
    });
    await Bun.write(functionPath, `
      const cache = globalThis.SupaCloud.pgredis;
      export default async function () {
        return Response.json({
          value: await cache.get("shared-key"),
          leakedToken: process.env.PGREDIS_RUNTIME_INTERNAL_TOKEN || null,
          leakedUrl: process.env.PGREDIS_RUNTIME_INTERNAL_URL || null,
        });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const endpoint = {
      baseUrl: `http://127.0.0.1:${service.port}`,
      timeoutMs: 1_000,
    };

    try {
      const tenantA = await pool.dispatch({
        functionId: "tenant-a_cache",
        functionPath,
        projectRoot,
        projectRef: "tenant-a",
        moduleVersion: "shared-module",
        env: {},
        internalBindings: { ...endpoint, capabilityToken: "tenant-capability-a" },
        request: new Request("http://edge.local/functions/v1/cache"),
      });
      const tenantB = await pool.dispatch({
        functionId: "tenant-b_cache",
        functionPath,
        projectRoot,
        projectRef: "tenant-b",
        moduleVersion: "shared-module",
        env: {},
        internalBindings: { ...endpoint, capabilityToken: "tenant-capability-b" },
        request: new Request("http://edge.local/functions/v1/cache"),
      });

      expect(await tenantA.json()).toEqual({ value: "tenant-a", leakedToken: null, leakedUrl: null });
      expect(await tenantB.json()).toEqual({ value: "tenant-b", leakedToken: null, leakedUrl: null });
    } finally {
      service.stop(true);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("does not let detached work inherit the next tenant binding", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-pgredis-detached-"));
    const functionPath = join(projectRoot, "cache.ts");
    const detachedPath = join(projectRoot, "detached.txt");
    const service = Bun.serve({
      port: 0,
      async fetch(request) {
        await Bun.sleep(150);
        return Response.json({ value: request.headers.get("authorization") });
      },
    });
    await Bun.write(functionPath, `
      const cache = globalThis.SupaCloud.pgredis;
      export default async function () {
        if (process.env.DETACHED_FILE) {
          const outputFile = process.env.DETACHED_FILE;
          void Bun.sleep(40).then(async () => {
            try {
              const value = await cache.get("late");
              await Bun.write(outputFile, "unexpected:" + value);
            } catch (error) {
              await Bun.write(outputFile, error.message);
            }
          });
          return new Response("scheduled", { status: 202 });
        }
        return Response.json({ value: await cache.get("live") });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const endpoint = {
      baseUrl: `http://127.0.0.1:${service.port}`,
      timeoutMs: 1_000,
    };

    try {
      const first = await pool.dispatch({
        functionId: "tenant-a_cache",
        functionPath,
        projectRoot,
        projectRef: "tenant-a",
        moduleVersion: "shared-module",
        env: { DETACHED_FILE: detachedPath },
        internalBindings: { ...endpoint, capabilityToken: "tenant-capability-a" },
        request: new Request("http://edge.local/functions/v1/cache"),
      });
      expect(first.status).toBe(202);

      const second = await pool.dispatch({
        functionId: "tenant-b_cache",
        functionPath,
        projectRoot,
        projectRef: "tenant-b",
        moduleVersion: "shared-module",
        env: {},
        internalBindings: { ...endpoint, capabilityToken: "tenant-capability-b" },
        request: new Request("http://edge.local/functions/v1/cache"),
      });

      expect(second.status).toBe(200);
      expect(await waitForFile(detachedPath)).toContain("unavailable outside a request");
    } finally {
      service.stop(true);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("routes public Function URLs through Elysia using function-local paths", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-elysia-routing-"));
    const functionPath = join(projectRoot, "elysia.ts");
    const elysiaEntry = Bun.resolveSync("elysia", import.meta.dir);
    await Bun.write(functionPath, `
      import { Elysia } from ${JSON.stringify(elysiaEntry)};

      export default new Elysia()
        .get("/", ({ request }) => {
          const url = new URL(request.url);
          return { pathname: url.pathname, query: url.searchParams.get("source") };
        })
        .get("/users/:id", ({ params, request }) => {
          const url = new URL(request.url);
          return { id: params.id, pathname: url.pathname, active: url.searchParams.get("active") };
        });
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 10_000 });
    pools.push(pool);

    try {
      const root = await pool.dispatch({
        functionId: "proj_elysia_api",
        functionPath,
        projectRoot,
        projectRef: "proj_elysia",
        env: {},
        request: new Request("http://edge.local/functions/v1/api?source=sdk"),
      });
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual({ pathname: "/", query: "sdk" });

      const nested = await pool.dispatch({
        functionId: "proj_elysia_api",
        functionPath,
        projectRoot,
        projectRef: "proj_elysia",
        env: {},
        request: new Request("http://edge.local/functions/v1/api/users/42?active=true"),
      });
      expect(nested.status).toBe(200);
      expect(await nested.json()).toEqual({
        id: "42",
        pathname: "/users/42",
        active: "true",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("preserves the public URL for Supabase-style fetch handlers", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-fetch-routing-"));
    const functionPath = join(projectRoot, "fetch.ts");
    await Bun.write(functionPath, `
      export default {
        fetch(request) {
          const url = new URL(request.url);
          return Response.json({ pathname: url.pathname, query: url.searchParams.get("source") });
        }
      };
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_fetch_api",
        functionPath,
        projectRoot,
        projectRef: "proj_fetch",
        env: {},
        request: new Request("http://edge.local/functions/v1/api/users?source=sdk"),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        pathname: "/functions/v1/api/users",
        query: "sdk",
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool cancellation and replacement", () => {
  test("replaces a timed-out worker and immediately serves the queued request", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-timeout-replace-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith("/slow")) {
            await new Promise(() => {});
          }
          return new Response("fast", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 500 });
    pools.push(pool);

    try {
      const slowResponse = pool.dispatch({
        functionId: "proj_timeout_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "41",
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/slow"),
      });
      await Bun.sleep(50);
      const fastResponse = pool.dispatch({
        functionId: "proj_timeout_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "42",
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/fast"),
      });

      const timedOutResponse = await slowResponse;
      expect(timedOutResponse.status).toBe(504);
      expect(timedOutResponse.headers.get("x-supacloud-function-version")).toBe("41");
      const recoveredResponse = await fastResponse;
      expect(recoveredResponse.headers.get("x-supacloud-function-version")).toBe("42");
      expect(await recoveredResponse.text()).toBe("fast");
      const metrics = pool.snapshotMetrics("timeout");
      expect(metrics["timeout_total_worker_replacements"]).toBe(1);
      expect(metrics["timeout_total_worker_retirements"]).toBe(1);
      expect(metrics["timeout_total_queued_requests"]).toBe(1);
      expect(metrics["timeout_idle_workers"]).toBe(1);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
      expect(pool.snapshotMetrics("timeout")["timeout_retired_workers"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps the dispatched version on a worker crash error", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-worker-crash-version-"));
    const startedPath = join(projectRoot, "started.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default async () => {
        await Bun.write(process.env.STARTED_PATH, "started");
        await new Promise(() => {});
      };
    `);
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const pendingResponse = pool.dispatch({
        functionId: "proj_crash_fn_v45",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "45",
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/fn/crash"),
      });
      await waitForFile(startedPath, 5_000);
      const [worker] = (pool as unknown as {
        activeWorkers: Set<{ emit: (event: "error", error: Error) => boolean }>;
      }).activeWorkers;
      worker.emit("error", new Error("simulated worker crash"));

      const crashedResponse = await pendingResponse;
      expect(crashedResponse.status).toBe(500);
      expect(crashedResponse.headers.get("x-supacloud-function-version")).toBe("45");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("propagates an in-flight AbortSignal and releases the worker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-signal-cancel-"));
    const startedPath = join(projectRoot, "started.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith("/slow")) {
            await Bun.write(process.env.STARTED_PATH, "started");
            await new Promise((_, reject) => {
              request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
            });
          }
          return new Response("fast", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    const controller = new AbortController();
    pools.push(pool);

    try {
      const slowResponse = pool.dispatch({
        functionId: "proj_cancel_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "43",
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/fn/slow", {
          signal: controller.signal,
        }),
      });
      await waitForFile(startedPath);
      const fastResponse = pool.dispatch({
        functionId: "proj_cancel_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/fn/fast"),
      });

      controller.abort();

      const cancelled = await slowResponse;
      expect(cancelled.status).toBe(499);
      expect(cancelled.headers.get("x-supacloud-function-version")).toBe("43");
      expect(await (await fastResponse).text()).toBe("fast");
      expect(pool.snapshotMetrics("cancel")["cancel_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("cancels a request while its module is initializing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-load-cancel-"));
    const loadingPath = join(projectRoot, "loading.txt");
    const handlerPath = join(projectRoot, "handler.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      await Bun.write(process.env.LOADING_PATH, "loading");
      await Bun.sleep(100);
      export default async function fetch() {
        await Bun.write(process.env.HANDLER_PATH, "entered");
        return new Response("late", { status: 200 });
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    const controller = new AbortController();
    let executionStarted = 0;
    pools.push(pool);

    try {
      const responsePromise = pool.dispatch({
        functionId: "proj_load_cancel",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { HANDLER_PATH: handlerPath, LOADING_PATH: loadingPath },
        onExecutionStarted: () => {
          executionStarted += 1;
        },
        request: new Request("http://edge.local/functions/v1/load-cancel", {
          signal: controller.signal,
        }),
      });
      await waitForFile(loadingPath);
      controller.abort();

      expect((await responsePromise).status).toBe(499);
      expect(existsSync(handlerPath)).toBe(false);
      expect(executionStarted).toBe(0);
      expect(pool.snapshotMetrics("cancel")["cancel_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("isolates HTTP aborts when requests share an external cancel key", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-duplicate-cancel-key-"));
    const firstStartedPath = join(projectRoot, "first-started.txt");
    const secondStartedPath = join(projectRoot, "second-started.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          await Bun.write(process.env.STARTED_PATH, "started");
          await new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    `);

    const pool = new WorkerPool({ size: 2, requestTimeout: 5_000 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    pools.push(pool);

    try {
      const firstResponse = pool.dispatch({
        functionId: "proj_duplicate_first",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        cancelKey: "shared-task-id",
        env: { STARTED_PATH: firstStartedPath },
        request: new Request("http://edge.local/functions/v1/fn/first", {
          signal: firstController.signal,
        }),
      });
      const secondResponse = pool.dispatch({
        functionId: "proj_duplicate_second",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        cancelKey: "shared-task-id",
        env: { STARTED_PATH: secondStartedPath },
        request: new Request("http://edge.local/functions/v1/fn/second", {
          signal: secondController.signal,
        }),
      });
      await Promise.all([
        waitForFile(firstStartedPath),
        waitForFile(secondStartedPath),
      ]);

      firstController.abort();

      expect((await firstResponse).status).toBe(499);
      const secondSettled = await Promise.race([
        secondResponse.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(secondSettled).toBe(false);

      expect(pool.cancel("shared-task-id")).toBe(true);
      expect((await secondResponse).status).toBe(499);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("removes an aborted queued request before it occupies a worker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-queued-cancel-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (new URL(request.url).pathname.endsWith("/slow")) await Bun.sleep(100);
          return new Response("done", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    const controller = new AbortController();
    pools.push(pool);

    try {
      const slowResponse = pool.dispatch({
        functionId: "proj_queue_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/slow"),
      });
      const queuedResponse = pool.dispatch({
        functionId: "proj_queue_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/cancel", {
          signal: controller.signal,
        }),
      });

      controller.abort();

      expect((await queuedResponse).status).toBe(499);
      expect((await slowResponse).status).toBe(200);
      expect(pool.snapshotMetrics("queue")["queue_total_queued_requests"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("cancels queued old-env work when a project is invalidated", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-queued-env-invalidate-"));
    const functionPath = join(projectRoot, "fn.ts");
    const activeStartedPath = join(projectRoot, "active-started.txt");
    const queuedStartedPath = join(projectRoot, "queued-started.txt");
    await Bun.write(functionPath, `
      export default async function (request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/active")) {
          await Bun.write(process.env.ACTIVE_STARTED_PATH, "started");
          await Bun.sleep(200);
          return new Response("active-complete");
        }
        await Bun.write(process.env.QUEUED_STARTED_PATH, "started");
        return new Response("queued-executed");
      }
    `);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const activeResponse = pool.dispatch({
        functionId: "proj_env_queue_fn",
        functionPath,
        projectRoot,
        projectRef: "proj_env_queue",
        env: { ACTIVE_STARTED_PATH: activeStartedPath },
        request: new Request("http://edge.local/functions/v1/fn/active"),
      });
      await waitForFile(activeStartedPath);
      const queuedResponse = pool.dispatch({
        functionId: "proj_env_queue_fn",
        functionPath,
        projectRoot,
        projectRef: "proj_env_queue",
        env: { QUEUED_STARTED_PATH: queuedStartedPath },
        request: new Request("http://edge.local/functions/v1/fn/queued"),
      });
      await waitForMetric(pool, "queue_length", 1);

      const invalidation = await pool.invalidateProject("proj_env_queue");
      const cancelled = await queuedResponse;

      expect(invalidation.cancelledQueued).toBe(1);
      expect(cancelled.status).toBe(503);
      expect(await cancelled.json()).toEqual({
        error: "Runtime environment changed before execution",
        code: "RUNTIME_ENV_INVALIDATED",
      });
      expect(pool.snapshotMetrics("env_queue")["env_queue_queue_length"]).toBe(0);
      expect(await activeResponse.then((response) => response.text())).toBe("active-complete");
      expect(existsSync(queuedStartedPath)).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("replaces a cancelled streaming worker before serving the queue", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-stream-cancel-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/stream")) {
            return Response.json({ overlap: false });
          }
          return new Response(new ReadableStream({
            start(controller) {
              const timer = setInterval(() => controller.enqueue(new TextEncoder().encode("tick\\n")), 10);
              request.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
            }
          }), { headers: { "content-type": "text/event-stream" } });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const streamResponse = await pool.dispatch({
        functionId: "proj_stream_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "44",
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/stream"),
      });
      expect(streamResponse.headers.get("x-supacloud-function-version")).toBe("44");
      const reader = streamResponse.body!.getReader();
      expect((await reader.read()).done).toBe(false);

      const queuedResponse = pool.dispatch({
        functionId: "proj_stream_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn/fast"),
      });
      await reader.cancel();

      expect(await (await queuedResponse).json()).toEqual({ overlap: false });
      const metrics = pool.snapshotMetrics("stream");
      expect(metrics["stream_total_worker_replacements"]).toBe(1);
      expect(metrics["stream_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("drain waits for ordinary requests without an external cancel key", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-drain-active-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          await Bun.sleep(120);
          return new Response("done", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const responsePromise = pool.dispatch({
        functionId: "proj_drain_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/fn"),
      });
      await Bun.sleep(20);
      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });

      await Bun.sleep(40);
      expect(drained).toBe(false);
      expect((await responsePromise).status).toBe(200);
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("drain waits for an in-progress bulk preheat", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-drain-preheat-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      await Bun.sleep(120);
      export default () => new Response("ready");
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheatPromise = pool.preheatIdleWorkers(
        "proj_drain_preheat",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_drain" },
      );
      await Bun.sleep(20);
      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });

      await Bun.sleep(40);
      expect(drained).toBe(false);
      expect((await preheatPromise).succeeded).toBe(1);
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("drain waits for EdgeRuntime.waitUntil after the response", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-drain-waituntil-"));
    const completedPath = join(projectRoot, "waituntil-complete.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          EdgeRuntime.waitUntil((async () => {
            await Bun.sleep(120);
            await Bun.write(process.env.COMPLETED_PATH, "done");
          })());
          return new Response("accepted", { status: 202 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_waituntil_drain_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { COMPLETED_PATH: completedPath },
        request: new Request("http://edge.local/functions/v1/fn"),
      });
      expect(response.status).toBe(202);

      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });
      await Bun.sleep(40);
      expect(drained).toBe(false);
      expect(await waitForFile(completedPath)).toBe("done");
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool cooperative retirement", () => {
  test("retires a worker that times out during module initialization", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-retirement-load-"));
    const functionPath = join(projectRoot, "slow-load.ts");
    await Bun.write(functionPath, `
      await Bun.sleep(100);
      export default async function fetch(request) {
        await new Promise((resolve) => {
          const keepAlive = setInterval(() => {}, 10);
          request.signal.addEventListener("abort", () => {
            clearInterval(keepAlive);
            resolve();
          }, { once: true });
        });
        return new Response("retired");
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 25 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_retirement_load",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/slow-load"),
      });
      expect(response.status).toBe(504);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
      expect(pool.snapshotMetrics("retirement")["retirement_retired_workers"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("triggers the count budget once and stops accepting requests", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-retirement-count-"));
    const firstStartedPath = join(projectRoot, "first-started.txt");
    const secondStartedPath = join(projectRoot, "second-started.txt");
    const functionPath = join(projectRoot, "slow.ts");
    await Bun.write(functionPath, `
      export default async function fetch(request) {
        const aborted = new Promise((resolve) => {
          const keepAlive = setInterval(() => {}, 10);
          request.signal.addEventListener("abort", () => {
            setTimeout(() => {
              clearInterval(keepAlive);
              resolve();
            }, 500);
          }, { once: true });
        });
        await Bun.write(process.env.STARTED_PATH, "started");
        await aborted;
        return new Response("retired");
      }
    `);

    const exceeded: string[] = [];
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 100,
      retirementBudget: { maxRetiredWorkers: 1, maxRetirementAgeMs: 1_000 },
      onRetirementBudgetExceeded: (event) => exceeded.push(event.limit),
    });
    pools.push(pool);

    try {
      const preheatReplacement = () => pool.preheat(
        "proj_retirement_count",
        functionPath,
        projectRoot,
        {},
        { projectRef: "test-project" },
      );
      const dispatchSlow = async (startedPath: string) => {
        const responsePromise = pool.dispatch({
          functionId: "proj_retirement_count",
          projectRef: "test-project",
          functionPath,
          projectRoot,
          env: { STARTED_PATH: startedPath },
          request: new Request("http://edge.local/functions/v1/slow"),
        });
        await waitForFile(startedPath);
        return responsePromise;
      };

      expect(await preheatReplacement()).toBe(true);
      expect((await dispatchSlow(firstStartedPath)).status).toBe(504);
      expect(await preheatReplacement()).toBe(true);
      expect((await dispatchSlow(secondStartedPath)).status).toBe(504);
      expect(exceeded).toEqual(["count"]);
      expect(pool.snapshotMetrics("retirement")["retirement_retirement_budget_exceeded"]).toBe(1);
      expect((await pool.dispatch({
        functionId: "proj_retirement_count",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/slow"),
      })).status).toBe(503);
      await waitForMetric(pool, "total_natural_worker_exits", 2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("triggers the age budget once for a worker that cannot drain promptly", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-retirement-age-"));
    const startedPath = join(projectRoot, "started.txt");
    const functionPath = join(projectRoot, "slow.ts");
    await Bun.write(functionPath, `
      export default async function fetch(request) {
        const aborted = new Promise((resolve) => {
          const keepAlive = setInterval(() => {}, 10);
          request.signal.addEventListener("abort", () => {
            setTimeout(() => {
              clearInterval(keepAlive);
              resolve();
            }, 150);
          }, { once: true });
        });
        await Bun.write(process.env.STARTED_PATH, "started");
        await aborted;
        return new Response("retired");
      }
    `);

    const exceeded: string[] = [];
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 100,
      retirementBudget: { maxRetiredWorkers: 8, maxRetirementAgeMs: 30 },
      onRetirementBudgetExceeded: (event) => exceeded.push(event.limit),
    });
    pools.push(pool);

    try {
      expect(await pool.preheat(
        "proj_retirement_age",
        functionPath,
        projectRoot,
        {},
        { projectRef: "test-project" },
      )).toBe(true);
      const responsePromise = pool.dispatch({
        functionId: "proj_retirement_age",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/slow"),
      });
      await waitForFile(startedPath);
      expect((await responsePromise).status).toBe(504);
      await waitForMetric(pool, "retirement_budget_exceeded", 1);
      expect(exceeded).toEqual(["age"]);
      await Bun.sleep(50);
      expect(exceeded).toEqual(["age"]);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("never returns a timed-out preheat worker to the idle pool", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-retirement-"));
    const slowFunctionPath = join(projectRoot, "slow-preheat.ts");
    const fastFunctionPath = join(projectRoot, "fast.ts");
    await Bun.write(slowFunctionPath, `
      await Bun.sleep(150);
      export default () => new Response("late");
    `);
    await Bun.write(fastFunctionPath, `export default () => new Response("replacement");`);

    const pool = new WorkerPool({ size: 1, requestTimeout: 1_000, preheatTimeoutMs: 25 });
    pools.push(pool);

    try {
      expect(await pool.preheat(
        "proj_preheat_slow",
        slowFunctionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1" },
      )).toBe(false);
      const response = await pool.dispatch({
        functionId: "proj_preheat_fast",
        functionPath: fastFunctionPath,
        projectRoot,
        projectRef: "proj_preheat",
        env: {},
        request: new Request("http://edge.local/functions/v1/fast"),
      });
      expect(await response.text()).toBe("replacement");
      expect(pool.snapshotMetrics("preheat")["preheat_total_worker_retirements"]).toBe(1);
      await waitForMetric(pool, "total_natural_worker_exits", 1);
      expect(pool.snapshotMetrics("preheat")["preheat_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool TLS policy handoff", () => {
  test("passes a host CA file policy into smol workers for HTTPS fetch", async () => {
    const openssl = Bun.spawnSync(["openssl", "version"], { stdout: "pipe", stderr: "pipe" });
    if (!openssl.success) {
      return;
    }

    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-tls-policy-"));
    const keyPath = join(projectRoot, "key.pem");
    const certPath = join(projectRoot, "cert.pem");
    const functionPath = join(projectRoot, "fn.ts");
    const previousSkipVerify = process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY;
    const previousCaFile = process.env.SUPACLOUD_EDGE_TLS_CA_FILE;
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      const cert = Bun.spawnSync([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(cert.success).toBe(true);

      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: {
          key: await Bun.file(keyPath).text(),
          cert: await Bun.file(certPath).text(),
        },
        fetch() {
          return new Response("tls-ok");
        },
      });

      await Bun.write(functionPath, `
        export default {
          async fetch() {
            const res = await fetch("https://127.0.0.1:${server.port}/probe");
            return new Response(await res.text(), { status: res.status });
          }
        }
      `);

      delete process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY;
      process.env.SUPACLOUD_EDGE_TLS_CA_FILE = certPath;
      const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
      pools.push(pool);

      const response = await pool.dispatch({
        functionId: "proj_tls",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/tls"),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("tls-ok");
    } finally {
      if (previousSkipVerify === undefined) {
        delete process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY;
      } else {
        process.env.SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY = previousSkipVerify;
      }
      if (previousCaFile === undefined) {
        delete process.env.SUPACLOUD_EDGE_TLS_CA_FILE;
      } else {
        process.env.SUPACLOUD_EDGE_TLS_CA_FILE = previousCaFile;
      }
      server?.stop(true);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool metrics NaN fix", () => {
  test("reports per-pool smol worker mode in metrics", async () => {
    const foreground = new WorkerPool({ size: 1, requestTimeout: 2_000, smol: false });
    const background = new WorkerPool({ size: 1, requestTimeout: 2_000, smol: true });
    pools.push(foreground, background);

    expect(foreground.snapshotMetrics("fg")["fg_worker_smol"]).toBe(0);
    expect(background.snapshotMetrics("bg")["bg_worker_smol"]).toBe(1);
  });

  test("avg_queue_wait_ms is 0 (never NaN) for immediate dispatch", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-nan-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("ok", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const res = await pool.dispatch({
        functionId: "test_nan",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: new Request("http://edge.local/functions/v1/test"),
      });
      expect(res.status).toBe(200);

      const metrics = pool.snapshotMetrics("test");
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isNaN(value)).toBe(false);
      }
      expect(metrics["test_avg_queue_wait_ms"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("queued dispatch produces non-NaN avg_queue_wait_ms", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-nan-q-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          await Bun.sleep(10);
          return new Response("ok", { status: 200 });
        }
      }
    `);

    // Pool size 1, dispatch 2 requests to force one to queue
    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const [res1, res2] = await Promise.all([
        pool.dispatch({
          functionId: "test_nan_q1",
          projectRef: "test-project",
          functionPath,
          projectRoot,
          env: {},
          request: new Request("http://edge.local/functions/v1/test1"),
        }),
        pool.dispatch({
          functionId: "test_nan_q2",
          projectRef: "test-project",
          functionPath,
          projectRoot,
          env: {},
          request: new Request("http://edge.local/functions/v1/test2"),
        }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const metrics = pool.snapshotMetrics("testq");
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isNaN(value)).toBe(false);
      }
      // At least one request was queued, so total_queue_wait_ms > 0
      expect(metrics["testq_total_queue_wait_ms"]).toBeGreaterThan(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool project scheduling", () => {
  test("serves a different queued project before the current-project backlog", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-fair-"));
    const functionPath = join(projectRoot, "fn.ts");
    const orderPath = join(projectRoot, "order.txt");
    await Bun.write(orderPath, "");
    await Bun.write(functionPath, `
      export default {
        async fetch(request) {
          const label = new URL(request.url).pathname.slice(1);
          const previous = await Bun.file(process.env.ORDER_FILE).text();
          await Bun.write(process.env.ORDER_FILE, previous + label + "\\n");
          if (label === "a1") await Bun.sleep(100);
          return new Response(label);
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (projectRef: string, label: string) => pool.dispatch({
      functionId: `${projectRef}_fn`,
      projectRef,
      functionPath,
      projectRoot,
      env: { ORDER_FILE: orderPath },
      request: new Request(`http://edge.local/${label}`),
    });

    try {
      const first = dispatch("project-a", "a1");
      await waitForMetric(pool, "active_workers", 1);
      const queued = [
        dispatch("project-a", "a2"),
        dispatch("project-a", "a3"),
        dispatch("project-b", "b1"),
      ];
      await Promise.all([first, ...queued]);
      const order = (await Bun.file(orderPath).text()).trim().split("\n");
      expect(order).toEqual(["a1", "b1", "a2", "a3"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("gives another project bounded progress while the first project keeps queueing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-fair-bounded-"));
    const functionPath = join(projectRoot, "fn.ts");
    const orderPath = join(projectRoot, "order.txt");
    await Bun.write(orderPath, "");
    await Bun.write(functionPath, `
      export default async function (request) {
        const label = new URL(request.url).pathname.slice(1);
        const previous = await Bun.file(process.env.ORDER_FILE).text();
        await Bun.write(process.env.ORDER_FILE, previous + label + "\\n");
        await Bun.sleep(20);
        return new Response(label);
      }
    `);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (projectRef: string, label: string) => pool.dispatch({
      functionId: `${projectRef}_fn`,
      functionPath,
      projectRoot,
      projectRef,
      env: { ORDER_FILE: orderPath },
      request: new Request(`http://edge.local/${label}`),
    });

    try {
      const first = dispatch("project-a", "a0");
      await waitForMetric(pool, "active_workers", 1);
      const projectB = dispatch("project-b", "b0");
      const projectA = Array.from({ length: 8 }, (_, index) => dispatch("project-a", `a${index + 1}`));
      await Promise.all([first, projectB, ...projectA]);
      const order = (await Bun.file(orderPath).text()).trim().split("\n");
      expect(order.indexOf("b0")).toBeLessThan(3);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool Bun plugin project isolation", () => {
  test.each([
    ["global", "Bun.plugin"],
    ["bare import", "plugin"],
  ])("contains %s plugin registration and clearAll within one project worker", async (_label, pluginCall) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-plugin-project-"));
    const registerPath = join(projectRoot, "register.ts");
    const clearGlobalPath = join(projectRoot, "clear-global.ts");
    const clearImportPath = join(projectRoot, "clear-import.ts");
    const probePath = join(projectRoot, "probe.ts");
    await Bun.write(registerPath, `
      import { plugin } from "bun";
      const register = ${pluginCall};
      register({
        name: "tenant-plugin",
        setup(build) {
          build.module("tenant.virtual", () => ({
            exports: { owner: "project-a" },
            loader: "object",
          }));
        },
      });
      export default async function () {
        const virtual = await import("tenant.virtual");
        return new Response(virtual.owner);
      }
    `);
    await Bun.write(probePath, `
      export default async function () {
        try {
          const virtual = await import("tenant.virtual");
          return new Response(virtual.owner);
        } catch (error) {
          return new Response(error.message, { status: 404 });
        }
      }
    `);
    await Bun.write(clearGlobalPath, `
      export default function () {
        Bun.plugin.clearAll();
        return new Response("cleared-global");
      }
    `);
    await Bun.write(clearImportPath, `
      import { plugin } from "bun";
      export default function () {
        plugin.clearAll();
        return new Response("cleared-import");
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (projectRef: string, functionPath: string, query = "") => pool.dispatch({
      functionId: `${projectRef}_fn`,
      functionPath,
      projectRoot,
      projectRef,
      moduleVersion: functionPath,
      env: {},
      request: new Request(`http://edge.local/functions/v1/fn${query}`),
    });

    try {
      expect(await (await dispatch("project-a", registerPath)).text()).toBe("project-a");

      const otherProject = await dispatch("project-b", probePath);
      expect(otherProject.status).toBe(404);
      expect(await otherProject.text()).toContain("Cannot find package 'tenant.virtual'");

      expect(await (await dispatch("project-b", clearGlobalPath)).text()).toBe("cleared-global");
      expect(await (await dispatch("project-b", clearImportPath)).text()).toBe("cleared-import");
      expect(await (await dispatch("project-a", registerPath)).text()).toBe("project-a");
      expect(pool.snapshotMetrics("plugin")["plugin_total_worker_replacements"]).toBe(2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps guarded Bun file and write APIs available in a project-bound worker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-plugin-file-"));
    const functionPath = join(projectRoot, "files.ts");
    const inputPath = join(projectRoot, "input.txt");
    const outputPath = join(projectRoot, "output.txt");
    await Bun.write(inputPath, "project-data");
    await Bun.write(functionPath, `
      import { file, write } from "bun";
      export default async function () {
        const contents = await file(process.env.INPUT_PATH).text();
        await write(process.env.OUTPUT_PATH, contents + ":written");
        return new Response(contents);
      }
    `);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "project-files_fn",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: { INPUT_PATH: inputPath, OUTPUT_PATH: outputPath },
        request: new Request("http://edge.local/functions/v1/files"),
      });
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 200,
        body: "project-data",
      });
      expect(await Bun.file(outputPath).text()).toBe("project-data:written");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps foreground and background pools independently project-bound", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-plugin-profile-"));
    const functionPath = join(projectRoot, "profile.ts");
    await Bun.write(functionPath, `
      import { plugin } from "bun";
      plugin({
        name: "profile-plugin",
        setup(build) {
          build.module("profile.virtual", () => ({
            exports: { profile: process.env.EXECUTION_PROFILE },
            loader: "object",
          }));
        },
      });
      export default async function () {
        const virtual = await import("profile.virtual");
        return new Response(virtual.profile);
      }
    `);
    const foreground = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    const background = new WorkerPool({ size: 1, requestTimeout: 2_000, smol: true });
    pools.push(foreground, background);
    const dispatch = (pool: WorkerPool, profile: string) => pool.dispatch({
      functionId: "project-profile_fn",
      projectRef: "test-project",
      functionPath,
      projectRoot,
      moduleVersion: "v1",
      env: { EXECUTION_PROFILE: profile },
      request: new Request("http://edge.local/functions/v1/profile"),
    });

    try {
      const [foregroundResponse, backgroundResponse] = await Promise.all([
        dispatch(foreground, "foreground"),
        dispatch(background, "background"),
      ]);
      expect(await foregroundResponse.text()).toBe("foreground");
      expect(await backgroundResponse.text()).toBe("background");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("requests one runtime recycle without dropping queued cross-project work", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-plugin-recycle-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `export default () => new Response(process.env.PROJECT_LABEL);`);
    const recycleEvents: Array<{ workerReplacements: number; maxWorkerReplacements: number }> = [];
    const pool = new WorkerPool({
      size: 1,
      requestTimeout: 2_000,
      maxWorkerReplacementsBeforeRecycle: 2,
      onWorkerRecycleRequired: (event) => recycleEvents.push(event),
    });
    pools.push(pool);
    const dispatch = (projectRef: string) => pool.dispatch({
      functionId: `${projectRef}_fn`,
      functionPath,
      projectRoot,
      projectRef,
      env: { PROJECT_LABEL: projectRef },
      request: new Request("http://edge.local/functions/v1/fn"),
    });

    try {
      const responses = [];
      for (const projectRef of ["project-a", "project-b", "project-a", "project-b"]) {
        responses.push(await (await dispatch(projectRef)).text());
      }
      expect(responses).toEqual(["project-a", "project-b", "project-a", "project-b"]);
      expect(recycleEvents).toEqual([{ workerReplacements: 2, maxWorkerReplacements: 2 }]);
      expect(pool.snapshotMetrics("plugin_recycle")["plugin_recycle_queue_length"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool module cache", () => {
  function moduleLoadCounterSource(counterPath: string): string {
    return `
      const counterPath = ${JSON.stringify(counterPath)};
      let previous = "0";
      try {
        previous = await Bun.file(counterPath).text();
      } catch {}
      const loadCount = Number(previous || "0") + 1;
      await Bun.write(counterPath, String(loadCount));

      export default {
        async fetch() {
          return new Response(String(loadCount), { status: 200 });
        }
      }
    `;
  }

  test("executes Deno.serve on first load and keeps explicit exports authoritative", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-deno-serve-first-"));
    const servePath = join(projectRoot, "serve.ts");
    const exportedPath = join(projectRoot, "exported.ts");
    await Bun.write(servePath, `Deno.serve(() => new Response("serve-first"));`);
    await Bun.write(exportedPath, `
      Deno.serve(() => new Response("captured"));
      export default () => new Response("exported");
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const serveResponse = await pool.dispatch({
        functionId: "proj_serve_first",
        projectRef: "test-project",
        functionPath: servePath,
        projectRoot,
        moduleVersion: "v1",
        env: {},
        request: new Request("http://edge.local/functions/v1/serve-first"),
      });
      expect(serveResponse.status).toBe(200);
      expect(await serveResponse.text()).toBe("serve-first");

      const exportedResponse = await pool.dispatch({
        functionId: "proj_serve_exported",
        projectRef: "test-project",
        functionPath: exportedPath,
        projectRoot,
        moduleVersion: "v1",
        env: {},
        request: new Request("http://edge.local/functions/v1/serve-exported"),
      });
      expect(await exportedResponse.text()).toBe("exported");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("caches a Deno.serve handler loaded during preheat", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-deno-serve-preheat-"));
    const functionPath = join(projectRoot, "serve.ts");
    await Bun.write(functionPath, `Deno.serve(() => new Response("preheated-serve"));`);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      expect(await pool.preheat(
        "proj_serve_preheat",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_serve_preheat", moduleVersion: "v1" },
      )).toBe(true);

      const response = await pool.dispatch({
        functionId: "proj_serve_preheat",
        projectRef: "proj_serve_preheat",
        functionPath,
        projectRoot,
        moduleVersion: "v1",
        env: {},
        request: new Request("http://edge.local/functions/v1/serve-preheat"),
      });
      expect(await response.text()).toBe("preheated-serve");

      const metrics = pool.snapshotMetrics("serve_preheat");
      expect(metrics["serve_preheat_total_module_cache_hits"]).toBe(1);
      expect(metrics["serve_preheat_total_module_cache_misses"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps each cached Deno.serve handler isolated from later imports", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-deno-serve-cache-"));
    const functionAPath = join(projectRoot, "serve-a.ts");
    const functionBPath = join(projectRoot, "serve-b.ts");
    await Bun.write(functionAPath, `Deno.serve(() => new Response("serve-a"));`);
    await Bun.write(functionBPath, `Deno.serve(() => new Response("serve-b"));`);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = (functionId: string, functionPath: string) => pool.dispatch({
      functionId,
      projectRef: "test-project",
      functionPath,
      projectRoot,
      moduleVersion: "v1",
      env: {},
      request: new Request(`http://edge.local/functions/v1/${functionId}`),
    });

    try {
      expect(await (await dispatch("proj_serve_a", functionAPath)).text()).toBe("serve-a");
      expect(await (await dispatch("proj_serve_b", functionBPath)).text()).toBe("serve-b");
      expect(await (await dispatch("proj_serve_a", functionAPath)).text()).toBe("serve-a");

      const metrics = pool.snapshotMetrics("serve_cache");
      expect(metrics["serve_cache_total_module_cache_hits"]).toBe(1);
      expect(metrics["serve_cache_total_module_cache_misses"]).toBe(2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("reuses stable module versions and reloads when moduleVersion changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-module-cache-"));
    const counterPath = join(projectRoot, "counter.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, moduleLoadCounterSource(counterPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const dispatch = (moduleVersion: string) =>
        pool.dispatch({
          functionId: "proj_cache_fn",
          functionPath,
          projectRoot,
          projectRef: "proj_cache",
          moduleVersion,
          env: {},
          request: new Request("http://edge.local/functions/v1/fn"),
        });

      const first = await dispatch("v1");
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("1");

      const second = await dispatch("v1");
      expect(second.status).toBe(200);
      expect(await second.text()).toBe("1");
      expect(await Bun.file(counterPath).text()).toBe("1");

      const third = await dispatch("v2");
      expect(third.status).toBe(200);
      expect(await third.text()).toBe("2");
      expect(await Bun.file(counterPath).text()).toBe("2");

      const metrics = pool.snapshotMetrics("cache");
      expect(metrics["cache_total_module_cache_hits"]).toBe(1);
      expect(metrics["cache_total_module_cache_misses"]).toBe(2);
      expect(metrics["cache_total_worker_replacements"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rotates idle workers before an explicit version preheat", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-version-rotation-idle-"));
    const counterPath = join(projectRoot, "counter.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, moduleLoadCounterSource(counterPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const dispatch = () => pool.dispatch({
      functionId: "proj_rotation_fn_v1",
      functionPath,
      projectRoot,
      projectRef: "proj_rotation",
      moduleVersion: "v1",
      env: {},
      request: new Request("http://edge.local/functions/v1/fn"),
    });

    try {
      expect(await (await dispatch()).text()).toBe("1");
      const preheat = await pool.preheatVersionedIdleWorkers({
        functionId: "proj_rotation_fn_v1",
        functionPath,
        projectRoot,
        projectRef: "proj_rotation",
        moduleVersion: "v1",
        env: {},
      });

      expect(preheat.rotation).toEqual({
        generation: 1,
        attempted: 1,
        idleRetired: 1,
        busyTainted: 0,
        alreadyTainted: 0,
        immediateReplacements: 1,
      });
      expect(preheat.cacheMisses).toBe(1);
      expect(await Bun.file(counterPath).text()).toBe("2");
      expect(await (await dispatch()).text()).toBe("2");
      await waitForMetric(pool, "total_natural_worker_exits", 1);
      const metrics = pool.snapshotMetrics("rotation");
      expect(metrics["rotation_total_worker_replacements"]).toBe(1);
      expect(metrics["rotation_total_generation_rotations"]).toBe(1);
      expect(metrics["rotation_worker_generation"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("lets busy work finish before retiring its old generation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-version-rotation-busy-"));
    const startedPath = join(projectRoot, "started.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default async function fetch() {
        await Bun.write(process.env.STARTED_PATH, "started");
        await Bun.sleep(150);
        return new Response("completed");
      }
    `);

    const pool = new WorkerPool({ size: 2, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const initialPreheat = await pool.preheatIdleWorkers(
        "proj_rotation_busy_v1",
        functionPath,
        projectRoot,
        { STARTED_PATH: startedPath },
        { projectRef: "proj_rotation", moduleVersion: "v1" },
      );
      expect(initialPreheat.succeeded).toBe(2);

      const responsePromise = pool.dispatch({
        functionId: "proj_rotation_busy_v1",
        functionPath,
        projectRoot,
        projectRef: "proj_rotation",
        moduleVersion: "v1",
        env: { STARTED_PATH: startedPath },
        request: new Request("http://edge.local/functions/v1/busy"),
      });
      await waitForFile(startedPath);

      const versionPreheat = await pool.preheatVersionedIdleWorkers({
        functionId: "proj_rotation_busy_v2",
        functionPath,
        projectRoot,
        projectRef: "proj_rotation",
        moduleVersion: "v2",
        env: { STARTED_PATH: startedPath },
      });
      expect(versionPreheat.rotation).toEqual({
        generation: 1,
        attempted: 2,
        idleRetired: 1,
        busyTainted: 1,
        alreadyTainted: 0,
        immediateReplacements: 1,
      });
      expect(versionPreheat.succeeded).toBe(1);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("completed");
      await waitForMetric(pool, "total_natural_worker_exits", 2);
      const metrics = pool.snapshotMetrics("rotation");
      expect(metrics["rotation_total_worker_replacements"]).toBe(2);
      expect(metrics["rotation_total_generation_busy_taints"]).toBe(1);
      expect(metrics["rotation_tainted_workers"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("serializes ordinary bulk preheat before explicit version rotation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-version-rotation-queued-"));
    const slowFunctionPath = join(projectRoot, "slow.ts");
    const versionedFunctionPath = join(projectRoot, "versioned.ts");
    await Bun.write(slowFunctionPath, `
      await Bun.sleep(150);
      export default () => new Response("ordinary");
    `);
    await Bun.write(versionedFunctionPath, `export default () => new Response("versioned");`);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const ordinaryPreheat = pool.preheatIdleWorkers(
        "proj_rotation_ordinary",
        slowFunctionPath,
        projectRoot,
        {},
        { projectRef: "proj_rotation", moduleVersion: "ordinary" },
      );
      const versionedPreheat = pool.preheatVersionedIdleWorkers({
        functionId: "proj_rotation_versioned_v1",
        functionPath: versionedFunctionPath,
        projectRoot,
        projectRef: "proj_rotation",
        moduleVersion: "v1",
        env: {},
      });

      const [ordinary, versioned] = await Promise.all([ordinaryPreheat, versionedPreheat]);
      expect(ordinary.succeeded).toBe(1);
      expect(versioned.succeeded).toBe(1);
      expect(versioned.rotation).toEqual({
        generation: 1,
        attempted: 1,
        idleRetired: 1,
        busyTainted: 0,
        alreadyTainted: 0,
        immediateReplacements: 1,
      });
      await waitForMetric(pool, "total_natural_worker_exits", 1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("serializes concurrent explicit version preheats by generation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-version-rotation-ordered-"));
    const counterPath = join(projectRoot, "counter.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, moduleLoadCounterSource(counterPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const preheatVersion = (version: string) => pool.preheatVersionedIdleWorkers({
      functionId: `proj_rotation_ordered_v${version}`,
      functionPath,
      projectRoot,
      projectRef: "proj_rotation",
      moduleVersion: version,
      env: {},
    });

    try {
      const preheats = await Promise.all([
        preheatVersion("1"),
        preheatVersion("2"),
        preheatVersion("3"),
      ]);
      expect(preheats.map((preheat) => preheat.rotation.generation)).toEqual([1, 2, 3]);
      expect(preheats.map((preheat) => preheat.succeeded)).toEqual([1, 1, 1]);
      expect(await Bun.file(counterPath).text()).toBe("3");
      await waitForMetric(pool, "total_natural_worker_exits", 3);
      const metrics = pool.snapshotMetrics("ordered");
      expect(metrics["ordered_total_worker_replacements"]).toBe(3);
      expect(metrics["ordered_retired_workers"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("reloads rollback versions and drains repeated generation rotations", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-version-rotation-rollback-"));
    const counterPath = join(projectRoot, "counter.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, moduleLoadCounterSource(counterPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);
    const preheatVersion = (version: string) => pool.preheatVersionedIdleWorkers({
      functionId: `proj_rotation_rollback_v${version}`,
      functionPath,
      projectRoot,
      projectRef: "proj_rotation",
      moduleVersion: version,
      env: {},
    });

    try {
      for (const version of ["1", "2", "1", "3", "4", "5"]) {
        const preheat = await preheatVersion(version);
        expect(preheat.succeeded).toBe(1);
        expect(preheat.cacheMisses).toBe(1);
      }
      expect(await Bun.file(counterPath).text()).toBe("6");
      await waitForMetric(pool, "total_natural_worker_exits", 6);
      const metrics = pool.snapshotMetrics("rollback");
      expect(metrics["rollback_worker_generation"]).toBe(6);
      expect(metrics["rollback_total_worker_replacements"]).toBe(6);
      expect(metrics["rollback_retired_workers"]).toBe(0);
      expect(metrics["rollback_tainted_workers"]).toBe(0);
      expect(metrics["rollback_idle_workers"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("requests one process recycle after the worker replacement budget", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-worker-recycle-budget-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `export default () => new Response("ready");`);

    const recycleEvents: Array<{ workerReplacements: number; maxWorkerReplacements: number }> = [];
    const succeededAtRecycle: number[] = [];
    let pool: WorkerPool;
    pool = new WorkerPool({
      size: 1,
      requestTimeout: 2_000,
      maxWorkerReplacementsBeforeRecycle: 2,
      onWorkerRecycleRequired: (event) => {
        recycleEvents.push(event);
        const metrics = pool.snapshotMetrics("during_recycle");
        succeededAtRecycle.push(metrics["during_recycle_total_preheat_succeeded"]);
      },
    });
    pools.push(pool);

    try {
      for (const version of ["1", "2", "3"]) {
        const preheat = await pool.preheatVersionedIdleWorkers({
          functionId: `proj_recycle_v${version}`,
          functionPath,
          projectRoot,
          projectRef: "proj_recycle",
          moduleVersion: version,
          env: {},
        });
        expect(preheat.succeeded).toBe(1);
      }

      expect(recycleEvents).toEqual([{ workerReplacements: 2, maxWorkerReplacements: 2 }]);
      expect(succeededAtRecycle).toEqual([2]);
      await waitForMetric(pool, "total_natural_worker_exits", 3);
      const metrics = pool.snapshotMetrics("recycle");
      expect(metrics["recycle_total_worker_replacements"]).toBe(3);
      expect(metrics["recycle_max_worker_replacements_before_recycle"]).toBe(2);
      expect(metrics["recycle_worker_recycle_required"]).toBe(1);
      expect(metrics["recycle_retired_workers"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("shared recycle coordination waits for slow and fast pool preheats", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-recycle-two-pools-"));
    const slowFunctionPath = join(projectRoot, "slow.ts");
    const fastFunctionPath = join(projectRoot, "fast.ts");
    await Bun.write(slowFunctionPath, `
      await Bun.sleep(150);
      export default () => new Response("slow");
    `);
    await Bun.write(fastFunctionPath, `export default () => new Response("fast");`);

    let foreground: WorkerPool;
    let background: WorkerPool;
    let coordinatorStarts = 0;
    let coordinatedDrain: Promise<void> | undefined;
    const requestRecycle = () => {
      if (coordinatedDrain) return;
      coordinatorStarts++;
      coordinatedDrain = Promise.all([foreground.drain(), background.drain()]).then(() => undefined);
    };
    foreground = new WorkerPool({
      size: 1,
      requestTimeout: 2_000,
      maxWorkerReplacementsBeforeRecycle: 1,
      onWorkerRecycleRequired: requestRecycle,
    });
    background = new WorkerPool({
      size: 1,
      requestTimeout: 2_000,
      maxWorkerReplacementsBeforeRecycle: 1,
      onWorkerRecycleRequired: requestRecycle,
    });
    pools.push(foreground, background);

    try {
      const preheat = (pool: WorkerPool, functionId: string, functionPath: string) =>
        pool.preheatVersionedIdleWorkers({
          functionId,
          functionPath,
          projectRoot,
          projectRef: "proj_recycle_two_pools",
          moduleVersion: "1",
          env: {},
        });
      const [foregroundResult, backgroundResult] = await Promise.all([
        preheat(foreground, "proj_recycle_foreground_v1", slowFunctionPath),
        preheat(background, "proj_recycle_background_v1", fastFunctionPath),
      ]);
      await coordinatedDrain;

      expect(foregroundResult.succeeded).toBe(1);
      expect(backgroundResult.succeeded).toBe(1);
      expect(coordinatorStarts).toBe(1);
      const foregroundMetrics = foreground.snapshotMetrics("foreground");
      const backgroundMetrics = background.snapshotMetrics("background");
      expect(foregroundMetrics["foreground_total_preheat_succeeded"]).toBe(1);
      expect(backgroundMetrics["background_total_preheat_succeeded"]).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("invalidates only the target function cache entry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-module-invalidate-"));
    const functionAPath = join(projectRoot, "a.ts");
    const functionBPath = join(projectRoot, "b.ts");
    const counterAPath = join(projectRoot, "counter-a.txt");
    const counterBPath = join(projectRoot, "counter-b.txt");
    await Bun.write(functionAPath, moduleLoadCounterSource(counterAPath));
    await Bun.write(functionBPath, moduleLoadCounterSource(counterBPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (functionId: string, functionPath: string, moduleVersion: string) =>
      pool.dispatch({
        functionId,
        functionPath,
        projectRoot,
        projectRef: "proj_precise",
        moduleVersion,
        env: {},
        request: new Request(`http://edge.local/functions/v1/${functionId}`),
      });

    try {
      expect(await (await dispatch("proj_precise_a", functionAPath, "v1")).text()).toBe("1");
      expect(await (await dispatch("proj_precise_b", functionBPath, "v1")).text()).toBe("1");

      const result = await pool.invalidateModule("proj_precise_a");
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.invalidated).toBe(1);

      expect(await (await dispatch("proj_precise_b", functionBPath, "v1")).text()).toBe("1");
      expect(await Bun.file(counterBPath).text()).toBe("1");

      expect(await (await dispatch("proj_precise_a", functionAPath, "v2")).text()).toBe("2");
      expect(await Bun.file(counterAPath).text()).toBe("2");

      const metrics = pool.snapshotMetrics("precise");
      expect(metrics["precise_total_module_cache_invalidated"]).toBe(1);
      expect(metrics["precise_total_worker_replacements"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("project invalidation does not retire another project's worker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-project-invalidate-"));
    const functionAPath = join(projectRoot, "project-a.ts");
    const functionBPath = join(projectRoot, "project-b.ts");
    const counterAPath = join(projectRoot, "counter-project-a.txt");
    const counterBPath = join(projectRoot, "counter-project-b.txt");
    await Bun.write(functionAPath, moduleLoadCounterSource(counterAPath));
    await Bun.write(functionBPath, moduleLoadCounterSource(counterBPath));

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (
      functionId: string,
      functionPath: string,
      projectRef: string,
      moduleVersion: string,
    ) =>
      pool.dispatch({
        functionId,
        functionPath,
        projectRoot,
        projectRef,
        moduleVersion,
        env: {},
        request: new Request(`http://edge.local/functions/v1/${functionId}`),
      });

    try {
      expect(await (await dispatch("proj_env_a_fn", functionAPath, "proj_env_a", "v1")).text()).toBe("1");
      expect(await (await dispatch("proj_env_b_fn", functionBPath, "proj_env_b", "v1")).text()).toBe("1");

      const result = await pool.invalidateProject("proj_env_a");
      expect(result.attempted).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.invalidated).toBe(0);

      expect(await (await dispatch("proj_env_b_fn", functionBPath, "proj_env_b", "v1")).text()).toBe("1");
      expect(await Bun.file(counterBPath).text()).toBe("1");

      expect(await (await dispatch("proj_env_a_fn", functionAPath, "proj_env_a", "v2")).text()).toBe("2");
      expect(await Bun.file(counterAPath).text()).toBe("2");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("project env epoch can force reload even when function file metadata is unchanged", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-env-epoch-"));
    const functionPath = join(projectRoot, "env.ts");
    await Bun.write(functionPath, `
      const loadedSecret = process.env.RUNTIME_SECRET || "missing";
      export default {
        async fetch() {
          return new Response(loadedSecret, { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (moduleVersion: string, secret: string) =>
      pool.dispatch({
        functionId: "proj_env_epoch_fn",
        functionPath,
        projectRoot,
        projectRef: "proj_env_epoch",
        moduleVersion,
        env: { RUNTIME_SECRET: secret },
        request: new Request("http://edge.local/functions/v1/env"),
      });

    try {
      expect(await (await dispatch("env:0:stat:same", "old")).text()).toBe("old");
      expect(await (await dispatch("env:0:stat:same", "new-but-same-version")).text()).toBe("old");

      const result = await pool.invalidateProject("proj_env_epoch");
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.invalidated).toBe(1);

      expect(await (await dispatch("env:1:stat:same", "new")).text()).toBe("new");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("binds native module imports to the attested env proof across A to B to A", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-env-proof-import-"));
    const functionPath = join(projectRoot, "env-proof.ts");
    await Bun.write(functionPath, `
      const loadedSecret = process.env.RUNTIME_SECRET || "missing";
      export default () => new Response(loadedSecret);
    `);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    const dispatch = (secret: string, envProof: string) => pool.dispatch({
      functionId: "proj_env_proof_fn",
      functionPath,
      projectRoot,
      projectRef: "proj_env_proof",
      moduleVersion: "same-module-version",
      envProof,
      env: { RUNTIME_SECRET: secret },
      request: new Request("http://edge.local/functions/v1/env-proof"),
    });

    try {
      const proofA = `hmac-sha256:${"a".repeat(64)}`;
      const proofB = `hmac-sha256:${"b".repeat(64)}`;
      expect(await (await dispatch("A", proofA)).text()).toBe("A");
      expect(await (await dispatch("B", proofB)).text()).toBe("B");
      expect(await (await dispatch("A-not-reimported", proofA)).text()).toBe("A");

      const metrics = pool.snapshotMetrics("env_proof");
      expect(metrics["env_proof_total_module_cache_hits"]).toBe(1);
      expect(metrics["env_proof_total_module_cache_misses"]).toBe(2);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("schedules a queued request when a single worker finishes preheating", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-queue-"));
    const slowFunctionPath = join(projectRoot, "slow-preheat.ts");
    const fastFunctionPath = join(projectRoot, "fast.ts");
    await Bun.write(slowFunctionPath, `
      await Bun.sleep(150);
      export default () => new Response("preheated");
    `);
    await Bun.write(fastFunctionPath, `export default () => new Response("queued");`);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheatPromise = pool.preheat(
        "proj_preheat_slow",
        slowFunctionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1" },
      );
      const responsePromise = pool.dispatch({
        functionId: "proj_preheat_fast",
        functionPath: fastFunctionPath,
        projectRoot,
        projectRef: "proj_preheat",
        env: {},
        request: new Request("http://edge.local/functions/v1/fast"),
      });

      await waitForMetric(pool, "queue_length", 1);
      expect(await preheatPromise).toBe(true);
      const response = await waitForResponse(responsePromise, 500);
      expect(response).not.toBeNull();
      expect(await response!.text()).toBe("queued");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("schedules queued requests when multiple workers finish preheating", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-queue-all-"));
    const slowFunctionPath = join(projectRoot, "slow-preheat.ts");
    const fastFunctionPath = join(projectRoot, "fast.ts");
    await Bun.write(slowFunctionPath, `
      await Bun.sleep(150);
      export default () => new Response("preheated");
    `);
    await Bun.write(fastFunctionPath, `export default () => new Response("queued");`);

    const pool = new WorkerPool({ size: 2, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const preheatPromise = pool.preheatIdleWorkers(
        "proj_preheat_slow",
        slowFunctionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1" },
      );
      const responsePromise = pool.dispatch({
        functionId: "proj_preheat_fast",
        functionPath: fastFunctionPath,
        projectRoot,
        projectRef: "proj_preheat",
        env: {},
        request: new Request("http://edge.local/functions/v1/fast"),
      });

      await waitForMetric(pool, "queue_length", 1);
      const result = await preheatPromise;
      expect(result.succeeded).toBe(2);
      const response = await waitForResponse(responsePromise, 500);
      expect(response).not.toBeNull();
      expect(await response!.text()).toBe("queued");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("preheats all idle workers by default and can limit attempted workers", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-"));
    const functionPath = join(projectRoot, "preheat.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("preheated", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 2, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const first = await pool.preheatIdleWorkers(
        "proj_preheat_fn",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1" },
      );
      expect(first.attempted).toBe(2);
      expect(first.succeeded).toBe(2);
      expect(first.cacheHits).toBe(0);
      expect(first.cacheMisses).toBe(2);
      expect(first.durationMs).toBeGreaterThanOrEqual(0);

      const second = await pool.preheatIdleWorkers(
        "proj_preheat_fn",
        functionPath,
        projectRoot,
        {},
        { projectRef: "proj_preheat", moduleVersion: "v1", maxWorkers: 1 },
      );
      expect(second.attempted).toBe(1);
      expect(second.succeeded).toBe(1);
      expect(second.cacheHits).toBe(1);
      expect(second.cacheMisses).toBe(0);

      const metrics = pool.snapshotMetrics("preheat");
      expect(metrics["preheat_total_preheat_attempts"]).toBe(3);
      expect(metrics["preheat_total_preheat_succeeded"]).toBe(3);
      expect(metrics["preheat_total_preheat_ms"]).toBeGreaterThanOrEqual(0);
      expect(metrics["preheat_total_generation_rotations"]).toBe(0);
      expect(metrics["preheat_total_worker_replacements"]).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("replaces idle workers bound to another project before bulk preheat", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-preheat-project-replace-"));
    const functionPath = join(projectRoot, "preheat.ts");
    await Bun.write(functionPath, `export default () => new Response(process.env.PROJECT_LABEL);`);
    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const initial = await pool.dispatch({
        functionId: "project-a_fn",
        functionPath,
        projectRoot,
        projectRef: "project-a",
        env: { PROJECT_LABEL: "project-a" },
        request: new Request("http://edge.local/functions/v1/fn"),
      });
      expect(await initial.text()).toBe("project-a");

      const preheat = await pool.preheatIdleWorkers(
        "project-b_fn",
        functionPath,
        projectRoot,
        { PROJECT_LABEL: "project-b" },
        { projectRef: "project-b", moduleVersion: "v1" },
      );
      expect(preheat).toMatchObject({ attempted: 1, succeeded: 1, cacheMisses: 1 });
      expect(pool.snapshotMetrics("replace")["replace_total_worker_replacements"]).toBe(1);

      const response = await pool.dispatch({
        functionId: "project-b_fn",
        functionPath,
        projectRoot,
        projectRef: "project-b",
        moduleVersion: "v1",
        env: { PROJECT_LABEL: "project-b" },
        request: new Request("http://edge.local/functions/v1/fn"),
      });
      expect(await response.text()).toBe("project-b");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkerPool body size limit", () => {
  test("rejects request with content-length exceeding default limit (30MB)", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-limit-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should not reach", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const oversizedLength = 31 * 1024 * 1024;
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        headers: { "content-length": String(oversizedLength) },
        body: "x".repeat(100),
      });

      const res = await pool.dispatch({
        functionId: "test_body_limit",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        functionVersion: "46",
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      expect(res.headers.has("x-supacloud-function-version")).toBe(false);
      const body = await res.json();
      expect(body.error).toContain("Request body too large");
      expect(body.error).toContain("30MB");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects request when actual body exceeds default limit", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-actual-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should not reach", { status: 200 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 5_000 });
    pools.push(pool);

    try {
      const oversizedBody = "x".repeat(31 * 1024 * 1024);
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        body: oversizedBody,
      });

      const res = await pool.dispatch({
        functionId: "test_body_actual",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("Request body too large");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("respects EDGE_MAX_BODY_SIZE_MB environment variable", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-env-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("ok", { status: 200 });
        }
      }
    `);

    const previousLimit = process.env.EDGE_MAX_BODY_SIZE_MB;
    process.env.EDGE_MAX_BODY_SIZE_MB = "1";

    const { WorkerPool: FreshPool } = await import("./worker-pool?" + Date.now());
    const pool = new FreshPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        headers: { "content-length": String(2 * 1024 * 1024) },
        body: "x".repeat(100),
      });

      const res = await pool.dispatch({
        functionId: "test_body_env",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("1MB");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.EDGE_MAX_BODY_SIZE_MB;
      } else {
        process.env.EDGE_MAX_BODY_SIZE_MB = previousLimit;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("falls back to default limit for invalid EDGE_MAX_BODY_SIZE_MB", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-body-invalid-env-"));
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          return new Response("should not reach", { status: 200 });
        }
      }
    `);

    const previousLimit = process.env.EDGE_MAX_BODY_SIZE_MB;
    process.env.EDGE_MAX_BODY_SIZE_MB = "Infinity";

    const { WorkerPool: FreshPool } = await import("./worker-pool?" + Date.now());
    const pool = new FreshPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const req = new Request("http://edge.local/functions/v1/test", {
        method: "POST",
        headers: { "content-length": String(31 * 1024 * 1024) },
        body: "x".repeat(100),
      });

      const res = await pool.dispatch({
        functionId: "test_body_invalid_env",
        projectRef: "test-project",
        functionPath,
        projectRoot,
        env: {},
        request: req,
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("30MB");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.EDGE_MAX_BODY_SIZE_MB;
      } else {
        process.env.EDGE_MAX_BODY_SIZE_MB = previousLimit;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
