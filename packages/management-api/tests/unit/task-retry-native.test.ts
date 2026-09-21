// @supacloud-test-isolate
import { expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { InvalidTaskRecordError } from "../../src/utils/task-record";
import { withNativePostgres } from "../helpers/native-postgres";
import { parseTaskDetail, parseTaskList, parseTaskMutation } from "../../../web-console/src/lib/task-center";
import { createClient, FunctionsHttpError } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudTaskFetch, SupaCloudTaskSubmitError } from "../../../supacloud-js/src/index";
import { parseTaskListQuery } from "../../src/utils/task-list-query";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";
import type { EnqueueBackgroundFunctionTaskInput, BackgroundFunctionAuthContext } from "../../src/services/background-task.service";
import { encryptSecret, decryptSecret } from "../../src/utils/secret-crypto";
import { InvalidBackgroundInvocationError } from "../../src/utils/background-invocation";
import type { SQL } from "bun";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native task routes bind project authorization, verify receipts, and fence mutation retries",
  async () => withNativePostgres(async (database) => {
    const originalDb = await import("../../src/db");
    mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
    const repo = await import("../../src/repositories/task.repository");
    const { taskRoutes } = await import("../../src/routes/tasks");
    const { sdkProxyRoutes, sdkProxyInternals } = await import("../../src/routes/sdk-proxy");
    const { projectService } = await import("../../src/services/project.service");
    const { edgeFunctionService } = await import("../../src/services/edge-function.service");
    const { enqueueBackgroundFunctionTask, BackgroundTaskIdempotencyConflictError } =
      await import("../../src/services/background-task.service");
    // Driver and route fixture; production migration replay is a separate gate.
    await database.unsafe(`
      CREATE TABLE projects (ref text PRIMARY KEY, service_role_key text NOT NULL, status text NOT NULL);
      INSERT INTO projects VALUES
        ('a', 'synthetic.project-a.credential', 'active'),
        ('b', 'synthetic.project-b.credential', 'active');
      CREATE TABLE project_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_ref text NOT NULL,
        task_type text NOT NULL, status text DEFAULT 'pending', payload jsonb DEFAULT '{}',
        result jsonb, error text, retries integer DEFAULT 0, attempt integer DEFAULT 0,
        max_attempts integer DEFAULT 3, next_run_at timestamptz DEFAULT NOW(),
        lease_until timestamptz, started_at timestamptz, completed_at timestamptz,
        timeout_sec integer, idempotency_key text, trace_id text, cancel_requested_at timestamptz,
        cancellation_reason text, correlation_id text, business_task_id text, invoker_user_id uuid,
        auth_authority_ref text, metadata jsonb DEFAULT '{}', function_slug text, function_version text,
        created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW()
      );
      CREATE UNIQUE INDEX task_idempotency ON project_tasks(project_ref, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE TABLE project_task_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES project_tasks(id),
        project_ref text NOT NULL, attempt_no integer NOT NULL, status text NOT NULL,
        started_at timestamptz NOT NULL, completed_at timestamptz, duration_ms integer,
        error text, response_status integer, logs jsonb,
        created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW(),
        UNIQUE(task_id, attempt_no)
      );
      CREATE SEQUENCE retry_statements;
      CREATE FUNCTION observe_retry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'pending' THEN
          PERFORM nextval('retry_statements');
          CASE OLD.metadata->>'retry_fault'
            WHEN 'project' THEN NEW.project_ref := 'b';
            WHEN 'id' THEN NEW.id := gen_random_uuid();
            WHEN 'status' THEN NEW.status := 'succeeded';
            WHEN 'error' THEN NEW.error := 'unchanged';
            WHEN 'lease' THEN NEW.lease_until := NOW();
            WHEN 'schedule' THEN NEW.next_run_at := NULL;
            WHEN 'completed' THEN NEW.completed_at := NOW();
            WHEN 'cancel_requested' THEN NEW.cancel_requested_at := NOW();
            WHEN 'cancellation_reason' THEN NEW.cancellation_reason := 'unchanged';
            WHEN 'sql' THEN RAISE EXCEPTION 'synthetic retry transaction failure' USING ERRCODE = '40001';
            ELSE NULL;
          END CASE;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER retry_receipt BEFORE UPDATE ON project_tasks
        FOR EACH ROW EXECUTE FUNCTION observe_retry();
    `);
    const app = new Elysia().use(taskRoutes).use(sdkProxyRoutes);
    const requests: Array<{ path: string; method: string; status: number }> = [];
    let truncateResponsePath: string | undefined;
    let responseGate: {
      path: string; wait: Promise<void>; ready: () => void; released: () => void;
    } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const response = await app.fetch(request);
        const path = new URL(request.url).pathname;
        const gate = responseGate?.path === path ? responseGate : undefined;
        if (gate) {
          gate.ready();
          await gate.wait;
        }
        requests.push({ path, method: request.method, status: response.status });
        gate?.released();
        if (truncateResponsePath === path) {
          truncateResponsePath = undefined;
          const body = await response.text();
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          // The real route has committed; only the HTTP receipt is damaged.
          return new Response(body.slice(0, -1), { status: response.status, headers });
        }
        return response;
      },
    });
    const originalOwnerRef = config.authRuntimeOwnerRef;
    config.authRuntimeOwnerRef = "";
    const retry = (projectRef: string, id: string, credential = "synthetic.project-a.credential") =>
      fetch(new URL(`/v1/projects/${projectRef}/tasks/${id}/retry`, server.url), {
        method: "POST", headers: { authorization: `Bearer ${credential}` },
      });
    const sdk = createSupaCloudClient({
      supabase: createClient(server.url.origin, "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      managementApiUrl: server.url.origin, projectRef: "a",
      getAccessToken: () => "synthetic.project-a.credential",
    });
    try {
      const publishableKey = "sb_publishable_native_enqueue_fixture";
      const secretKey = "sb_secret_native_enqueue_fixture";
      let functionVersion = "7";
      let timeoutSec: number = DEFAULT_BACKGROUND_TASK_SETTINGS.timeout_sec_default;
      let maxAttempts: number = DEFAULT_BACKGROUND_TASK_SETTINGS.max_attempts;
      const routingSpies = [
        spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockImplementation(async key =>
          key === publishableKey || key === secretKey ? "a" : null),
        spyOn(projectService, "getBackgroundTaskSettings").mockImplementation(async () => ({
          ...DEFAULT_BACKGROUND_TASK_SETTINGS, timeout_sec_default: timeoutSec, max_attempts: maxAttempts,
        })),
        spyOn(projectService, "getApiKeys").mockResolvedValue({
          anon_key: "synthetic-anon", service_role_key: "synthetic.project-a.credential",
          publishable_key: publishableKey, secret_key: secretKey,
        }),
        spyOn(edgeFunctionService, "getConfig").mockImplementation(async () => ({
          verify_jwt: false, version: functionVersion,
          activation_id: "11111111-1111-4111-8111-111111111111",
          background_routes: ["/generate", "/other"],
        })),
      ];
      try {
        const functionPath = "/functions/v1/native-worker/generate";
        const submitSdk = createSupaCloudClient({
          supabase: createClient(server.url.origin, publishableKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: createSupaCloudTaskFetch({
              functionUrls: [new URL(functionPath, server.url).href],
            }) },
          }),
          managementApiUrl: server.url.origin, projectRef: "a",
          getAccessToken: () => "synthetic.project-a.credential",
        });
        const beforeEnqueue = requests.length;
        const receipt = await submitSdk.tasks.submit("native-worker/generate", {
          body: { work: "native-enqueue" }, idempotencyKey: "native-enqueue-once",
        });
        expect(receipt.status).toBe("pending");
        expect(requests.slice(beforeEnqueue)).toEqual([{ path: functionPath, method: "POST", status: 202 }]);
        const stored = await repo.getTaskById(receipt.taskId, "a");
        expect(stored).toMatchObject({
          id: receipt.taskId, project_ref: "a", status: "pending", function_slug: "native-worker",
          function_version: "7", idempotency_key: "native-enqueue-once",
          payload: { method: "POST", path: "/generate", body: '{"work":"native-enqueue"}', body_encoding: "utf8" },
        });
        expect(await receipt.get()).toMatchObject({ id: receipt.taskId, project_ref: "a", status: "pending" });
        const replay = await submitSdk.tasks.submit("native-worker/generate", {
          body: { work: "native-enqueue" }, idempotencyKey: "native-enqueue-once",
        });
        expect(replay.taskId).toBe(receipt.taskId);
        expect(replay.status).toBe("pending");
        expect(Array.from(await database`
          SELECT count(*)::integer AS count FROM project_tasks
          WHERE project_ref = 'a' AND idempotency_key = 'native-enqueue-once'
        `)).toEqual([{ count: 1 }]);
        expect(requests.slice(beforeEnqueue).filter(request => request.method === "POST")).toEqual([
          { path: functionPath, method: "POST", status: 202 },
          { path: functionPath, method: "POST", status: 202 },
        ]);
        const beforeConflicts = Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${receipt.taskId}::uuid
        `);
        const conflictCases = [
          { path: functionPath, method: "POST", body: '{"work":"changed"}' },
          { path: "/functions/v1/other-worker/generate", method: "POST", body: '{"work":"native-enqueue"}' },
          { path: "/functions/v1/native-worker/other", method: "POST", body: '{"work":"native-enqueue"}' },
          { path: `${functionPath}?changed=1`, method: "POST", body: '{"work":"native-enqueue"}' },
          { path: functionPath, method: "PUT", body: '{"work":"native-enqueue"}' },
        ];
        for (const conflict of conflictCases) {
          const beforeConflictRequest = requests.length;
          const response = await fetch(new URL(conflict.path, server.url), {
            method: conflict.method, body: conflict.body,
            headers: {
              apikey: publishableKey, "content-type": "application/json",
              "x-supacloud-idempotency-key": "native-enqueue-once",
            },
          });
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            code: "TASK_IDEMPOTENCY_CONFLICT",
            message: "Idempotency key is already bound to a different background invocation",
          });
          expect(requests.slice(beforeConflictRequest)).toEqual([{
            path: new URL(conflict.path, server.url).pathname, method: conflict.method, status: 409,
          }]);
          expect(Array.from(await database`
            SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${receipt.taskId}::uuid
          `)).toEqual(beforeConflicts);
        }
        const beforeSdkConflict = requests.length;
        const sdkConflict: unknown = await submitSdk.tasks.submit("native-worker/generate", {
          body: { work: "changed" }, idempotencyKey: "native-enqueue-once",
        }).catch((error: unknown) => error);
        expect(sdkConflict).toMatchObject({ name: "FunctionsHttpError" });
        expect(sdkConflict).not.toBeInstanceOf(SupaCloudTaskSubmitError);
        const conflictResponse: unknown = typeof sdkConflict === "object" && sdkConflict !== null
          ? Object.getOwnPropertyDescriptor(sdkConflict, "context")?.value : undefined;
        expect(conflictResponse).toBeInstanceOf(Response);
        if (!(conflictResponse instanceof Response)) throw new Error("Expected conflict HTTP response");
        expect(conflictResponse.status).toBe(409);
        expect(await conflictResponse.json()).toMatchObject({ code: "TASK_IDEMPOTENCY_CONFLICT" });
        expect(requests.slice(beforeSdkConflict)).toEqual([
          { path: functionPath, method: "POST", status: 409 },
        ]);
        expect(Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${receipt.taskId}::uuid
        `)).toEqual(beforeConflicts);
        const changedPrivilege = await fetch(new URL(functionPath, server.url), {
          method: "POST", body: '{"work":"native-enqueue"}',
          headers: {
            apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json",
            "x-supacloud-idempotency-key": "native-enqueue-once",
          },
        });
        expect(changedPrivilege.status).toBe(409);
        expect(await changedPrivilege.json()).toEqual({
          code: "TASK_IDEMPOTENCY_CONFLICT",
          message: "Idempotency key is already bound to a different background invocation",
        });
        expect(Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${receipt.taskId}::uuid
        `)).toEqual(beforeConflicts);
        try {
          for (const changed of [
            { version: "8", timeout: 300, attempts: 3 },
            { version: "7", timeout: 301, attempts: 3 },
            { version: "7", timeout: 300, attempts: 4 },
          ]) {
            functionVersion = changed.version;
            timeoutSec = changed.timeout;
            maxAttempts = changed.attempts;
            const beforeConfigurationConflict = requests.length;
            const conflict: unknown = await submitSdk.tasks.submit("native-worker/generate", {
              body: { work: "native-enqueue" }, idempotencyKey: "native-enqueue-once",
            }).catch((error: unknown) => error);
            expect(conflict).toMatchObject({ name: "FunctionsHttpError" });
            expect(requests.slice(beforeConfigurationConflict)).toEqual([
              { path: functionPath, method: "POST", status: 409 },
            ]);
            expect(Array.from(await database`
              SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${receipt.taskId}::uuid
            `)).toEqual(beforeConflicts);
            const fresh = await submitSdk.tasks.submit("native-worker/generate", {
              body: { work: "native-enqueue" },
              idempotencyKey: `native-config-${changed.version}-${changed.timeout}-${changed.attempts}`,
            });
            expect(fresh.taskId).not.toBe(receipt.taskId);
            expect(await repo.getTaskById(fresh.taskId, "a")).toMatchObject({
              function_version: changed.version, timeout_sec: changed.timeout,
              max_attempts: changed.attempts, payload: { requested_timeout_sec: changed.timeout },
            });
          }
        } finally {
          functionVersion = "7";
          timeoutSec = DEFAULT_BACKGROUND_TASK_SETTINGS.timeout_sec_default;
          maxAttempts = DEFAULT_BACKGROUND_TASK_SETTINGS.max_attempts;
        }
        const adversarialClient = createClient(server.url.origin, publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const functions = adversarialClient.functions;
        const functionsProperty = Object.getOwnPropertyDescriptor(adversarialClient, "functions");
        Object.defineProperty(adversarialClient, "functions", { configurable: true, value: functions });
        const adversarialSdk = createSupaCloudClient({
          supabase: adversarialClient, managementApiUrl: server.url.origin, projectRef: "a",
        });
        const invoke = spyOn(functions, "invoke");
        try {
          for (const mode of ["untrusted", "context", "getter", "relay", "server-error"] as const) {
            const raw = Response.json({ code: "synthetic-error" }, {
              status: mode === "server-error" ? 500 : 409,
              headers: mode === "relay" ? { "x-relay-error": "true" } : {},
            });
            const guarded = createSupaCloudTaskFetch({
              functionUrls: [new URL(functionPath, server.url).href],
              fetch: async () => raw,
            });
            const response = mode === "untrusted" ? raw
              : await guarded(new URL(functionPath, server.url));
            const error = new Error("synthetic transport failure");
            error.name = "FunctionsHttpError";
            let getterReads = 0;
            if (mode === "getter") {
              Object.defineProperty(error, "context", {
                get: () => { getterReads++; return response; },
              });
            } else {
              Object.defineProperty(error, "context", {
                value: mode === "context" ? response.clone() : response,
              });
            }
            invoke.mockResolvedValueOnce({ data: null, error, response });
            const result: unknown = await adversarialSdk.tasks.submit("native-worker/generate")
              .catch((failure: unknown) => failure);
            expect(result).toBeInstanceOf(SupaCloudTaskSubmitError);
            expect(getterReads).toBe(0);
          }
          // A genuine foreign-package error can use its bounded response only once.
          const guarded = createSupaCloudTaskFetch({
            functionUrls: [new URL(functionPath, server.url).href],
            fetch: async () => Response.json({ code: "synthetic-conflict" }, { status: 409 }),
          });
          const response = await guarded(new URL(functionPath, server.url));
          const error = new FunctionsHttpError(response);
          invoke.mockResolvedValueOnce({ data: null, error, response });
          const accepted: unknown = await adversarialSdk.tasks.submit("native-worker/generate")
            .catch((failure: unknown) => failure);
          expect(accepted).toMatchObject({ name: "FunctionsHttpError" });
          expect(accepted).not.toBeInstanceOf(SupaCloudTaskSubmitError);
          // A structural lookalike cannot reuse consumed transport provenance.
          const reused = new Error("synthetic reused response");
          reused.name = "FunctionsHttpError";
          Object.defineProperty(reused, "context", { value: response });
          invoke.mockResolvedValueOnce({ data: null, error: reused, response });
          const rejected: unknown = await adversarialSdk.tasks.submit("native-worker/generate")
            .catch((failure: unknown) => failure);
          expect(rejected).toBeInstanceOf(SupaCloudTaskSubmitError);
          expect(invoke).toHaveBeenCalledTimes(7);
        } finally {
          invoke.mockRestore();
          if (functionsProperty) Object.defineProperty(adversarialClient, "functions", functionsProperty);
          else Reflect.deleteProperty(adversarialClient, "functions");
        }
        const concurrentBodies = ['{"work":"concurrent-a"}', '{"work":"concurrent-b"}'];
        const concurrent = await Promise.all(concurrentBodies.map(async body => {
          const response = await fetch(new URL(functionPath, server.url), {
            method: "POST", body,
            headers: {
              apikey: publishableKey, "content-type": "application/json",
              "x-supacloud-idempotency-key": "native-concurrent-conflict",
            },
          });
          const receipt: unknown = await response.json();
          return { status: response.status, body, receipt };
        }));
        expect(concurrent.map(result => result.status).sort()).toEqual([202, 409]);
        const winner = concurrent.find(result => result.status === 202);
        const loser = concurrent.find(result => result.status === 409);
        if (!winner || !loser) throw new Error("Expected one committed invocation and one conflict");
        expect(loser.receipt).toMatchObject({ code: "TASK_IDEMPOTENCY_CONFLICT" });
        const concurrentRows = Array.from(await database`
          SELECT id::text, payload->>'body' AS body FROM project_tasks
          WHERE project_ref = 'a' AND idempotency_key = 'native-concurrent-conflict'
        `);
        expect(concurrentRows).toHaveLength(1);
        expect(concurrentRows[0]).toMatchObject({ body: winner.body });
        expect(winner.receipt).toMatchObject({
          task_id: concurrentRows[0]?.id, project_ref: "a", status: "pending",
        });
        const beforeLostReceipt = requests.length;
        truncateResponsePath = functionPath;
        let lostReceiptError: unknown;
        try {
          await submitSdk.tasks.submit("native-worker/generate", {
            body: { work: "native-lost-receipt" }, idempotencyKey: "native-lost-receipt-once",
          });
        } catch (error) {
          lostReceiptError = error;
        } finally {
          truncateResponsePath = undefined;
        }
        expect(lostReceiptError).toBeInstanceOf(SupaCloudTaskSubmitError);
        expect(lostReceiptError).toMatchObject({
          code: "TASK_SUBMIT_UNCONFIRMED", mutationMayHaveApplied: true,
        });
        expect(requests.slice(beforeLostReceipt)).toEqual([
          { path: functionPath, method: "POST", status: 202 },
        ]);
        const committedRows = Array.from(await database`
          SELECT id::text, project_ref, status, payload FROM project_tasks
          WHERE project_ref = 'a' AND idempotency_key = 'native-lost-receipt-once'
        `);
        expect(committedRows).toHaveLength(1);
        const committed: unknown = committedRows[0];
        expect(committed).toMatchObject({
          project_ref: "a", status: "pending",
          payload: { body: '{"work":"native-lost-receipt"}', path: "/generate" },
        });
        const recovered = await submitSdk.tasks.submit("native-worker/generate", {
          body: { work: "native-lost-receipt" }, idempotencyKey: "native-lost-receipt-once",
        });
        expect(committed).toMatchObject({ id: recovered.taskId });
        expect(await recovered.get()).toMatchObject({
          id: recovered.taskId, project_ref: "a", status: "pending",
        });
        expect(Array.from(await database`
          SELECT id::text, project_ref, status, payload FROM project_tasks
          WHERE project_ref = 'a' AND idempotency_key = 'native-lost-receipt-once'
        `)).toEqual(committedRows);
        expect(requests.slice(beforeLostReceipt).filter(request => request.method === "POST")).toEqual([
          { path: functionPath, method: "POST", status: 202 },
          { path: functionPath, method: "POST", status: 202 },
        ]);
        const businessHeaders = { "x-business-mode": "first", "content-type": "application/json" };
        const headerReceipt = await submitSdk.tasks.submit("native-worker/generate", {
          body: { work: "headers" }, idempotencyKey: "native-headers-once",
          headers: {
            ...businessHeaders, "x-request-id": "request-one",
            traceparent: "00-11111111111111111111111111111111-1111111111111111-01",
          },
        });
        const headerPayload = Array.from(await database`
          SELECT payload, trace_id FROM project_tasks WHERE id = ${headerReceipt.taskId}::uuid
        `);
        const headerReplay = await submitSdk.tasks.submit("native-worker/generate", {
          body: { work: "headers" }, idempotencyKey: "native-headers-once",
          headers: {
            ...businessHeaders, "x-request-id": "request-two",
            traceparent: "00-22222222222222222222222222222222-2222222222222222-01",
          },
        });
        expect(headerReplay.taskId).toBe(headerReceipt.taskId);
        expect(Array.from(await database`
          SELECT payload, trace_id FROM project_tasks WHERE id = ${headerReceipt.taskId}::uuid
        `)).toEqual(headerPayload);
        const headerRow = Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${headerReceipt.taskId}::uuid
        `);
        const changedHeaders: Array<Record<string, string>> = [
          { ...businessHeaders, "x-business-mode": "second" },
          { "content-type": "application/json" },
          { ...businessHeaders, "x-new-business-option": "changed" },
          { ...businessHeaders, "content-type": "text/plain" },
        ];
        for (const headers of changedHeaders) {
          const beforeHeaderConflict = requests.length;
          const conflict: unknown = await submitSdk.tasks.submit("native-worker/generate", {
            body: { work: "headers" }, idempotencyKey: "native-headers-once", headers,
          }).catch((error: unknown) => error);
          expect(conflict).toMatchObject({ name: "FunctionsHttpError" });
          expect(requests.slice(beforeHeaderConflict)).toEqual([
            { path: functionPath, method: "POST", status: 409 },
          ]);
          expect(Array.from(await database`
            SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${headerReceipt.taskId}::uuid
          `)).toEqual(headerRow);
        }
      } finally {
        for (const spy of routingSpies.reverse()) spy.mockRestore();
      }
      const identityInput: EnqueueBackgroundFunctionTaskInput = {
        projectRef: "a", functionSlug: "identity-worker", functionVersion: "1",
        timeoutSec: 300, maxAttempts: 3, traceId: "native-identity",
        idempotencyKey: "native-identity-once",
        envelope: {
          method: "POST", path: "/generate", query: "", headers: {},
          body: '{"work":"identity"}', body_encoding: "utf8", requested_timeout_sec: 300,
          auth: {
            kind: "jwt", invoker_user_id: "11111111-1111-4111-8111-111111111111",
            invoker_role: "authenticated", apikey_kind: "anon",
          },
        },
      };
      const invalidNumericInputs: Array<Record<string, unknown>> = [
        ...[NaN, Infinity, -Infinity, 0, -1, "300", null, undefined].map(timeoutSec => ({ timeoutSec })),
        ...[NaN, Infinity, -Infinity, 0, -1, "3", null, undefined].map(maxAttempts => ({ maxAttempts })),
        ...[NaN, Infinity, -Infinity, 0, -1, 1.5, 1024 * 1024 + 1, "1024", null]
          .map(maxPayloadBytes => ({ maxPayloadBytes })),
      ];
      const beforeInvalidNumbers = spyOn(database, "begin");
      try {
        for (const [index, invalid] of invalidNumericInputs.entries()) {
          // Exercise untyped callers without asserting invalid values into the public input type.
          await expect(Reflect.apply(enqueueBackgroundFunctionTask, undefined, [{
            ...identityInput, ...invalid, idempotencyKey: `native-invalid-number-${index}`,
          }])).rejects.toBeInstanceOf(InvalidBackgroundInvocationError);
        }
        const missingMethod = { ...identityInput.envelope };
        Reflect.deleteProperty(missingMethod, "method");
        const inherited: unknown = Object.assign(Object.create({ inherited: true }), identityInput);
        const cyclic: Record<string, unknown> = { ...identityInput };
        cyclic.envelope = cyclic;
        const invalidObjects: unknown[] = [
          null, 42, [], new Date(), inherited, cyclic,
          { ...identityInput, projectRef: null },
          { ...identityInput, functionSlug: 42 },
          { ...identityInput, traceId: "" },
          { ...identityInput, functionVersion: 2 },
          { ...identityInput, idempotencyKey: [] },
          { ...identityInput, extraOption: true },
          { ...identityInput, envelope: missingMethod },
          { ...identityInput, envelope: { ...identityInput.envelope, auth: {} } },
        ];
        let getterReads = 0;
        const forbiddenGetter = () => { getterReads++; throw new Error("Getter must not execute"); };
        const topLevelGetter = { ...identityInput };
        Object.defineProperty(topLevelGetter, "timeoutSec", { enumerable: true, get: forbiddenGetter });
        const bodyGetter = { ...identityInput.envelope };
        Object.defineProperty(bodyGetter, "body", { enumerable: true, get: forbiddenGetter });
        const authGetter = { ...identityInput.envelope.auth };
        Object.defineProperty(authGetter, "invoker_role", { enumerable: true, get: forbiddenGetter });
        const headerGetter = {};
        Object.defineProperty(headerGetter, "x-business-mode", { enumerable: true, get: forbiddenGetter });
        invalidObjects.push(
          topLevelGetter,
          { ...identityInput, envelope: bodyGetter },
          { ...identityInput, envelope: { ...identityInput.envelope, auth: authGetter } },
          { ...identityInput, envelope: { ...identityInput.envelope, headers: headerGetter } },
        );
        for (const invalid of invalidObjects) {
          await expect(Reflect.apply(enqueueBackgroundFunctionTask, undefined, [invalid]))
            .rejects.toBeInstanceOf(InvalidBackgroundInvocationError);
        }
        expect(getterReads).toBe(0);
        await expect(enqueueBackgroundFunctionTask({
          ...identityInput, maxPayloadBytes: 1,
        })).rejects.toThrow("Async payload too large");
        expect(beforeInvalidNumbers).not.toHaveBeenCalled();
        expect(Array.from(await database`
          SELECT count(*)::integer AS count FROM project_tasks
          WHERE idempotency_key LIKE 'native-invalid-number-%'
        `)).toEqual([{ count: 0 }]);
      } finally {
        beforeInvalidNumbers.mockRestore();
      }
      const identityTask = await enqueueBackgroundFunctionTask(identityInput);
      expect(identityTask).toMatchObject({
        project_ref: "a", invoker_user_id: identityInput.envelope.auth.invoker_user_id,
        auth_authority_ref: "a",
      });
      expect((await enqueueBackgroundFunctionTask(identityInput)).id).toBe(identityTask.id);
      const nullPrototypeInput: unknown = Object.assign(Object.create(null), identityInput);
      const nullPrototypeReplay: unknown = await Reflect.apply(enqueueBackgroundFunctionTask, undefined, [nullPrototypeInput]);
      expect(nullPrototypeReplay).toMatchObject({ id: identityTask.id, project_ref: "a" });
      expect((await enqueueBackgroundFunctionTask({
        ...identityInput, maxPayloadBytes: 1024 * 1024,
      })).id).toBe(identityTask.id);
      expect((await enqueueBackgroundFunctionTask({
        ...identityInput, timeoutSec: 300.9, maxAttempts: 3.9,
      })).id).toBe(identityTask.id);
      const headerCaseInput: EnqueueBackgroundFunctionTaskInput = {
        ...identityInput, idempotencyKey: "native-header-case",
        envelope: { ...identityInput.envelope, headers: { "X-Business-Mode": "first", Accept: " application/json " } },
      };
      const headerCaseTask = await enqueueBackgroundFunctionTask(headerCaseInput);
      expect(headerCaseTask.payload.headers).toEqual({
        "x-business-mode": "first", accept: "application/json",
      });
      expect((await enqueueBackgroundFunctionTask({
        ...headerCaseInput,
        envelope: { ...headerCaseInput.envelope, headers: { "x-business-mode": "first", accept: "application/json" } },
      })).id).toBe(headerCaseTask.id);
      const credentialInput: EnqueueBackgroundFunctionTaskInput = {
        ...identityInput, idempotencyKey: "native-credentials-once",
        envelope: {
          ...identityInput.envelope,
          auth: {
            ...identityInput.envelope.auth,
            authorization: "Bearer synthetic-credential-one", apikey: "synthetic-api-key-one",
          },
        },
      };
      const credentialTask = await enqueueBackgroundFunctionTask(credentialInput);
      const persistedAuth: unknown = credentialTask.payload.auth;
      expect(persistedAuth).not.toMatchObject({ authorization: credentialInput.envelope.auth.authorization });
      const newAuthorization = encryptSecret("Bearer synthetic-credential-one");
      const newApiKey = encryptSecret("synthetic-api-key-one");
      expect(persistedAuth).not.toMatchObject({ authorization: newAuthorization });
      expect(decryptSecret(newAuthorization)).toBe("Bearer synthetic-credential-one");
      expect((await enqueueBackgroundFunctionTask({
        ...credentialInput,
        envelope: {
          ...credentialInput.envelope,
          auth: { ...credentialInput.envelope.auth, authorization: newAuthorization, apikey: newApiKey },
        },
      })).id).toBe(credentialTask.id);
      expect((await repo.getTaskById(credentialTask.id, "a"))?.payload.auth).toEqual(persistedAuth);
      const credentialRow = Array.from(await database`
        SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${credentialTask.id}::uuid
      `);
      for (const changed of [
        { authorization: "Bearer synthetic-credential-two" },
        { authorization: null },
        { apikey: "synthetic-api-key-two" },
        { apikey: null },
      ]) {
        const failure: unknown = await enqueueBackgroundFunctionTask({
          ...credentialInput,
          envelope: { ...credentialInput.envelope, auth: { ...credentialInput.envelope.auth, ...changed } },
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(BackgroundTaskIdempotencyConflictError);
        expect(failure).toMatchObject({
          message: "Idempotency key is already bound to a different background invocation",
        });
        expect(Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${credentialTask.id}::uuid
        `)).toEqual(credentialRow);
      }
      await expect(enqueueBackgroundFunctionTask({
        ...credentialInput,
        envelope: {
          ...credentialInput.envelope,
          auth: { ...credentialInput.envelope.auth, authorization: "enc:v1:broken" },
        },
      })).rejects.toBeInstanceOf(InvalidBackgroundInvocationError);
      expect(Array.from(await database`
        SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${credentialTask.id}::uuid
      `)).toEqual(credentialRow);
      const identityRow = Array.from(await database`
        SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${identityTask.id}::uuid
      `);
      for (const configurationChange of [
        { functionVersion: null },
        { functionVersion: "2" },
        { timeoutSec: 301 },
        { maxAttempts: 4 },
        { envelope: { ...identityInput.envelope, requested_timeout_sec: 301 } },
      ]) {
        await expect(enqueueBackgroundFunctionTask({ ...identityInput, ...configurationChange }))
          .rejects.toBeInstanceOf(BackgroundTaskIdempotencyConflictError);
        expect(Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${identityTask.id}::uuid
        `)).toEqual(identityRow);
      }
      const identityChanges: Array<Partial<BackgroundFunctionAuthContext>> = [
        { invoker_user_id: "22222222-2222-4222-8222-222222222222" },
        { invoker_user_id: null },
        { invoker_role: "service_role" },
        { invoker_role: null },
        { kind: "apikey" },
        { apikey_kind: "service_role" },
        { apikey_kind: null },
      ];
      for (const authChange of identityChanges) {
        await expect(enqueueBackgroundFunctionTask({
          ...identityInput,
          envelope: { ...identityInput.envelope, auth: { ...identityInput.envelope.auth, ...authChange } },
        })).rejects.toBeInstanceOf(BackgroundTaskIdempotencyConflictError);
        expect(Array.from(await database`
          SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${identityTask.id}::uuid
        `)).toEqual(identityRow);
      }
      try {
        config.authRuntimeOwnerRef = "b";
        await expect(enqueueBackgroundFunctionTask(identityInput))
          .rejects.toBeInstanceOf(BackgroundTaskIdempotencyConflictError);
      } finally {
        config.authRuntimeOwnerRef = "";
      }
      expect(Array.from(await database`
        SELECT md5(row_to_json(t)::text) AS hash FROM project_tasks t WHERE id = ${identityTask.id}::uuid
      `)).toEqual(identityRow);
      await database.unsafe(`
        CREATE SEQUENCE enqueue_fault_attempts;
        CREATE FUNCTION corrupt_enqueue_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE fault text;
        BEGIN
          fault := COALESCE(NEW.metadata->>'enqueue_fault',
            substring(NEW.trace_id from '^native-enqueue-fault-(.*)$'));
          IF fault IS NULL THEN RETURN NEW; END IF;
          PERFORM nextval('enqueue_fault_attempts');
          CASE fault
            WHEN 'schema' THEN NEW.retries := -1;
            WHEN 'project' THEN NEW.project_ref := 'b';
            WHEN 'type' THEN NEW.task_type := 'queue:other';
            WHEN 'slug' THEN NEW.function_slug := 'wrong-function';
            WHEN 'version' THEN NEW.function_version := '99';
            WHEN 'timeout' THEN NEW.timeout_sec := 901;
            WHEN 'attempts' THEN NEW.max_attempts := 99;
            WHEN 'key' THEN NEW.idempotency_key := 'corrupted-key';
            WHEN 'invoker' THEN NEW.invoker_user_id := '22222222-2222-4222-8222-222222222222';
            WHEN 'authority' THEN NEW.auth_authority_ref := 'b';
            WHEN 'body' THEN NEW.payload := jsonb_set(NEW.payload, '{body}', '"wrong-body"');
            WHEN 'auth' THEN NEW.payload := jsonb_set(NEW.payload, '{auth,invoker_role}', '"service_role"');
            WHEN 'headers' THEN NEW.payload := jsonb_set(NEW.payload, '{headers,x-business-mode}', '"changed"');
            WHEN 'invalid_payload' THEN NEW.payload := jsonb_set(NEW.payload, '{method}', '123');
            WHEN 'invalid_credential' THEN NEW.payload := jsonb_set(NEW.payload, '{auth,authorization}', '"enc:v1:broken"');
            ELSE RAISE EXCEPTION 'Unknown enqueue fixture fault';
          END CASE;
          RETURN NEW;
        END $$;
        CREATE TRIGGER enqueue_receipt_fault BEFORE INSERT OR UPDATE OF updated_at ON project_tasks
          FOR EACH ROW EXECUTE FUNCTION corrupt_enqueue_receipt();
      `);
      let faultAttempts = 0;
      const allTaskRows = () => database`
        SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) AS hash
        FROM project_tasks t
      `;
      try {
        for (const fault of [
          "schema", "project", "type", "slug", "version", "timeout", "attempts",
          "key", "invoker", "authority", "body", "auth", "headers", "invalid_payload", "invalid_credential",
        ]) {
          const beforeInsert = Array.from(await allTaskRows());
          await expect(enqueueBackgroundFunctionTask({
            ...identityInput, idempotencyKey: `native-insert-fault-${fault}`,
            traceId: `native-enqueue-fault-${fault}`,
          })).rejects.toBeInstanceOf(InvalidTaskRecordError);
          expect(Array.from(await allTaskRows())).toEqual(beforeInsert);
          expect(Array.from(await database`
            SELECT last_value::integer AS count FROM enqueue_fault_attempts
          `)).toEqual([{ count: ++faultAttempts }]);

          const replayInput = { ...identityInput, idempotencyKey: `native-replay-fault-${fault}` };
          const replayTask = await enqueueBackgroundFunctionTask(replayInput);
          await database`
            UPDATE project_tasks SET metadata = ${ { enqueue_fault: fault } }
            WHERE id = ${replayTask.id}::uuid
          `;
          const beforeReplay = Array.from(await allTaskRows());
          await expect(enqueueBackgroundFunctionTask(replayInput)).rejects.toBeInstanceOf(InvalidTaskRecordError);
          expect(Array.from(await allTaskRows())).toEqual(beforeReplay);
          expect(Array.from(await database`
            SELECT last_value::integer AS count FROM enqueue_fault_attempts
          `)).toEqual([{ count: ++faultAttempts }]);
        }
      } finally {
        await database.unsafe("DROP TRIGGER enqueue_receipt_fault ON project_tasks");
      }
      for (const [index, key] of [null, "", "native-commit-ack-once"].entries()) {
        const nativeBegin = database.begin.bind(database);
        const lostAcknowledgment = new Error("Synthetic acknowledgment loss after native commit");
        let loseNextAcknowledgment = true;
        async function beginWithLostAcknowledgment<T>(
          optionsOrCallback: string | SQL.TransactionContextCallback<T>,
          callback?: SQL.TransactionContextCallback<T>,
        ): Promise<SQL.ContextCallbackResult<T>> {
          if (typeof optionsOrCallback === "string" && callback === undefined) {
            throw new Error("Expected transaction callback");
          }
          const result = typeof optionsOrCallback === "string" && callback !== undefined
            ? await nativeBegin(optionsOrCallback, callback)
            : typeof optionsOrCallback === "function"
              ? await nativeBegin(optionsOrCallback)
              : undefined;
          if (result === undefined) throw new Error("Expected enqueue transaction result");
          if (loseNextAcknowledgment) {
            loseNextAcknowledgment = false;
            throw lostAcknowledgment;
          }
          return result;
        }
        const begin = spyOn(database, "begin").mockImplementation(beginWithLostAcknowledgment);
        const traceId = `native-commit-ack-${index}`;
        let outcome: unknown;
        try {
          try {
            outcome = await enqueueBackgroundFunctionTask({
              ...identityInput, idempotencyKey: key, traceId,
            });
          } catch (error) {
            outcome = error;
          }
          expect(begin).toHaveBeenCalledTimes(key ? 2 : 1);
          const committed = Array.from(await database`
            SELECT id::text, idempotency_key FROM project_tasks WHERE trace_id = ${traceId}
          `);
          expect(committed).toHaveLength(1);
          expect(committed[0]).toMatchObject({ idempotency_key: key || null });
          if (key) {
            expect(outcome).toMatchObject({ id: committed[0]?.id, project_ref: "a", status: "pending" });
          } else {
            expect(outcome).toBe(lostAcknowledgment);
          }
        } finally {
          begin.mockRestore();
        }
      }
      const foreign = await repo.createTask({ ref: "b", type: "queue:work", status: "failed" });
      const forbidden = await retry("a", foreign.id);
      expect(forbidden.status).toBe(404);
      await forbidden.text();
      expect((await repo.getTaskById(foreign.id, "b"))?.status).toBe("failed");

      const unauthorized = await retry("b", foreign.id);
      expect([401, 403]).toContain(unauthorized.status);
      await unauthorized.text();
      expect((await repo.getTaskById(foreign.id, "b"))?.status).toBe("failed");

      for (const status of ["failed", "dead_lettered", "cancelled"] as const) {
        const task = await repo.createTask({ ref: "a", type: "queue:work", status });
        const response = await retry("a", task.id);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ id: task.id, project_ref: "a", status: "pending", error: null });
        expect(parseTaskMutation(body, "a", task.id, "retry").status).toBe("pending");
        expect((await repo.getTaskById(task.id, "a"))?.status).toBe("pending");
      }
      for (const status of ["pending", "leased", "running", "retry_scheduled", "succeeded"] as const) {
        const task = await repo.createTask({ ref: "a", type: "queue:work", status });
        const response = await retry("a", task.id);
        expect(response.status).toBe(404);
        await response.text();
        expect((await repo.getTaskById(task.id, "a"))?.status).toBe(status);
      }
      for (const form of ["uppercase", "compact", "braced", "four-digit-groups"]) {
        const task = await repo.createTask({ ref: "a", type: "queue:work", status: "failed" });
        const compact = task.id.replaceAll("-", "");
        const input = form === "uppercase" ? task.id.toUpperCase()
          : form === "compact" ? compact : form === "braced" ? `{${task.id}}`
          : compact.match(/.{4}/g)?.join("-");
        if (!input) throw new Error("Expected UUID input form");
        const response = await retry("a", encodeURIComponent(input));
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ id: task.id, project_ref: "a", status: "pending" });
        expect(body).not.toHaveProperty("retry_identity_matches");
        expect((await repo.getTaskById(task.id, "a"))?.status).toBe("pending");
      }
      const concurrent = await repo.createTask({ ref: "a", type: "queue:work", status: "failed" });
      const responses = await Promise.all([retry("a", concurrent.id), retry("a", concurrent.id)]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 404]);
      await Promise.all(responses.map(response => response.text()));

      const attempt = await repo.startTaskAttempt(concurrent);
      await repo.completeTaskAttempt(concurrent.id, attempt.attempt_no, {
        status: "failed", responseStatus: 503, durationMs: 1,
        logs: [{ timestamp: "2026-09-09T09:02:03+08:00", stream: "stderr", level: "error", message: "synthetic task failure" }],
      });
      const headers = { authorization: "Bearer synthetic.project-a.credential" };
      const listResponse = await fetch(new URL("/v1/projects/a/tasks?summary=true", server.url), { headers });
      expect(listResponse.status).toBe(200);
      const listValue: unknown = await listResponse.json();
      const list = parseTaskList(listValue, "a");
      expect(list.some(task => task.id === concurrent.id)).toBe(true);
      expect(list.some(task => task.id === foreign.id)).toBe(false);
      const detailResponse = await fetch(new URL(`/v1/projects/a/tasks/${concurrent.id}`, server.url), { headers });
      expect(detailResponse.status).toBe(200);
      const detailValue: unknown = await detailResponse.json();
      const detail = parseTaskDetail(detailValue, "a", concurrent.id);
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]?.response_status).toBe(503);
      expect(detail.latest_logs[0]?.message).toBe("synthetic task failure");
      const sdkDetail = await sdk.tasks.get(concurrent.id.toUpperCase());
      expect(sdkDetail).toMatchObject({
        id: concurrent.id, project_ref: "a", attempts: [{ attempt_no: attempt.attempt_no, response_status: 503 }],
        latest_logs: [{ stream: "stderr", message: "synthetic task failure" }],
      });
      const sdkList = await sdk.tasks.list();
      expect(sdkList.some(task => task.id === concurrent.id)).toBe(true);
      expect(sdkList.some(task => task.id === foreign.id)).toBe(false);
      await expect(sdk.tasks.get(foreign.id)).rejects.toMatchObject({ status: 404 });
      for (const form of ["uppercase", "compact", "braced", "four-digit-groups"]) {
        const task = await repo.createTask({ ref: "a", type: "queue:work", status: "failed" });
        const compact = task.id.replaceAll("-", "");
        const input = form === "uppercase" ? task.id.toUpperCase()
          : form === "compact" ? compact
          : form === "braced" ? `{${task.id}}`
          : compact.match(/.{4}/g)?.join("-");
        if (!input) throw new Error("Expected UUID input form");
        expect(await sdk.tasks.retry(input)).toMatchObject({ id: task.id, project_ref: "a", status: "pending" });
        expect((await repo.getTaskById(task.id, "a"))?.status).toBe("pending");
        expect(await sdk.tasks.get(input)).toMatchObject({ id: task.id, status: "pending" });
        expect(await sdk.tasks.cancel(input)).toMatchObject({ id: task.id, status: "cancelled" });
        expect((await repo.getTaskById(task.id, "a"))?.status).toBe("cancelled");
      }
      const dlq = await repo.createTask({ ref: "a", type: "queue:work", status: "dead_lettered" });
      expect((await sdk.tasks.listDlq()).some(task => task.id === dlq.id)).toBe(true);
      await database`
        INSERT INTO project_tasks(project_ref, task_type, status, function_slug, auth_authority_ref)
        SELECT 'a', 'queue:native-list-check', 'dead_lettered', 'worker/path?#', ${dlq.auth_authority_ref}
        FROM generate_series(1, 105)
      `;
      const foreignDlq = await repo.createTask({
        ref: "b", type: "queue:native-list-check", status: "dead_lettered",
      });
      const nonDlq = await repo.createTask({
        ref: "a", type: "queue:native-list-check", status: "pending",
      });
      const listSnapshot = async () => Array.from(await database`
        SELECT id::text, md5(to_jsonb(t)::text) AS hash FROM project_tasks t ORDER BY id
      `);
      const beforeLists = await listSnapshot();
      for (const limit of [1, 3, 100, 200]) {
        const before = requests.length;
        const tasks = await sdk.tasks.listDlq(limit);
        expect(tasks).toHaveLength(Math.min(limit, 106));
        expect(tasks.every(task => task.status === "dead_lettered" && task.project_ref === "a")).toBe(true);
        expect(tasks.some(task => task.id === foreignDlq.id || task.id === nonDlq.id)).toBe(false);
        expect(new Set(tasks.map(task => task.id)).size).toBe(tasks.length);
        expect(requests.length).toBe(before + 1);
        expect(requests.at(-1)).toEqual({ path: "/v1/projects/a/tasks", method: "GET", status: 200 });
      }
      expect(await sdk.tasks.listDlq()).toHaveLength(100);
      const expectedDlqIds: unknown = Array.from(await database`
        SELECT id::text FROM project_tasks WHERE project_ref = 'a' AND status = 'dead_lettered' ORDER BY id
      `);
      expect((await sdk.tasks.listDlq(200)).map(task => ({ id: task.id })).sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual(expectedDlqIds);
      const filtered = await sdk.tasks.list({
        status: ["dead_lettered", "failed"], taskType: ["queue:native-list-check"],
        functionSlug: "worker/path?#", limit: 7,
      });
      expect(filtered).toHaveLength(7);
      expect(filtered.every(task => task.status === "dead_lettered" && task.project_ref === "a"
        && task.task_type === "queue:native-list-check" && task.function_slug === "worker/path?#")).toBe(true);
      expect(await sdk.tasks.list({
        status: "pending", taskType: "queue:native-list-check", limit: 10,
      })).toMatchObject([{ id: nonDlq.id, project_ref: "a", status: "pending" }]);
      const listSpy = spyOn(repo.taskRepository, "listTasksByProjectFiltered");
      try {
        const invalidCommon = [
          "limit=3junk", "limit=0", "limit=-1", "limit=1.5", "limit=1e2",
          "limit=01", "limit=", "limit=9007199254740992", "limit=2&limit=3",
          "summary=yes", "summary=true&summary=false", "unexpected=1",
        ];
        for (const endpoint of ["", "/dlq"]) {
          for (const query of [
            ...invalidCommon,
            ...(endpoint === "" ? [
              "status=", "status=running,,failed", "status=%20running",
              "status=running&status=failed", "task_type=queue:one,",
              "function_slug=", "function_version=%0A", "dlq=1",
              "dlq=true&status=failed",
            ] : ["status=failed", "dlq=false"]),
          ]) {
            const response = await fetch(new URL(`/v1/projects/a/tasks${endpoint}?${query}`, server.url), { headers });
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({
              message: "Invalid task list query", code: "TASK_LIST_QUERY_INVALID",
            });
            expect(listSpy).not.toHaveBeenCalled();
          }
        }
      } finally {
        listSpy.mockRestore();
      }
      for (const [query, count] of [["?limit=3&summary=false", 3], ["?summary=true", 100]] as const) {
        const response = await fetch(new URL(`/v1/projects/a/tasks/dlq${query}`, server.url), { headers });
        expect(response.status).toBe(200);
        const data: unknown = await response.json();
        expect(data).toHaveLength(count);
        expect(parseTaskList(data, "a").every(task => task.status === "dead_lettered")).toBe(true);
      }
      for (const key of ["status", "task_type"]) {
        const oversized = new URL("/v1/projects/a/tasks", server.url);
        oversized.searchParams.set(key, Array.from({ length: 10001 }, () => "x").join(","));
        expect(() => parseTaskListQuery(new Request(oversized))).toThrow("Invalid task list query");
      }
      const directDefault = await repo.listTasksByProject("a");
      expect(directDefault).toHaveLength(50);
      expect(directDefault.every(task => task.project_ref === "a")).toBe(true);
      expect(await repo.listTasksByProject("a", 2)).toHaveLength(2);
      const directFiltered = await repo.listTasksByProjectFiltered("a", {
        statuses: ["dead_lettered"], taskTypes: ["queue:native-list-check"],
        functionSlug: "worker/path?#", limit: 4, summary: true,
      });
      expect(directFiltered).toHaveLength(4);
      expect(directFiltered.every(task => task.project_ref === "a" && task.status === "dead_lettered"
        && task.function_slug === "worker/path?#" && task.task_type === "queue:native-list-check"
        && Object.keys(task.payload).length === 0 && task.result === null)).toBe(true);
      expect(await repo.listTasksByProjectFiltered("a", {
        functionSlug: "worker' OR true --", limit: 4,
      })).toEqual([]);
      const databaseSpy = spyOn(database, "unsafe");
      try {
        for (const limit of [0, -1, 1.5, NaN, Infinity]) {
          await expect(repo.listTasksByProject("a", limit)).rejects.toThrow("Invalid task list input");
        }
        await expect(repo.listTasksByProjectFiltered("a", {
          onlyDeadLettered: true, statuses: ["failed"],
        })).rejects.toThrow("Invalid task list input");
        expect(databaseSpy).not.toHaveBeenCalled();
      } finally { databaseSpy.mockRestore(); }
      expect(await listSnapshot()).toEqual(beforeLists);
      const polled = await repo.createTask({ ref: "a", type: "queue:poll-check", status: "pending" });
      const pollEvents: Array<{ id: string; status: string }> = [];
      const pollStates: string[] = [], pollErrors: unknown[] = [];
      let ready: () => void = () => {};
      let finished: () => void = () => {};
      const observedPending = new Promise<void>(resolve => { ready = resolve; });
      const observedClosed = new Promise<void>(resolve => { finished = resolve; });
      const deadline = setTimeout(() => {
        pollErrors.push(new Error("Native task polling did not complete"));
        ready();
        finished();
      }, 5000);
      const channels = spyOn(sdk.supabase, "channel");
      const removals = spyOn(sdk.supabase, "removeChannel");
      const beforePolling = requests.length;
      const subscription = sdk.tasks.subscribe(polled.id, {
        pollingIntervalMs: 5,
        onUpdate(task) {
          pollEvents.push({ id: task.id, status: task.status });
          if (task.status === "pending") ready();
        },
        onStateChange(state) {
          pollStates.push(state);
          if (state === "closed") finished();
        },
        onError(error) {
          pollErrors.push(error);
          ready();
          finished();
        },
      });
      try {
        expect(subscription.connectionState).toBe("polling");
        await observedPending;
        expect(pollErrors).toEqual([]);
        expect(await sdk.tasks.cancel(polled.id)).toMatchObject({
          id: polled.id, project_ref: "a", status: "cancelled",
        });
        await observedClosed;
        expect(pollErrors).toEqual([]);
        expect(pollStates).toEqual(["polling", "closed"]);
        expect(subscription.connectionState).toBe("closed");
        expect(pollEvents[0]).toEqual({ id: polled.id, status: "pending" });
        expect(pollEvents.at(-1)).toEqual({ id: polled.id, status: "cancelled" });
        expect(pollEvents.every(event => event.id === polled.id)).toBe(true);
        expect((await repo.getTaskById(polled.id, "a"))?.status).toBe("cancelled");
        const pollingRequests = requests.slice(beforePolling);
        expect(pollingRequests.filter(request => request.method === "POST")).toEqual([{
          path: `/v1/projects/a/tasks/${polled.id}/cancel`, method: "POST", status: 200,
        }]);
        expect(pollingRequests.filter(request => request.method === "GET").length).toBeGreaterThanOrEqual(2);
        expect(pollingRequests.every(request => request.status === 200)).toBe(true);
        expect(channels).not.toHaveBeenCalled();
        expect(removals).not.toHaveBeenCalled();
      } finally {
        subscription.unsubscribe();
        clearTimeout(deadline);
        channels.mockRestore();
        removals.mockRestore();
      }
      const abortTask = await repo.createTask({ ref: "a", type: "queue:abort-check", status: "pending" });
      const abortSnapshot = async () => Array.from(await database`
        SELECT md5(to_jsonb(t)::text) AS hash FROM project_tasks t WHERE id = ${abortTask.id}::uuid
      `);
      const beforeAbortState = await abortSnapshot();
      let held = false;
      let readyRead: () => void = () => {}, releaseRead: () => void = () => {}, completedRead: () => void = () => {};
      const readReady = new Promise<void>(resolve => { readyRead = resolve; });
      const readRelease = new Promise<void>(resolve => { releaseRead = resolve; });
      const readCompleted = new Promise<void>(resolve => { completedRead = resolve; });
      responseGate = {
        path: `/v1/projects/a/tasks/${abortTask.id}`,
        wait: readRelease,
        ready() { held = true; readyRead(); },
        released: completedRead,
      };
      const abort = new AbortController();
      const abortReason = new Error("native caller stopped waiting");
      const abortDeadline = setTimeout(() => {
        abort.abort(new Error("Native abort fixture timed out"));
        readyRead();
        releaseRead();
      }, 5000);
      const beforeAbortRequests = requests.length;
      const waiting = sdk.tasks.wait(abortTask.id, { signal: abort.signal });
      // Attach the rejection observer immediately, before waiting on the server.
      const outcome = waiting.then(
        value => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      try {
        await readReady;
        expect(held).toBe(true);
        abort.abort(abortReason);
        const result = await outcome;
        expect(result).toEqual({ ok: false, error: abortReason });
        if (!("error" in result)) throw new Error("Expected cancelled read");
        expect(result.error).toBe(abortReason);
        expect(requests.length).toBe(beforeAbortRequests);
        expect(await abortSnapshot()).toEqual(beforeAbortState);
        releaseRead();
        await readCompleted;
        expect(requests.slice(beforeAbortRequests)).toEqual([{
          path: `/v1/projects/a/tasks/${abortTask.id}`, method: "GET", status: 200,
        }]);
        expect(await abortSnapshot()).toEqual(beforeAbortState);
      } finally {
        responseGate = undefined;
        clearTimeout(abortDeadline);
        abort.abort(abortReason);
        releaseRead();
        await outcome;
      }
      const authTask = await repo.createTask({ ref: "a", type: "queue:work", status: "failed" });
      const authSnapshot = async () => Array.from(await database`
        SELECT md5(to_jsonb(t)::text) AS hash FROM project_tasks t WHERE id = ${authTask.id}::uuid
      `);
      const initialAuthState = await authSnapshot();
      let credential: string | null = null;
      let resolverFailure = false;
      let tokenCalls = 0;
      const authSdk = createSupaCloudClient({
        supabase: createClient(server.url.origin, "fixture-key", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
        managementApiUrl: server.url.origin, projectRef: "a",
        getAccessToken: async () => {
          tokenCalls++;
          await Promise.resolve();
          if (resolverFailure) throw new Error("synthetic private credential failure");
          return credential;
        },
      });
      for (const invalid of [null, "", " synthetic.project-a.credential", "bad\ncredential"]) {
        credential = invalid;
        for (const operation of ["get", "retry", "cancel"] as const) {
          const before = requests.length;
          const tokensBefore = tokenCalls;
          await expect(authSdk.tasks[operation](authTask.id)).rejects.toMatchObject({
            code: "TASK_AUTH_INVALID", mutationMayHaveApplied: false,
            message: "Task authentication could not be validated",
          });
          expect(tokenCalls).toBe(tokensBefore + 1);
          expect(requests.length).toBe(before);
          expect(await authSnapshot()).toEqual(initialAuthState);
        }
      }
      resolverFailure = true;
      const beforeResolverFailure = requests.length;
      await expect(authSdk.tasks.retry(authTask.id)).rejects.toMatchObject({
        code: "TASK_AUTH_INVALID", mutationMayHaveApplied: false,
        message: "Task authentication could not be validated",
      });
      expect(requests.length).toBe(beforeResolverFailure);
      expect(await authSnapshot()).toEqual(initialAuthState);
      resolverFailure = false;
      credential = "synthetic.project-b.credential";
      const beforeForbidden = requests.length;
      await expect(authSdk.tasks.retry(authTask.id)).rejects.toMatchObject({ status: 401 });
      expect(requests.length).toBe(beforeForbidden + 1);
      expect(requests.at(-1)).toMatchObject({ method: "POST", status: 401 });
      expect(await authSnapshot()).toEqual(initialAuthState);
      credential = "synthetic.project-a.credential";
      const beforeAuthorized = requests.length;
      expect(await authSdk.tasks.retry(authTask.id)).toMatchObject({ id: authTask.id, status: "pending" });
      expect(requests.length).toBe(beforeAuthorized + 1);
      expect((await repo.getTaskById(authTask.id, "a"))?.status).toBe("pending");
      expect(await authSnapshot()).not.toEqual(initialAuthState);
      for (const operation of ["retry", "cancel"] as const) {
        const task = await repo.createTask({
          ref: "a", type: "queue:work", status: operation === "retry" ? "failed" : "pending",
        });
        await database`
          UPDATE project_tasks SET metadata = jsonb_build_object('text', repeat(chr(20013), 350000))
          WHERE id = ${task.id}::uuid
        `;
        const snapshot = async () => Array.from(await database`
          SELECT id::text, status, md5(to_jsonb(t)::text) AS hash,
            octet_length(to_jsonb(t)::text)::integer AS bytes
          FROM project_tasks t WHERE id = ${task.id}::uuid
        `);
        const before = requests.length;
        await expect(sdk.tasks[operation](task.id)).rejects.toMatchObject({
          code: operation === "retry" ? "TASK_RETRY_UNCONFIRMED" : "TASK_CANCEL_UNCONFIRMED",
          mutationMayHaveApplied: true,
        });
        expect(requests.length - before).toBe(1);
        expect(requests.at(-1)).toEqual({
          path: `/v1/projects/a/tasks/${task.id}/${operation}`, method: "POST", status: 200,
        });
        const committed = await snapshot();
        expect(committed[0]).toMatchObject({
          id: task.id, status: operation === "retry" ? "pending" : "cancelled",
        });
        expect(committed[0]?.bytes).toBeGreaterThan(1024 * 1024);
        await expect(sdk.tasks.get(task.id)).rejects.toMatchObject({
          code: "TASK_READ_INVALID", mutationMayHaveApplied: false,
        });
        expect(requests.length - before).toBe(2);
        expect(await snapshot()).toEqual(committed);
        const replayStatus = operation === "retry" ? 404 : 409;
        await expect(sdk.tasks[operation](task.id)).rejects.toMatchObject({
          status: replayStatus, code: String(replayStatus),
        });
        expect(requests.length - before).toBe(3);
        expect(await snapshot()).toEqual(committed);
      }

      for (const fault of [
        "project", "id", "status", "error", "lease", "schedule", "completed",
        "cancel_requested", "cancellation_reason", "sql", "malformed",
      ]) {
        const task = await repo.createTask({
          ref: "a", type: "queue:work", status: "failed", metadata: { retry_fault: fault },
        });
        if (fault === "malformed") {
          await database`UPDATE project_tasks SET metadata = 'false'::jsonb WHERE id = ${task.id}::uuid`;
        }
        await database.unsafe("ALTER SEQUENCE retry_statements RESTART WITH 1");
        if (fault === "sql") {
          await expect(repo.retryTask(task.id, "a")).rejects.toThrow("synthetic retry transaction failure");
        } else {
          await expect(repo.retryTask(task.id, "a")).rejects.toBeInstanceOf(InvalidTaskRecordError);
        }
        const unchanged: unknown = await database`
          SELECT id::text, project_ref, status FROM project_tasks WHERE id = ${task.id}::uuid
        `;
        expect(unchanged).toEqual([{ id: task.id, project_ref: "a", status: "failed" }]);
        const statements: unknown = await database`SELECT last_value::int FROM retry_statements`;
        expect(statements).toEqual([{ last_value: 1 }]);
      }
    } finally {
      await server.stop(true);
      config.authRuntimeOwnerRef = originalOwnerRef;
    }
  }),
  45_000,
);
