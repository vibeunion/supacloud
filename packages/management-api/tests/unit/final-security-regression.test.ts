import { describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { projectFunctionsRoutes } from "../../src/routes/project-functions";
import { projectSecretsRoutes } from "../../src/routes/project-secrets";
import { projectConfigRoutes } from "../../src/routes/project-config";
import { projectService } from "../../src/services/project.service";
import {
  EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE,
  EdgeFunctionActiveVersionConflictError,
  edgeFunctionService,
} from "../../src/services/edge-function.service";
import { runtimeEnvService } from "../../src/services/runtime-env.service";
import { restoreLogicalBackup } from "../../src/services/backup.service";
import { sdkProxyInternals } from "../../src/routes/sdk-proxy";
import { decryptSecretIfNeeded, isEncryptedSecret } from "../../src/utils/secret-crypto";

const masterHeaders = { Authorization: "Bearer dev-master-token" };
const jsonMasterHeaders = { ...masterHeaders, "Content-Type": "application/json" };
const currentActivationId = "11111111-1111-4111-8111-111111111111";
const nextActivationId = "22222222-2222-4222-8222-222222222222";

function appWith(routes: Elysia) {
  const app = new Elysia().use(routes);
  return (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
}

function jsonMutation(
  request: ReturnType<typeof appWith>,
  path: string,
  method: string,
  body: unknown,
) {
  return request(path, { method, headers: jsonMasterHeaders, body: JSON.stringify(body) });
}

const missingActivationMutationCases: Array<[string, string, unknown]> = [
  ["POST", "/v1/projects/proj_1/functions/hello", {
    code: "export default {};",
    expected_active_version: "2",
  }],
  ["PATCH", "/v1/projects/proj_1/functions/hello", { verify_jwt: false }],
  ["POST", "/v1/projects/proj_1/functions", {
    slug: "hello",
    code: "export default {};",
    expected_active_version: "2",
  }],
  ["PUT", "/v1/projects/proj_1/functions", [{
    slug: "hello",
    code: "export default {};",
    expected_active_version: "2",
  }]],
  ["POST", "/v1/projects/proj_1/functions/hello/bundle", {
    files: { "index.ts": "export default {};" },
    expected_active_version: "2",
  }],
  ["POST", "/v1/projects/proj_1/functions/hello/versions/3/activate", {
    expected_active_version: "2",
  }],
  ["PATCH", "/v1/projects/proj_1/functions/hello/config", {
    verify_jwt: false,
    expected_activation_id: "LEGACY",
  }],
  ["DELETE", "/v1/projects/proj_1/functions/hello", {}],
  ["DELETE", "/v1/projects/proj_1/functions", { slug: "hello" }],
];

describe("final security regressions", () => {
  test("function management read endpoints require auth but preserve authenticated access", async () => {
    const listFunctionsSpy = spyOn(projectService, "listFunctions").mockResolvedValue([
      { slug: "hello", name: "hello", version: 0, activation_id: currentActivationId },
    ] as Awaited<ReturnType<typeof projectService.listFunctions>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const protectedPaths = [
        "/v1/projects/proj_1/functions",
        "/v1/projects/proj_1/functions/hello",
        "/v1/projects/proj_1/functions/hello/source",
        "/v1/projects/proj_1/functions/hello/versions",
        "/v1/projects/proj_1/functions/hello/versions/1",
        "/v1/projects/proj_1/functions/hello/body",
        "/v1/projects/proj_1/functions/hello/check",
        "/v1/projects/proj_1/functions/hello/config",
        "/v1/projects/proj_1/functions/hello/logs",
      ];

      for (const path of protectedPaths) {
        const unauthenticated = await request(path);
        expect(unauthenticated.status).toBe(401);
      }

      expect(listFunctionsSpy).not.toHaveBeenCalled();
      const authenticated = await request("/v1/projects/proj_1/functions", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual([{
        slug: "hello",
        name: "hello",
        version: 0,
        activation_id: currentActivationId,
      }]);
    } finally {
      listFunctionsSpy.mockRestore();
    }
  });

  test("function list does not turn artifact IO failures into active results", async () => {
    const ioError = Object.assign(new Error("synthetic function artifact failure"), {
      code: "EIO",
    });
    const listFunctionsSpy = spyOn(projectService, "listFunctions").mockRejectedValue(ioError);
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions", {
        headers: masterHeaders,
      });

      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('"status":"ACTIVE"');
    } finally {
      listFunctionsSpy.mockRestore();
    }
  });

  test("function detail resolves a manifest-less legacy alias as active version zero", async () => {
    const codeSpy = spyOn(projectService, "getFunctionCode").mockResolvedValue("export default {};");
    const configSpy = spyOn(edgeFunctionService, "getConfig").mockResolvedValue({
      verify_jwt: true,
      activation_id: "legacy",
    });
    const activeVersionSpy = spyOn(edgeFunctionService, "getActiveVersion").mockResolvedValue("0");
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/legacy-hook", {
        headers: masterHeaders,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        slug: "legacy-hook",
        version: 0,
        status: "ACTIVE",
        activation_id: "legacy",
      });
      expect(activeVersionSpy).toHaveBeenCalledWith("proj_1", "legacy-hook");
    } finally {
      codeSpy.mockRestore();
      configSpy.mockRestore();
      activeVersionSpy.mockRestore();
    }
  });

  test("function detail does not report active metadata after an active artifact failure", async () => {
    const codeSpy = spyOn(projectService, "getFunctionCode").mockRejectedValue(
      new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE),
    );
    const configSpy = spyOn(edgeFunctionService, "getConfig");
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/upgraded-hook", {
        headers: masterHeaders,
      });
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).not.toContain("stale-positive-alias");
      expect(body).not.toContain('"status":"ACTIVE"');
      expect(configSpy).not.toHaveBeenCalled();
    } finally {
      codeSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("function config read projects one atomic tombstone snapshot", async () => {
    const getStateSpy = spyOn(edgeFunctionService, "getState").mockResolvedValue({
      active_version: "absent",
      config: {
        verify_jwt: false,
        background_routes: ["/jobs/*"],
        activation_id: nextActivationId,
        persisted_unknown_field: "must-not-reflect",
      } as Awaited<ReturnType<typeof edgeFunctionService.getState>>["config"],
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello/config", {
        headers: masterHeaders,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        project_ref: "proj_1",
        slug: "hello",
        active_version: "absent",
        verify_jwt: false,
        background_routes: ["/jobs/*"],
        activation_id: nextActivationId,
      });
      expect(getStateSpy).toHaveBeenCalledWith("proj_1", "hello");
    } finally {
      getStateSpy.mockRestore();
    }
  });

  test("function version detail rejects legacy zero before service dispatch", async () => {
    const getVersionSpy = spyOn(edgeFunctionService, "getVersion").mockRejectedValue(
      new Error("legacy source version reached the service"),
    );
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request(
        "/v1/projects/proj_1/functions/legacy-hook/versions/0",
        { headers: masterHeaders },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "version must be a canonical positive safe integer",
        code: "VALIDATION_ERROR",
      });
      expect(getVersionSpy).not.toHaveBeenCalled();
    } finally {
      getVersionSpy.mockRestore();
    }
  });

  test("metadata-only Function PATCH preserves the authoritative legacy version zero", async () => {
    const updateConfigSpy = spyOn(edgeFunctionService, "updateConfig").mockResolvedValue({
      verify_jwt: false,
      activation_id: nextActivationId,
    });
    const activeVersionSpy = spyOn(edgeFunctionService, "getActiveVersion").mockResolvedValue("0");
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/legacy-hook", {
        method: "PATCH",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          verify_jwt: false,
          expected_activation_id: "legacy",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        slug: "legacy-hook",
        version: 0,
        status: "ACTIVE",
        verify_jwt: false,
        expected_activation_id: "legacy",
        activation_id: nextActivationId,
      });
      expect(updateConfigSpy).toHaveBeenCalledWith(
        "proj_1",
        "legacy-hook",
        { verify_jwt: false },
        "legacy",
      );
    } finally {
      updateConfigSpy.mockRestore();
      activeVersionSpy.mockRestore();
    }
  });

  test("Function create readback uses release or filesystem truth without inventing version one", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: true,
      previous_active_version: "0",
      active_version: "1",
      activation_id: nextActivationId,
      config: { verify_jwt: true, activation_id: nextActivationId },
    });
    const updateConfigSpy = spyOn(edgeFunctionService, "updateConfig").mockResolvedValue({
      verify_jwt: true,
      activation_id: nextActivationId,
    });
    const activeVersionSpy = spyOn(edgeFunctionService, "getActiveVersion")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("absent");
    const request = appWith(projectFunctionsRoutes);

    try {
      const multipart = new FormData();
      multipart.set("metadata", JSON.stringify({
        expected_active_version: "0",
        expected_activation_id: "legacy",
      }));
      multipart.set("file", new File(["export default {};"], "index.ts"));
      const deployed = await request("/v1/projects/proj_1/functions/deploy?slug=legacy-hook", {
        method: "POST",
        headers: masterHeaders,
        body: multipart,
      });
      const legacy = await request("/v1/projects/proj_1/functions", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "legacy-hook", expected_activation_id: "legacy" }),
      });
      const absent = await request("/v1/projects/proj_1/functions", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "missing-hook", expected_activation_id: "legacy" }),
      });

      expect(await deployed.json()).toMatchObject({
        version: 1,
        previous_active_version: "0",
        status: "ACTIVE",
        expected_activation_id: "legacy",
        activation_id: nextActivationId,
      });
      expect(await legacy.json()).toMatchObject({
        slug: "legacy-hook",
        version: 0,
        status: "ACTIVE",
      });
      expect(await absent.json()).toMatchObject({
        slug: "missing-hook",
        version: null,
        status: "INACTIVE",
      });
    } finally {
      deploySpy.mockRestore();
      updateConfigSpy.mockRestore();
      activeVersionSpy.mockRestore();
    }
  });

  test("function secrets GET requires auth and never reveals values", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "EDGEFN_SECRET", value: "plain-secret" },
      { name: "SUPACLOUD_INTERNAL_TOKEN", value: "internal-secret" },
      { name: "JWT_SECRET", value: "jwt-secret" },
    ] as Awaited<ReturnType<typeof projectService.getSecrets>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/functions/secrets");
      expect(unauthenticated.status).toBe(401);

      const masked = await request("/v1/projects/proj_1/functions/secrets", { headers: masterHeaders });
      expect(masked.status).toBe(200);
      expect(await masked.json()).toEqual([
        expect.objectContaining({ name: "EDGEFN_SECRET", value: "********" }),
      ]);

      const reveal = await request("/v1/projects/proj_1/functions/secrets?reveal=true", { headers: masterHeaders });
      expect(reveal.status).toBe(200);
      expect(await reveal.json()).toEqual([
        expect.objectContaining({ name: "EDGEFN_SECRET", value: "********" }),
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("project secrets never reveal values outside the internal runtime endpoint", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "CAPTCHA_SECRET", value: "plain-secret" },
      { name: "SUPACLOUD_INTERNAL_TOKEN", value: "internal-secret" },
      { name: "ADMIN_SSO_CLIENT_ID", value: "internal-client" },
      { name: "JWT_SECRET", value: "jwt-secret" },
    ] as Awaited<ReturnType<typeof projectService.getSecrets>>);
    const request = appWith(projectSecretsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/secrets?reveal=true", {
        headers: masterHeaders,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        { name: "CAPTCHA_SECRET", value: "********" },
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("project secret writes cannot overwrite or delete system-managed names", async () => {
    const upsertSecretsSpy = spyOn(projectService, "upsertSecrets").mockResolvedValue(true);
    const deleteSecretSpy = spyOn(projectService, "deleteSecret").mockResolvedValue(true);
    const request = appWith(projectSecretsRoutes);

    try {
      const writeResponse = await request("/v1/projects/proj_1/secrets", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify([{ name: "SUPACLOUD_INTERNAL_TOKEN", value: "replacement" }]),
      });
      const bulkDeleteResponse = await request("/v1/projects/proj_1/secrets", {
        method: "DELETE",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(["JWT_SECRET"]),
      });
      const singleDeleteResponse = await request("/v1/projects/proj_1/secrets/JWT_SECRET", {
        method: "DELETE",
        headers: masterHeaders,
      });

      expect(writeResponse.status).toBe(400);
      expect(bulkDeleteResponse.status).toBe(400);
      expect(singleDeleteResponse.status).toBe(400);
      expect(upsertSecretsSpy).not.toHaveBeenCalled();
      expect(deleteSecretSpy).not.toHaveBeenCalled();
    } finally {
      upsertSecretsSpy.mockRestore();
      deleteSecretSpy.mockRestore();
    }
  });

  test("per-function secrets GET requires auth and masks by default", async () => {
    const getSecretsSpy = spyOn(projectService, "getSecrets").mockResolvedValue([
      { name: "EDGEFN_HELLO_TOKEN", value: "fn-secret" },
      { name: "EDGEFN_OTHER_TOKEN", value: "other-secret" },
    ] as Awaited<ReturnType<typeof projectService.getSecrets>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/functions/hello/secrets");
      expect(unauthenticated.status).toBe(401);

      const masked = await request("/v1/projects/proj_1/functions/hello/secrets", { headers: masterHeaders });
      expect(masked.status).toBe(200);
      expect(await masked.json()).toEqual([
        expect.objectContaining({ name: "EDGEFN_HELLO_TOKEN", value: "********" }),
      ]);
    } finally {
      getSecretsSpy.mockRestore();
    }
  });

  test("function deploy response exposes bundle and preheat metadata", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: true,
      previous_active_version: "2",
      active_version: "3",
      activation_id: nextActivationId,
      version: "3",
      bundled: true,
      bundle_hash: "0123456789abcdef",
      bundle_size_bytes: 4096,
      import_count: 2,
      external_packages: ["left-pad"],
      preheat: {
        ok: true,
        duration_ms: 15,
        attempted: 3,
        succeeded: 3,
        cache_hits: 1,
        cache_misses: 2,
      },
      config: {
        verify_jwt: false,
        version: "3",
        background_routes: ["/queue/*"],
        activation_id: nextActivationId,
      },
    } as Awaited<ReturnType<typeof projectService.deployFunctionRelease>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "export default { fetch() { return new Response('ok') } }",
          expected_active_version: "2",
          expected_activation_id: currentActivationId,
          verify_jwt: false,
          background_routes: ["/queue/*"],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        project_ref: "proj_1",
        slug: "hello",
        previous_active_version: "2",
        active_version: "3",
        expected_activation_id: currentActivationId,
        activation_id: nextActivationId,
        bundled: true,
        version: "3",
        bundle_hash: "0123456789abcdef",
        bundle_size_bytes: 4096,
        import_count: 2,
        external_packages: ["left-pad"],
        verify_jwt: false,
        background_routes: ["/queue/*"],
        preheat: {
          ok: true,
          attempted: 3,
          succeeded: 3,
          cache_hits: 1,
          cache_misses: 2,
        },
      });
      expect(deploySpy).toHaveBeenCalledWith({
        ref: "proj_1",
        slug: "hello",
        expectedActiveVersion: "2",
        expectedActivationId: currentActivationId,
        code: "export default { fetch() { return new Response('ok') } }",
        minify: false,
        config: { verify_jwt: false, background_routes: ["/queue/*"] },
      });
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("prebundled function deploy passes the exact-byte contract to the release primitive", async () => {
    const code = "export default { fetch: () => new Response('exact-route-bytes') };\r\n";
    const expectedSha256 = createHash("sha256").update(code).digest("hex");
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: true,
      previous_active_version: "2",
      active_version: "3",
      version: "3",
      bundled: true,
      activation_id: nextActivationId,
      config: { verify_jwt: true, version: "3", activation_id: nextActivationId },
    } as Awaited<ReturnType<typeof projectService.deployFunctionRelease>>);
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/fa-api", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          prebundled: true,
          expected_sha256: expectedSha256,
          expected_active_version: "2",
          expected_activation_id: currentActivationId,
        }),
      });

      expect(response.status).toBe(200);
      expect(deploySpy).toHaveBeenCalledWith({
        ref: "proj_1",
        slug: "fa-api",
        expectedActiveVersion: "2",
        expectedActivationId: currentActivationId,
        code,
        prebundled: true,
        expectedSha256,
        config: {},
      });
    } finally {
      deploySpy.mockRestore();
    }
  });

  test.each([
    ["missing hash", { prebundled: true }],
    ["minify requested", { prebundled: true, expected_sha256: "0".repeat(64), minify: false }],
    ["hash without mode", { expected_sha256: "0".repeat(64) }],
  ])("rejects prebundled deployment with %s before service dispatch", async (_label, fields) => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease");
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/fa-api", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "export default { fetch: () => new Response('blocked') };",
          expected_active_version: "absent",
          expected_activation_id: "legacy",
          ...fields,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "prebundled deploy requires expected_sha256 and does not accept minify",
        code: "VALIDATION_ERROR",
      });
      expect(deploySpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("function deploy requires an expected active version before service dispatch", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease");
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "export default { fetch() { return new Response('blocked') } }",
          expected_activation_id: currentActivationId,
        }),
      });

      expect(response.status).toBe(422);
      expect(deploySpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("function deploy rejects noncanonical expected active versions before service dispatch", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockRejectedValue(
      new Error("invalid expected version reached the deploy service"),
    );
    const request = appWith(projectFunctionsRoutes);

    try {
      for (const expectedActiveVersion of [0, "01", "", "9007199254740992", null]) {
        const response = await request("/v1/projects/proj_1/functions/hello", {
          method: "POST",
          headers: { ...masterHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            code: "export default { fetch() { return new Response('blocked') } }",
            expected_active_version: expectedActiveVersion,
            expected_activation_id: currentActivationId,
          }),
        });

        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect(deploySpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
  });

  test.each(missingActivationMutationCases)(
    "function mutation %s %s rejects a missing or noncanonical activation identity",
    async (method, path, body) => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease");
    const updateConfigSpy = spyOn(edgeFunctionService, "updateConfig");
    const activateSpy = spyOn(edgeFunctionService, "activateVersion");
    const removeSpy = spyOn(edgeFunctionService, "remove");
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await jsonMutation(request, path, method, body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(deploySpy).not.toHaveBeenCalled();
      expect(updateConfigSpy).not.toHaveBeenCalled();
      expect(activateSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
      updateConfigSpy.mockRestore();
      activateSpy.mockRestore();
      removeSpy.mockRestore();
    }
    },
  );

  test("multipart deploy rejects a noncanonical activation identity before dispatch", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease");
    const request = appWith(projectFunctionsRoutes);
    const multipart = new FormData();
    multipart.set("metadata", JSON.stringify({
      expected_active_version: "2",
      expected_activation_id: "11111111-1111-4111-C111-111111111111",
    }));
    multipart.set("file", new File(["export default {};"], "index.ts"));

    try {
      const response = await request("/v1/projects/proj_1/functions/deploy?slug=hello", {
        method: "POST",
        headers: masterHeaders,
        body: multipart,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "expected_activation_id must be a canonical UUID or 'legacy'",
        code: "VALIDATION_ERROR",
      });
      expect(deploySpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("function deploy accepts the canonical legacy version zero CAS token", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: true,
      previous_active_version: "0",
      active_version: "1",
      version: "1",
      activation_id: nextActivationId,
      config: { version: "1", verify_jwt: true, activation_id: nextActivationId },
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/legacy-hook", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "export default { fetch() { return new Response('upgraded') } }",
          expected_active_version: "0",
          expected_activation_id: "legacy",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        slug: "legacy-hook",
        previous_active_version: "0",
        active_version: "1",
        version: "1",
        expected_activation_id: "legacy",
        activation_id: nextActivationId,
      });
      expect(deploySpy).toHaveBeenCalledWith(expect.objectContaining({
        ref: "proj_1",
        slug: "legacy-hook",
        expectedActiveVersion: "0",
        expectedActivationId: "legacy",
      }));
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("function deploy maps active version conflicts to HTTP 409", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: false,
      error_code: "FUNCTION_ACTIVE_VERSION_CONFLICT",
      expected_active_version: "2",
      active_version: "3",
      expected_activation_id: currentActivationId,
      activation_id: nextActivationId,
      error: "Function active version changed before the requested mutation",
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "export default { fetch() { return new Response('blocked') } }",
          expected_active_version: "2",
          expected_activation_id: currentActivationId,
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "FUNCTION_ACTIVE_VERSION_CONFLICT",
        expected_active_version: "2",
        active_version: "3",
        expected_activation_id: currentActivationId,
        activation_id: nextActivationId,
      });
      expect(deploySpy).toHaveBeenCalledTimes(1);
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("bulk function deploy maps active version conflicts to HTTP 409", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: false,
      error_code: "FUNCTION_ACTIVE_VERSION_CONFLICT",
      expected_active_version: "2",
      active_version: "3",
      expected_activation_id: currentActivationId,
      activation_id: nextActivationId,
      error: "Function active version changed before the requested mutation",
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions", {
        method: "PUT",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify([{
          slug: "hello",
          code: "export default { fetch() { return new Response('blocked') } }",
          expected_active_version: "2",
          expected_activation_id: currentActivationId,
        }]),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        functions: [expect.objectContaining({
          slug: "hello",
          success: false,
          error_code: "FUNCTION_ACTIVE_VERSION_CONFLICT",
          active_version: "3",
          expected_activation_id: currentActivationId,
          activation_id: nextActivationId,
        })],
      });
      expect(deploySpy).toHaveBeenCalledTimes(1);
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("bulk function deploy fails HTTP closed for a non-conflict release failure", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: false,
      error: "synthetic build failure",
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await jsonMutation(request, "/v1/projects/proj_1/functions", "PUT", [{
        slug: "hello",
        code: "export default {};",
        expected_active_version: "2",
        expected_activation_id: currentActivationId,
      }]);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        functions: [expect.objectContaining({ slug: "hello", success: false })],
      });
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("bulk function deploy keeps each release bound to its own observed identity", async () => {
    const firstCommittedId = "33333333-3333-4333-8333-333333333333";
    const secondCommittedId = "44444444-4444-4444-8444-444444444444";
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockImplementation(
      async (release) => {
        const isFirst = release.slug === "first";
        const activationId = isFirst ? firstCommittedId : secondCommittedId;
        const version = isFirst ? "3" : "8";
        return {
          success: true,
          previous_active_version: release.expectedActiveVersion,
          active_version: version,
          version,
          activation_id: activationId,
          config: { verify_jwt: true, version, activation_id: activationId },
        };
      },
    );
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await jsonMutation(request, "/v1/projects/proj_1/functions", "PUT", [
        {
          slug: "first",
          code: "export default {};",
          expected_active_version: "2",
          expected_activation_id: currentActivationId,
        },
        {
          slug: "second",
          code: "export default {};",
          expected_active_version: "7",
          expected_activation_id: nextActivationId,
        },
      ]);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          slug: "first",
          success: true,
          expected_activation_id: currentActivationId,
          activation_id: firstCommittedId,
        }),
        expect.objectContaining({
          slug: "second",
          success: true,
          expected_activation_id: nextActivationId,
          activation_id: secondCommittedId,
        }),
      ]);
      expect(deploySpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
        slug: "first",
        expectedActiveVersion: "2",
        expectedActivationId: currentActivationId,
      }));
      expect(deploySpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
        slug: "second",
        expectedActiveVersion: "7",
        expectedActivationId: nextActivationId,
      }));
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("function activation requires and enforces expected active version", async () => {
    const activationSpy = spyOn(edgeFunctionService, "activateVersion");
    const request = appWith(projectFunctionsRoutes);

    try {
      const missing = await request(
        "/v1/projects/proj_1/functions/hello/versions/2/activate",
        { method: "POST", headers: masterHeaders },
      );
      expect(missing.status).toBe(422);
      expect(activationSpy).not.toHaveBeenCalled();

      activationSpy.mockRejectedValueOnce(new EdgeFunctionActiveVersionConflictError(
        "1",
        "2",
        currentActivationId,
        nextActivationId,
      ));
      const stale = await request(
        "/v1/projects/proj_1/functions/hello/versions/3/activate",
        {
          method: "POST",
          headers: { ...masterHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_active_version: "1",
            expected_activation_id: currentActivationId,
          }),
        },
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: "FUNCTION_ACTIVE_VERSION_CONFLICT",
        expected_active_version: "1",
        active_version: "2",
        expected_activation_id: currentActivationId,
        activation_id: nextActivationId,
      });
      expect(activationSpy).toHaveBeenCalledWith(
        "proj_1",
        "hello",
        "3",
        "1",
        currentActivationId,
      );
    } finally {
      activationSpy.mockRestore();
    }
  });

  test("function activation accepts legacy version zero only as the CAS token", async () => {
    const activationSpy = spyOn(edgeFunctionService, "activateVersion").mockResolvedValue({
      previous_active_version: "0",
      active_version: "2",
      activation_id: nextActivationId,
      config: { version: "2", verify_jwt: true, activation_id: nextActivationId },
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request(
        "/v1/projects/proj_1/functions/legacy-hook/versions/2/activate",
        {
          method: "POST",
          headers: { ...masterHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_active_version: "0",
            expected_activation_id: "legacy",
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        previous_active_version: "0",
        active_version: "2",
        version: "2",
        expected_activation_id: "legacy",
        activation_id: nextActivationId,
      });
      expect(activationSpy).toHaveBeenCalledWith(
        "proj_1",
        "legacy-hook",
        "2",
        "0",
        "legacy",
      );
    } finally {
      activationSpy.mockRestore();
    }
  });

  test("function config update forwards activation CAS and maps conflicts to HTTP 409", async () => {
    const updateConfigSpy = spyOn(edgeFunctionService, "updateConfig").mockRejectedValue(
      new EdgeFunctionActiveVersionConflictError(
        "2",
        "2",
        currentActivationId,
        nextActivationId,
      ),
    );
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello/config", {
        method: "PATCH",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          verify_jwt: false,
          expected_activation_id: currentActivationId,
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        expected_activation_id: currentActivationId,
        activation_id: nextActivationId,
      });
      expect(updateConfigSpy).toHaveBeenCalledWith(
        "proj_1",
        "hello",
        { verify_jwt: false },
        currentActivationId,
      );
    } finally {
      updateConfigSpy.mockRestore();
    }
  });

  test("function config update returns the committed config and activation identity", async () => {
    const updateConfigSpy = spyOn(edgeFunctionService, "updateConfig").mockResolvedValue({
      verify_jwt: false,
      background_routes: ["/jobs/*"],
      activation_id: nextActivationId,
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/functions/hello/config", {
        method: "PATCH",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          verify_jwt: false,
          background_routes: ["/jobs/*"],
          expected_activation_id: currentActivationId,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        verify_jwt: false,
        background_routes: ["/jobs/*"],
        expected_activation_id: currentActivationId,
        activation_id: nextActivationId,
      });
    } finally {
      updateConfigSpy.mockRestore();
    }
  });

  test("both function delete routes forward activation CAS and return the new identity", async () => {
    const projectSpy = spyOn(projectService, "getProject").mockResolvedValue(
      { ref: "proj_1" } as Awaited<ReturnType<typeof projectService.getProject>>,
    );
    const removeSpy = spyOn(edgeFunctionService, "remove").mockResolvedValue({
      previous_active_version: "3",
      active_version: "absent",
      activation_id: nextActivationId,
      config: { verify_jwt: true, activation_id: nextActivationId },
    });
    const configSpy = spyOn(edgeFunctionService, "getConfig");
    const request = appWith(projectFunctionsRoutes);
    const headers = { ...masterHeaders, "Content-Type": "application/json" };

    try {
      const byBody = await request("/v1/projects/proj_1/functions", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ slug: "hello", expected_activation_id: currentActivationId }),
      });
      const byPath = await request("/v1/projects/proj_1/functions/hello", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ expected_activation_id: currentActivationId }),
      });

      expect([byBody.status, byPath.status]).toEqual([200, 200]);
      expect(await byBody.json()).toMatchObject({
        expected_activation_id: currentActivationId,
        activation_id: nextActivationId,
        previous_active_version: "3",
        active_version: "absent",
        config: { activation_id: nextActivationId },
      });
      expect(await byPath.json()).toMatchObject({ activation_id: nextActivationId });
      expect(removeSpy).toHaveBeenCalledTimes(2);
      expect(removeSpy).toHaveBeenCalledWith("proj_1", "hello", currentActivationId);
      expect(configSpy).not.toHaveBeenCalled();
    } finally {
      projectSpy.mockRestore();
      removeSpy.mockRestore();
      configSpy.mockRestore();
    }
  });

  test("delete tombstone identity authorizes same-slug recreation", async () => {
    const projectSpy = spyOn(projectService, "getProject").mockResolvedValue(
      { ref: "proj_1" } as Awaited<ReturnType<typeof projectService.getProject>>,
    );
    const removeSpy = spyOn(edgeFunctionService, "remove").mockResolvedValue({
      previous_active_version: "3",
      active_version: "absent",
      activation_id: nextActivationId,
      config: { verify_jwt: true, activation_id: nextActivationId },
    });
    const getStateSpy = spyOn(edgeFunctionService, "getState").mockResolvedValue({
      active_version: "absent",
      config: { verify_jwt: true, activation_id: nextActivationId },
    });
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockResolvedValue({
      success: true,
      previous_active_version: "absent",
      active_version: "1",
      version: "1",
      activation_id: currentActivationId,
      config: { verify_jwt: true, version: "1", activation_id: currentActivationId },
    });
    const request = appWith(projectFunctionsRoutes);

    try {
      const deleted = await jsonMutation(
        request,
        "/v1/projects/proj_1/functions/hello",
        "DELETE",
        { expected_activation_id: currentActivationId },
      );
      const tombstone = await request("/v1/projects/proj_1/functions/hello/config", {
        headers: masterHeaders,
      });
      const recreated = await jsonMutation(request, "/v1/projects/proj_1/functions", "POST", {
        slug: "hello",
        code: "export default { fetch() { return new Response('recreated') } }",
        expected_active_version: "absent",
        expected_activation_id: nextActivationId,
      });

      expect([deleted.status, tombstone.status, recreated.status]).toEqual([200, 200, 200]);
      expect(await tombstone.json()).toMatchObject({
        active_version: "absent",
        activation_id: nextActivationId,
      });
      expect(deploySpy).toHaveBeenCalledWith(expect.objectContaining({
        ref: "proj_1",
        slug: "hello",
        expectedActiveVersion: "absent",
        expectedActivationId: nextActivationId,
      }));
    } finally {
      projectSpy.mockRestore();
      removeSpy.mockRestore();
      getStateSpy.mockRestore();
      deploySpy.mockRestore();
    }
  });

  test("function activation rejects noncanonical target versions before service dispatch", async () => {
    const activationSpy = spyOn(edgeFunctionService, "activateVersion").mockRejectedValue(
      new Error("invalid target version reached the activation service"),
    );
    const request = appWith(projectFunctionsRoutes);

    try {
      for (const targetVersion of ["01", "9007199254740992"]) {
        const response = await request(
          `/v1/projects/proj_1/functions/hello/versions/${targetVersion}/activate`,
          {
            method: "POST",
            headers: { ...masterHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              expected_active_version: "1",
              expected_activation_id: currentActivationId,
            }),
          },
        );

        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect(activationSpy).not.toHaveBeenCalled();
    } finally {
      activationSpy.mockRestore();
    }
  });

  test("function activation rejects public version zero with HTTP 400 before service dispatch", async () => {
    const activationSpy = spyOn(edgeFunctionService, "activateVersion").mockRejectedValue(
      new Error("legacy target reached the public activation service"),
    );
    const request = appWith(projectFunctionsRoutes);

    try {
      const response = await request(
        "/v1/projects/proj_1/functions/hello/versions/0/activate",
        {
          method: "POST",
          headers: { ...masterHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_active_version: "1",
            expected_activation_id: currentActivationId,
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "version must be a canonical positive safe integer",
        code: "VALIDATION_ERROR",
      });
      expect(activationSpy).not.toHaveBeenCalled();
    } finally {
      activationSpy.mockRestore();
    }
  });

  test("all code deploy routes pass policy through the atomic release primitive", async () => {
    const deploySpy = spyOn(projectService, "deployFunctionRelease").mockImplementation(async (release) => ({
      success: true,
      previous_active_version: release.expectedActiveVersion,
      active_version: "4",
      version: "4",
      activation_id: nextActivationId,
      bundled: "files" in release,
      files: "files" in release ? Object.keys(release.files).length : undefined,
      config: {
        verify_jwt: release.config?.verify_jwt ?? true,
        background_routes: release.config?.background_routes ?? [],
        version: "4",
        activation_id: nextActivationId,
      },
    }));
    const request = appWith(projectFunctionsRoutes);
    const jsonHeaders = { ...masterHeaders, "Content-Type": "application/json" };

    try {
      const bundleResponse = await request("/v1/projects/proj_1/functions/bundle-fn/bundle", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          files: { "index.ts": "export default { fetch() { return new Response('bundle') } }" },
          expected_active_version: "absent",
          expected_activation_id: "legacy",
          verify_jwt: false,
        }),
      });
      const patchResponse = await request("/v1/projects/proj_1/functions/patch-fn", {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          code: "export default { fetch() { return new Response('patch') } }",
          expected_active_version: "absent",
          expected_activation_id: "legacy",
          verify_jwt: false,
        }),
      });
      const bulkResponse = await request("/v1/projects/proj_1/functions", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify([{
          slug: "bulk-fn",
          code: "export default { fetch() { return new Response('bulk') } }",
          expected_active_version: "absent",
          expected_activation_id: "legacy",
          verify_jwt: false,
        }]),
      });
      const multipart = new FormData();
      multipart.set("metadata", JSON.stringify({
        entrypoint_path: "index.ts",
        expected_active_version: "absent",
        expected_activation_id: "legacy",
        verify_jwt: false,
      }));
      multipart.set("file", new File([
        "export default { fetch() { return new Response('multipart') } }",
      ], "index.ts", { type: "application/typescript" }));
      const multipartResponse = await request("/v1/projects/proj_1/functions/deploy?slug=multipart-fn", {
        method: "POST",
        headers: masterHeaders,
        body: multipart,
      });

      expect([
        bundleResponse.status,
        patchResponse.status,
        bulkResponse.status,
        multipartResponse.status,
      ]).toEqual([200, 200, 200, 200]);
      expect(deploySpy).toHaveBeenCalledTimes(4);
      for (const call of deploySpy.mock.calls) {
        expect(call[0].config).toMatchObject({ verify_jwt: false });
      }
    } finally {
      deploySpy.mockRestore();
    }
  });

  test("internal runtime env endpoint requires master auth and returns unmasked values", async () => {
    const runtimeEnvSpy = spyOn(runtimeEnvService, "buildProjectRuntimeEnv").mockResolvedValue({
      SUPACLOUD_PROJECT_REF: "proj_1",
      SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
    });
    const request = appWith(projectSecretsRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/internal/runtime-env");
      expect(unauthenticated.status).toBe(401);

      const authenticated = await request("/v1/projects/proj_1/internal/runtime-env", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual({
        SUPACLOUD_PROJECT_REF: "proj_1",
        SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
      });
    } finally {
      runtimeEnvSpy.mockRestore();
    }
  });

  test("project secrets writes invalidate Edge Runtime env cache", async () => {
    const originalFetch = globalThis.fetch;
    const upsertSecretsSpy = spyOn(projectService, "upsertSecrets").mockResolvedValue(true);
    const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/invalidate-env/proj_1");
      expect(init?.method).toBe("POST");
      return Promise.resolve(Response.json({ invalidated: "proj_1" }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const request = appWith(projectSecretsRoutes);

    try {
      const response = await request("/v1/projects/proj_1/secrets", {
        method: "POST",
        headers: { ...masterHeaders, "Content-Type": "application/json" },
        body: JSON.stringify([{ name: "RESULT_S3_ENDPOINT", value: "http://new-s3.local" }]),
      });

      expect(response.status).toBe(200);
      expect(upsertSecretsSpy).toHaveBeenCalledWith("proj_1", [
        { name: "RESULT_S3_ENDPOINT", value: "http://new-s3.local" },
      ]);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      upsertSecretsSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("API keys GET requires project or admin auth", async () => {
    const getApiKeysSpy = spyOn(projectService, "getApiKeys").mockResolvedValue({
      anon_key: "anon-key",
      service_role_key: "service-key",
      publishable_key: "sb_publishable_example",
      secret_key: "sb_secret_example",
    });
    const request = appWith(projectConfigRoutes);

    try {
      const unauthenticated = await request("/v1/projects/proj_1/api-keys");
      expect(unauthenticated.status).toBe(401);

      const authenticated = await request("/v1/projects/proj_1/api-keys", { headers: masterHeaders });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual([
        { name: "publishable", api_key: "sb_publishable_example" },
        { name: "secret", api_key: "********" },
        { name: "anon", api_key: "anon-key" },
        { name: "service_role", api_key: "********" },
      ]);
    } finally {
      getApiKeysSpy.mockRestore();
    }
  });

  test("logical restore rejects path traversal backup ids", async () => {
    const result = await restoreLogicalBackup("proj_1", "../../etc/passwd");
    expect(result.success).toBe(false);
    expect(result.message).toBe("Invalid backup id");
  });

  test("background function tasks persist encrypted credentials", async () => {
    const auth = sdkProxyInternals.buildEncryptedBackgroundAuth({
      authKind: "jwt",
      authorization: "Bearer user-jwt",
      apikey: "anon-key",
      authPayload: { sub: "user_1", role: "authenticated" },
      apikeyKind: "anon",
    });

    expect(auth.authorization).not.toBe("Bearer user-jwt");
    expect(auth.apikey).not.toBe("anon-key");
    expect(isEncryptedSecret(auth.authorization)).toBe(true);
    expect(isEncryptedSecret(auth.apikey)).toBe(true);
    expect(decryptSecretIfNeeded(auth.authorization || "")).toBe("Bearer user-jwt");
    expect(decryptSecretIfNeeded(auth.apikey || "")).toBe("anon-key");
    expect(auth.invoker_user_id).toBe("user_1");
    expect(auth.invoker_role).toBe("authenticated");
    expect(auth.apikey_kind).toBe("anon");
  });
});
