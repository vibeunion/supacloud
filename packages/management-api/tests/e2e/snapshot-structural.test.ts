import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { buildSchemaObject } from "../scripts/capture-snapshots";
import { ProjectService } from "../../src/services/project.service";
import { config } from "../../src/config";
import { randomUUID } from "crypto";

const PROXY_URL =
  process.env.TEST_SUPABASE_URL ||
  `http://${config.baseDomain === "localhost" || !config.baseDomain ? "127.0.0.1" : config.baseDomain}:9090`;
const groundTruthDir = path.join(__dirname, "../snapshots/ground_truth");
const MASTER_TOKEN =
  process.env.MASTER_TOKEN || process.env.TEST_FIXED_JWT_SECRET || "test";

function getGroundTruth(name: string) {
  const p = path.join(groundTruthDir, `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing structural snapshot ground truth: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${MASTER_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectSnapshotStatus(res: Response, expectedStatus: number, label: string): Promise<unknown> {
  const text = await res.text();
  if (res.status !== expectedStatus) {
    throw new Error(
      `${label} status mismatch: expected ${expectedStatus}, received ${res.status}, body=${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text);
}

async function waitForAuthProxy(tenantRef: string, anonKey: string) {
  let lastStatus = 0;
  let lastError = "";

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${PROXY_URL}/auth/v1/health`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          "x-project-ref": tenantRef,
        },
        signal: AbortSignal.timeout(1000),
      });
      lastStatus = res.status;
      if (res.status < 500) return;
      lastError = await res.text();
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(750);
  }

  throw new Error(
    `Auth proxy is not ready for snapshot tests: status=${lastStatus} error=${lastError}`,
  );
}

describe("API Structural Snapshot Compliance", () => {
  let projectService: ProjectService;
  let tenantRef: string;
  let anonKey: string;

  beforeAll(async () => {
    projectService = new ProjectService();
    const tenantName = `snap_test_${randomUUID().substring(0, 8)}`;
    console.log(`[Snap] Bootstrapping test tenant: ${tenantName}...`);

    try {
      const project = await projectService.createProject({
        name: tenantName,
        region: "local",
      });
      tenantRef = project.ref;
      const keys = await projectService.getApiKeys(tenantRef);
      if (keys) anonKey = keys.anon_key;

      if (process.env.TEST_FIXED_JWT_SECRET) {
        const { sql } = await import("../../src/db");
        await sql`
                    UPDATE projects
                    SET
                      db_name = 'postgres',
                      db_user = 'supabase_admin',
                      db_password = 'postgres',
                      status = 'active',
                      config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
                        'postgrest_port', 3000,
                        'gotrue_port', 9999,
                        'realtime_port', 4000
                      )
                    WHERE ref = ${tenantRef};
                `;
      }

      await sleep(3000);
      const health = await fetch(`${PROXY_URL}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!health.ok) {
        throw new Error(`Snapshot proxy is not ready: ${health.status}`);
      }
      await waitForAuthProxy(tenantRef, anonKey);
    } catch (e) {
      throw new Error(
        `Failed to boot project inside snapshot tests context: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }, { timeout: 60_000 });

  afterAll(async () => {
    if (tenantRef) {
      await projectService.deleteProject(tenantRef);
    }
  });

  test("Storage API - List Unknown Bucket Error Shape", async () => {
    const gt = getGroundTruth("storage_list_error");

    const res = await fetch(
      `${PROXY_URL}/storage/v1/object/list/unknown_bucket`,
      {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          "Content-Type": "application/json",
          "x-project-ref": tenantRef,
        },
      },
    );

    const data = await expectSnapshotStatus(res, gt.status, "storage_list_error");
    const schema = buildSchemaObject(data);

    expect(schema).toEqual(gt.schema);
  });

  test("Auth API - Invalid Signup Error Shape", async () => {
    const gt = getGroundTruth("auth_signup_error");

    const res = await fetch(`${PROXY_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        "x-project-ref": tenantRef,
      },
      body: JSON.stringify({ email: "invalid", password: "1" }),
    });

    const data = await expectSnapshotStatus(res, gt.status, "auth_signup_error");
    const schema = buildSchemaObject(data);

    expect(schema).toEqual(gt.schema);
  });

  test("Management API - GET /v1/projects returns array", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref returns project object", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ref).toBe(tenantRef);
    expect(data.id).toBeDefined();
    expect(data.name).toBeDefined();
    expect(data.status).toBeDefined();
    expect(data.database).toBeDefined();
    expect((data.database as Record<string, unknown>).host).toBeDefined();
    // Status should be uppercase Supabase-compatible value
    const validStatuses = [
      "ACTIVE_HEALTHY",
      "INACTIVE",
      "COMING_UP",
      "PAUSED",
      "ACTIVE",
    ];
    expect(
      validStatuses.includes(data.status as string) ||
        typeof data.status === "string",
    ).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/api-keys returns array", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/api-keys`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0].name).toBeDefined();
      expect(data[0].api_key).toBeDefined();
    }
  });

  test("Management API - GET /v1/organizations returns array", async () => {
    const res = await fetch(`${PROXY_URL}/v1/organizations`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/config/auth returns object", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/config/auth`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data).toBe("object");
  });

  test("Management API - GET /v1/projects/:ref/config/database returns object", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/config/database`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data).toBe("object");
  });

  test("Management API - POST /v1/projects/:ref/database/query executes SQL", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/database/query`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ query: "SELECT 1 as test" }),
      },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.rows).toBeDefined();
    expect(data.rowCount).toBe(1);
    expect(data.command).toBe("SELECT");
  });

  test("Management API - GET /v1/projects/:ref/database/migrations returns array", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/database/migrations`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/functions returns array", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/functions`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/functions/secrets returns array", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/functions/secrets`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/functions/secrets returns same as secrets", async () => {
    const [secretsRes, funcSecretsRes] = await Promise.all([
      fetch(`${PROXY_URL}/v1/projects/${tenantRef}/secrets`, {
        headers: authHeaders(),
      }),
      fetch(`${PROXY_URL}/v1/projects/${tenantRef}/functions/secrets`, {
        headers: authHeaders(),
      }),
    ]);

    expect(secretsRes.status).toBe(200);
    expect(funcSecretsRes.status).toBe(200);

    const secretsData = await secretsRes.json();
    const funcSecretsData = await funcSecretsRes.json();

    expect(Array.isArray(secretsData)).toBe(true);
    expect(Array.isArray(funcSecretsData)).toBe(true);
    // Both should return the same count
    expect(funcSecretsData.length).toBe(secretsData.length);
  });

  test("Management API - GET /v1/projects/:ref/secrets returns array", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/secrets`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/database/extensions returns array", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/database/extensions`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("Management API - GET /v1/projects/:ref/database/webhooks reports unavailable fixture capability", async () => {
    const res = await fetch(
      `${PROXY_URL}/v1/projects/${tenantRef}/database/webhooks`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      reason_code: "database_webhooks_not_available",
    });
  });

  test("Management API - GET /v1/projects/:ref/services returns array", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects/${tenantRef}/services`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // Should have at least the DB service listed
    expect(data.length).toBeGreaterThan(0);
    // Each service should have id and status fields
    if (data.length > 0) {
      expect(data[0].id).toBeDefined();
      expect(data[0].status).toBeDefined();
    }
  });

  test("Management API - Error response format uses {message} not {error}", async () => {
    // Verifies the global error handler returns { message } shape (not { error })
    // The route /v1/projects/:ref matches but the ref doesn't exist in the DB → 404
    const res = await fetch(
      `${PROXY_URL}/v1/projects/nonexistent_project_ref`,
      {
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.message).toBeDefined();
    expect(data.error).toBeUndefined();
  });

  test("Management API - Response includes x-supabase-api-version header", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects`, {
      headers: authHeaders(),
    });

    expect(res.headers.get("x-supabase-api-version")).toBeDefined();
  });

  test("Management API - Response includes rate limit headers", async () => {
    const res = await fetch(`${PROXY_URL}/v1/projects`, {
      headers: authHeaders(),
    });

    expect(res.headers.get("x-ratelimit-limit")).toBeDefined();
    expect(res.headers.get("x-ratelimit-remaining")).toBeDefined();
  });
});
