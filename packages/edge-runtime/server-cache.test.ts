import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

describe("Edge Runtime auth material invalidation", () => {
  test("runtime env invalidation clears tenant environment material", () => {
    const endpoint = source.slice(
      source.indexOf('.post("/invalidate-env/:ref"'),
      source.indexOf('.post("/preheat/:ref/:slug"'),
    );
    expect(endpoint).toContain("invalidateTenantEnvCache(c.params.ref)");
    expect(endpoint).not.toContain("secretsCache");
  });

  test("does not treat an unknown runtime mode as local during fallback", () => {
    expect(source).toContain("/auth/runtime");
    expect(source).toContain("if (authRuntime.mode === \"shared\")");
    expect(source).toContain("Refusing local fallback secrets for SupAuth dependent");
  });

  test("preheats an explicitly requested inactive function version", () => {
    const endpoint = source.slice(
      source.indexOf('.post("/preheat/:ref/:slug"'),
      source.indexOf('.post("/internal/background/:ref/:functionName/*"'),
    );
    expect(endpoint).toContain('headers.get("x-supacloud-function-version")');
    expect(endpoint).toContain("requestedVersion,");
    expect(endpoint).toContain("`_v${requestedVersion}`");
    expect(endpoint).toContain("version: requestedVersion");
    expect(endpoint).toContain("preheatVersionedIdleWorkers");
    expect(endpoint).toContain("preheatIdleWorkers");
    const regularBranchStart = endpoint.indexOf(": await Promise.all");
    const versionedBranch = endpoint.slice(endpoint.indexOf("? await Promise.all"), regularBranchStart);
    const regularBranch = endpoint.slice(regularBranchStart, endpoint.indexOf("return {"));
    expect(versionedBranch).toContain("preheatVersionedIdleWorkers");
    expect(versionedBranch).not.toContain("preheatIdleWorkers");
    expect(regularBranch).toContain("preheatIdleWorkers");
    expect(regularBranch).not.toContain("preheatVersionedIdleWorkers");
    expect(endpoint).toContain("foreground,");
    expect(endpoint).toContain("background,");
  });

  test("recycles the whole runtime after bounded worker churn", () => {
    expect(source.match(/onWorkerRecycleRequired: requestRuntimeRecycle/g)).toHaveLength(2);
    expect(source).toContain('gracefulShutdown("worker replacement budget", 1)');
    expect(source).toContain("queueMicrotask");
    expect(source).toContain("const gracefulShutdown = async (signal: string, exitCode = 0)");
    expect(source).toContain("await Bun.sleep(WORKER_RECYCLE_RESPONSE_GRACE_MS)");
    expect(source).toContain("process.exit(exitCode)");
  });

  test("function invalidation evicts policy config and active dispatch identities include version", () => {
    const invalidationEndpoint = source.slice(
      source.indexOf('.post("/invalidate/:ref/:slug"'),
      source.indexOf('.post("/invalidate-env/:ref"'),
    );
    expect(invalidationEndpoint).toContain("configCache.delete(`${c.params.ref}/${c.params.slug}`)");
    expect(invalidationEndpoint).toContain('module_scope: "legacy-base-only"');
    expect(invalidationEndpoint).toContain("immutable_versions_retained: true");
    expect(invalidationEndpoint).toContain("config_cache_evicted: true");
    expect(source).toContain('const versionSuffix = activeVersion ? `_v${activeVersion}` : ""');
    expect(source).toContain('`active:${activeVersion || "legacy"}`');
  });

  test("external requests use one resolved activation snapshot and ignore version headers", () => {
    const requestHandler = source.slice(
      source.indexOf("async function handleFunctionRequest("),
      source.indexOf("const app = new Elysia()"),
    );
    const dispatcher = source.slice(
      source.indexOf("async function dispatchFunction("),
      source.indexOf("async function appendFunctionRuntimeLog("),
    );
    const poolDispatch = dispatcher.slice(
      dispatcher.indexOf("return await targetPool.dispatch({"),
      dispatcher.indexOf(
        "    });",
        dispatcher.indexOf("return await targetPool.dispatch({"),
      ),
    );
    expect(requestHandler).toContain("activation = await resolveFunctionPath(projectRef, functionName)");
    expect(requestHandler).toContain("activation.verifyJwt");
    expect(requestHandler).toContain("activation,");
    expect(requestHandler).not.toContain("x-supacloud-function-version");
    expect(poolDispatch).toContain("functionVersion: responseVersion");
    expect(poolDispatch).not.toContain("functionVersion: activeVersion");
    expect(dispatcher).not.toContain("x-supacloud-function-version");
  });

  test("active versions resolve only immutable artifacts", () => {
    const resolver = source.slice(
      source.indexOf("async function resolveFunctionPath("),
      source.indexOf("function functionDispatchError("),
    );
    expect(resolver).toContain(
      "activeFunctionPathCandidates(projectRoot, functionName, activeVersion)",
    );
    expect(resolver).toContain("versionBindingResolver = resolveFunctionVersionBinding");
    expect(resolver).toContain("versionBindingResolver(");
    expect(resolver).toContain("requestedVersion,");
    expect(resolver).toContain("resolvedConfig.version,");
    expect(resolver).toContain("responseVersion,");
  });

  test("background routes envelope function resolution failures", () => {
    const wildcardRoute = source.slice(
      source.indexOf('.post("/internal/background/:ref/:functionName/*"'),
      source.indexOf('.post("/internal/background/:ref/:functionName"'),
    );
    const exactRoute = source.slice(
      source.indexOf('.post("/internal/background/:ref/:functionName"'),
      source.indexOf('.post("/internal/background/cancel/:taskId"'),
    );

    for (const route of [wildcardRoute, exactRoute]) {
      expect(route).toContain("let response: Response;");
      expect(route).toContain("try {");
      expect(route).toContain("resolveTrustedBackgroundFunctionVersionBinding,");
      expect(route).toContain("catch (error)");
      expect(route).toContain("functionDispatchError(error, setHeaders)");
      expect(route).toContain('status: 200');
      expect(route).toContain('"x-supacloud-background-envelope": "true"');
    }
  });

  test("only trusted background routes can resolve queued legacy-zero versions", () => {
    const preheatSource = source.slice(
      source.indexOf('.post("/preheat/:ref/:slug"'),
      source.indexOf('.post("/internal/background/:ref/:functionName/*"'),
    );
    const backgroundSource = source.slice(
      source.indexOf('.post("/internal/background/:ref/:functionName/*"'),
      source.indexOf('.post("/internal/background/cancel/:taskId"'),
    );

    expect(preheatSource).not.toContain("resolveTrustedBackgroundFunctionVersionBinding,");
    expect(backgroundSource.match(/resolveTrustedBackgroundFunctionVersionBinding,/g)).toHaveLength(2);
  });
});
