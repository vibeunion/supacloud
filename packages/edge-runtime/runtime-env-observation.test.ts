import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("./worker-executor.ts", import.meta.url), "utf8");

describe("runtime env observation ordering", () => {
  test("keeps host-only background injection out of the public observation", () => {
    const dispatcher = serverSource.slice(
      serverSource.indexOf("async function dispatchFunction("),
      serverSource.indexOf("async function appendFunctionRuntimeLog("),
    );

    expect(dispatcher).toContain("tenantEnvModuleProof(");
    expect(dispatcher).toContain("tenantEnvLoad.env");
    expect(dispatcher).toContain(
      "recordTenantEnvDispatch(projectRef, tenantEnvLoad, dispatchReservation)",
    );
    const poolDispatch = dispatcher.slice(dispatcher.indexOf("targetPool.dispatch({"));
    expect(poolDispatch.indexOf("projectRef,")).toBeGreaterThan(-1);
    expect(poolDispatch.indexOf("projectRef,")).toBeLessThan(poolDispatch.indexOf("request,"));
  });

  test("advances observation only after module load and cancellation checks", () => {
    const dispatchStart = workerSource.indexOf("const { functionId, functionPath");
    const dispatch = workerSource.slice(dispatchStart);
    const tlsPolicyIndex = dispatch.indexOf("restoreFetchTlsPolicy = installEdgeFetchTlsPolicy");
    const loadIndex = dispatch.indexOf("const moduleLoad = await loadModule");
    const cancellationIndex = dispatch.indexOf("if (requestAbortController.signal.aborted)");
    const observationIndex = dispatch.indexOf('postToParent({ type: "execution_started"');

    expect(tlsPolicyIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(tlsPolicyIndex);
    expect(loadIndex).toBeGreaterThan(-1);
    expect(cancellationIndex).toBeGreaterThan(loadIndex);
    expect(observationIndex).toBeGreaterThan(cancellationIndex);
  });

  test("does not advance a public observation during preheat", () => {
    const preheat = serverSource.slice(
      serverSource.indexOf('.post("/preheat/:ref/:slug"'),
      serverSource.indexOf('.post("/internal/background/:ref/:functionName/*"'),
    );

    expect(preheat).toContain("loadTenantRuntimeEnv(c.params.ref)");
    expect(preheat).not.toContain("recordTenantEnvDispatch");
    expect(preheat).not.toContain("reserveTenantEnvDispatch");
  });
});
