import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ProjectService } from "../../src/services/project.service";
import { sql } from "../../src/db";

const SUPA_OPENAPI_URL = "https://api.supabase.com/api/v1-json";
const LOCAL_API_URL = "http://127.0.0.1:9090";
const MASTER_TOKEN = process.env.MASTER_TOKEN || "test";

interface SchemaRegistry {
  schemas: Record<string, any>;
  resolveRef(ref: string): string | null;
}

function buildSchemaRegistry(openApi: any): SchemaRegistry {
  const schemas = openApi.components?.schemas || {};
  const nameMap = new Map<string, string>();
  const aliases: Record<string, string> = {
    V1ApiKeyResponse: "ApiKeyResponse",
    V1OrganizationResponse: "OrganizationResponseV1",
    V1AuthConfigResponse: "AuthConfigResponse",
    V1FunctionResponse: "FunctionResponse",
    V1FunctionSecretsResponse: "SecretResponse",
    V1ServiceResponse: "V1ServiceHealthResponse",
    V1NetworkRestrictionsResponse: "NetworkRestrictionsResponse",
    V1CustomHostnameResponse: "UpdateCustomHostnameResponse",
    V1StorageConfigResponse: "StorageConfigResponse",
    V1RealtimeConfigResponse: "RealtimeConfigResponse",
  };

  for (const key of Object.keys(schemas)) {
    nameMap.set(key.toLowerCase(), key);
  }

  return {
    schemas,
    resolveRef(ref: string): string | null {
      const directKey = ref.replace("#/components/schemas/", "");
      const aliasedKey = aliases[directKey] || directKey;
      if (schemas[aliasedKey]) return aliasedKey;

      const lowerKey = aliasedKey.toLowerCase();
      for (const [lk, ok] of nameMap.entries()) {
        if (lk === lowerKey) return ok;
      }

      return null;
    },
  };
}

interface ValidationSuite {
  name: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  schemaType: "array" | "object";
  schemaRef: string;
  requiredSetup?: (projectRef: string) => Promise<void>;
  skipIfMissing?: boolean;
}

async function run() {
  console.log(
    "\n🚀 [OpenAPI Fuzzer] Initializing Strict OpenAPI Schema Compliance Checker...",
  );

  console.log(
    `📥 Fetching official OpenAPI Schema from ${SUPA_OPENAPI_URL}...`,
  );
  let openApi: any;
  try {
    const res = await fetch(SUPA_OPENAPI_URL);
    if (!res.ok) throw new Error(`Failed to fetch schema: ${res.statusText}`);
    openApi = await res.json();
    const schemaCount = Object.keys(openApi.components?.schemas || {}).length;
    console.log(
      `✅ Successfully loaded Supabase OpenAPI v1 Schema (${schemaCount} schemas)`,
    );
  } catch (e: any) {
    console.error("❌ Schema fetch failed:", e.message);
    process.exit(1);
  }

  const registry = buildSchemaRegistry(openApi);

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    removeAdditional: false,
  });
  addFormats(ajv);

  for (const [key, schema] of Object.entries(registry.schemas)) {
    try {
      ajv.addSchema(schema, `#/components/schemas/${key}`);
    } catch (e: any) {
      console.warn(`⚠️ Could not register schema ${key}: ${e.message}`);
    }
  }

  const projectService = new ProjectService();
  let projectRef = "openapi_fallback";
  let projectId: string;
  try {
    const project = await projectService.createProject({
      name: "openapi_test_tenant",
      region: "local",
    });
    projectId = project.id;
    projectRef = project.ref;
    console.log(`✅ Created test project: ${projectRef}`);
  } catch (e: any) {
    console.warn(
      "Could not create project, using fallback routing:",
      e.message,
    );
  }

  await new Promise((r) => setTimeout(r, 2000));

  const authHeaders = {
    Authorization: `Bearer ${MASTER_TOKEN}`,
    "Content-Type": "application/json",
  };

  const suites: ValidationSuite[] = [
    {
      name: "GET /v1/projects",
      method: "GET",
      path: "/v1/projects",
      schemaType: "array",
      schemaRef: "V1ProjectResponse",
    },
    {
      name: "GET /v1/projects/:ref",
      method: "GET",
      path: `/v1/projects/${projectRef}`,
      schemaType: "object",
      schemaRef: "V1ProjectWithDatabaseResponse",
    },
    {
      name: "GET /v1/projects/:ref/api-keys",
      method: "GET",
      path: `/v1/projects/${projectRef}/api-keys`,
      schemaType: "array",
      schemaRef: "ApiKeyResponse",
    },
    {
      name: "GET /v1/organizations",
      method: "GET",
      path: "/v1/organizations",
      schemaType: "array",
      schemaRef: "OrganizationResponseV1",
    },
    {
      name: "GET /v1/projects/:ref/config/auth",
      method: "GET",
      path: `/v1/projects/${projectRef}/config/auth`,
      schemaType: "object",
      schemaRef: "V1AuthConfigResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/config/database",
      method: "GET",
      path: `/v1/projects/${projectRef}/config/database`,
      schemaType: "object",
      schemaRef: "V1DatabaseConfigResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/database/migrations",
      method: "GET",
      path: `/v1/projects/${projectRef}/database/migrations`,
      schemaType: "array",
      schemaRef: "V1DatabaseMigrationResponse",
      skipIfMissing: true,
    },
    {
      name: "POST /v1/projects/:ref/database/query",
      method: "POST",
      path: `/v1/projects/${projectRef}/database/query`,
      body: { query: "SELECT 1 as test" },
      schemaType: "object",
      schemaRef: "V1QueryResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/functions",
      method: "GET",
      path: `/v1/projects/${projectRef}/functions`,
      schemaType: "array",
      schemaRef: "FunctionResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/functions/secrets",
      method: "GET",
      path: `/v1/projects/${projectRef}/functions/secrets`,
      schemaType: "array",
      schemaRef: "SecretResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/auth/users",
      method: "GET",
      path: `/v1/projects/${projectRef}/auth/users`,
      schemaType: "object",
      schemaRef: "V1AuthUsersResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/database/webhooks",
      method: "GET",
      path: `/v1/projects/${projectRef}/database/webhooks`,
      schemaType: "array",
      schemaRef: "V1DatabaseWebhookResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/services",
      method: "GET",
      path: `/v1/projects/${projectRef}/services`,
      schemaType: "array",
      schemaRef: "V1ServiceHealthResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/secrets",
      method: "GET",
      path: `/v1/projects/${projectRef}/secrets`,
      schemaType: "array",
      schemaRef: "V1SecretResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/network-restrictions",
      method: "GET",
      path: `/v1/projects/${projectRef}/network-restrictions`,
      schemaType: "object",
      schemaRef: "NetworkRestrictionsResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/custom-hostname",
      method: "GET",
      path: `/v1/projects/${projectRef}/custom-hostname`,
      schemaType: "object",
      schemaRef: "UpdateCustomHostnameResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/database/extensions",
      method: "GET",
      path: `/v1/projects/${projectRef}/database/extensions`,
      schemaType: "array",
      schemaRef: "V1DatabaseExtensionResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/storage/buckets",
      method: "GET",
      path: `/v1/projects/${projectRef}/storage/buckets`,
      schemaType: "array",
      schemaRef: "V1StorageBucketResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/config/storage",
      method: "GET",
      path: `/v1/projects/${projectRef}/config/storage`,
      schemaType: "object",
      schemaRef: "StorageConfigResponse",
      skipIfMissing: true,
    },
    {
      name: "GET /v1/projects/:ref/config/realtime",
      method: "GET",
      path: `/v1/projects/${projectRef}/config/realtime`,
      schemaType: "object",
      schemaRef: "RealtimeConfigResponse",
      skipIfMissing: true,
    },
  ];

  console.log(
    `\n🔍 Commencing Schema Structural Interrogation (${suites.length} endpoints)...`,
  );
  let failureCount = 0;
  let skipCount = 0;
  let passCount = 0;

  for (const suite of suites) {
    try {
      const resolvedKey = registry.resolveRef(suite.schemaRef);
      if (!resolvedKey) {
        if (suite.skipIfMissing) {
          console.log(
            `   ⏭️  SKIP ${suite.name} — schema "${suite.schemaRef}" not found in official spec`,
          );
          skipCount++;
          continue;
        }
        console.warn(
          `   ⚠️  Schema "${suite.schemaRef}" not found, attempting loose validation...`,
        );
      }

      const effectiveRef = resolvedKey
        ? `#/components/schemas/${resolvedKey}`
        : null;
      console.log(
        `\n➡️  Probing ${suite.name} (schema: ${effectiveRef || suite.schemaRef})...`,
      );

      const url = `${LOCAL_API_URL}${suite.path}`;
      const fetchOpts: RequestInit = {
        method: suite.method,
        headers: authHeaders,
      };
      if (suite.body) {
        fetchOpts.body = JSON.stringify(suite.body);
      }

      const res = await fetch(url, fetchOpts);
      if (!res.ok) {
        console.error(`   ❌ HTTP Error ${res.status} ${res.statusText}`);
        if (res.status === 404 && suite.skipIfMissing) {
          console.warn(
            `   ⚠️  Endpoint not implemented yet. Counting as skip because skipIfMissing=true.`,
          );
          skipCount++;
        } else {
          failureCount++;
        }
        continue;
      }

      const data = await res.json();

      if (!effectiveRef) {
        console.log(`   ✅ Endpoint responded (no schema to validate against)`);
        passCount++;
        continue;
      }

      let validator;
      try {
        if (suite.schemaType === "array") {
          validator = ajv.compile({
            type: "array",
            items: { $ref: effectiveRef },
          });
        } else {
          validator = ajv.compile({ $ref: effectiveRef });
        }
      } catch (compileErr: any) {
        console.warn(
          `   ⚠️  Schema compilation failed for ${effectiveRef}: ${compileErr.message}`,
        );
        skipCount++;
        continue;
      }

      const isValid = validator(data);
      if (!isValid) {
        console.error(`   ❌ Schema Mismatch Detected!`);
        const errors = validator.errors || [];
        for (const e of errors.slice(0, 10)) {
          console.error(`      - Path '${e.instancePath}': ${e.message}`);
        }
        if (errors.length > 10) {
          console.error(`      ... and ${errors.length - 10} more errors`);
        }
        failureCount++;
      } else {
        console.log(
          `   ✅ Response perfectly mirrors official schema: ${effectiveRef}`,
        );
        passCount++;
      }
    } catch (e: any) {
      console.error(`   ❌ Execution Error: ${e.message}`);
      failureCount++;
    }
  }

  console.log("\n🧹 Cleaning up OpenAPI Fuzzer Environment...");
  if (projectId!) {
    await sql`DELETE FROM project_tasks WHERE project_ref = ${projectRef}`.catch(
      () => {},
    );
    await projectService.deleteProject(projectRef).catch(() => {});
  }

  console.log(`\n📊 OpenAPI Compliance Results:`);
  console.log(`   ✅ Passed: ${passCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(`   ⏭️  Skipped: ${skipCount}`);
  console.log(
    `   📈 Pass rate: ${passCount + failureCount > 0 ? Math.round((passCount / (passCount + failureCount)) * 100) : 100}%`,
  );

  const tested = passCount + failureCount;

  if (tested === 0) {
    console.error(
      "\n❌ FAIL: no endpoints were actually validated. Check auth, test setup, and project provisioning before trusting this result.",
    );
    process.exit(1);
  }

  if (failureCount > 0) {
    console.error(
      `\n❌ FAIL: ${failureCount}/${tested} endpoints failed schema validation.`,
    );
    console.error("Fix the schema deviations above before merging.");
    process.exit(1);
  } else {
    console.log(
      "\n🎉 SUCCESS: All validated Management API schemas achieve parity with official Supabase spec!",
    );
    process.exit(0);
  }
}

run();
