import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { readDeliveryExecutableArchive } from "../../../delivery/src";
import { SupaCloudArtifactsClient } from "../../../supacloud-js/src/artifacts";
import { SupaCloudWorkflowsClient } from "../../../supacloud-js/src/workflows";

// The operator starts api/jobs from this archive and provisions the starter migrations.
// This fixture owns only a new draft. Retain it and all immutable evidence on failure.
export function businessSettings(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string): string => {
    const value = env[name];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
    return value;
  };
  assert.equal(env.SUPACLOUD_BUSINESS_WORKFLOW_TEST, "1", "Explicit business acceptance opt-in required");
  const ref = required("SUPACLOUD_TEST_PROJECT_REF");
  assert.match(ref, /^[a-z0-9]{10,20}$/);
  const origin = new URL(required("SUPACLOUD_BUSINESS_ORIGIN"));
  assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/",
    "Business origin must be a credential-free origin");
  assert.ok(origin.protocol === "https:" ||
    (origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)),
  "Business origin requires HTTPS or a local compiled API listener");
  const timeoutMs = Number(env.SUPACLOUD_BUSINESS_TIMEOUT_MS ?? "60000");
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000);
  return {
    ref, origin: origin.origin, timeoutMs,
    archive: required("SUPACLOUD_BUSINESS_ARCHIVE"),
    databaseUrl: required("DATABASE_URL"),
    tenantId: required("SUPACLOUD_BUSINESS_TENANT_ID"),
    clientId: required("SUPACLOUD_BUSINESS_CLIENT_ID"),
    workerId: required("SUPACLOUD_BUSINESS_WORKER_ID"),
    ownerToken: required("SUPACLOUD_BUSINESS_OWNER_TOKEN"),
    otherToken: required("SUPACLOUD_BUSINESS_OTHER_TOKEN"),
  };
}

export async function runPlatformBusinessWorkflow(env: NodeJS.ProcessEnv = process.env) {
  const settings = businessSettings(env);
  const archive = await readDeliveryExecutableArchive(settings.archive);
  const api = archive.objects.find(item => item.object.name === "api")?.object;
  const jobs = archive.objects.find(item => item.object.name === "jobs")?.object;
  assert.equal(api?.entryKind, "bun-http-application");
  assert.equal(jobs?.entryKind, "bun-worker-application");
  const reviewId = crypto.randomUUID(), artifactId = crypto.randomUUID(), operation = crypto.randomUUID();
  const evidence: Record<string, boolean> = {};
  const ids = { reviewId, artifactId, runId: artifactId, operation,
    apiObjectId: api!.objectId, jobsObjectId: jobs!.objectId };
  const meta = new SQL(settings.databaseUrl, { max: 1, connectionTimeout: 5 });
  let database: SQL | undefined;
  let phase = "preflight";
  try {
    const [project] = await meta`
      SELECT name, db_name, anon_key, service_role_key FROM projects
      WHERE ref = ${settings.ref} AND deleted_at IS NULL
    `;
    assert.ok(project?.name.startsWith("platform-app-acceptance-"), "Dedicated acceptance tenant required");
    assert.equal(project.db_name, `supa_${settings.ref}`);
    assert.ok(project.anon_key && project.service_role_key, "Tenant SDK keys required");
    const connection = new URL(settings.databaseUrl);
    database = new SQL({
      hostname: connection.hostname, port: Number(connection.port || 5432),
      username: decodeURIComponent(connection.username), password: decodeURIComponent(connection.password),
      database: project.db_name, max: 1, connectionTimeout: 5,
    });
    const [identity] = await database`SELECT current_database() AS name`;
    assert.equal(identity?.name, project.db_name);
    const [lock] = await database`
      SELECT pg_try_advisory_lock(hashtextextended(${"supacloud.platform-workflow-acceptance"}, 0)) AS acquired
    `;
    assert.equal(lock?.acquired, true, "Another acceptance fixture owns this tenant");
    const binding = await database`SELECT project_id, tenant_id FROM public.starter_application WHERE singleton`;
    assert.equal(binding.length, 1);
    assert.equal(binding[0]?.project_id, settings.ref);
    assert.equal(binding[0]?.tenant_id, settings.tenantId);
    const [pending] = await database`
      SELECT count(*)::int AS count FROM pgmq.q_supacloud_internal_workflows
    `;
    assert.equal(pending?.count, 0, "Compiled worker requires an idle exclusively owned queue");
    const [bucket] = await database`SELECT public FROM storage.buckets WHERE id = 'review-attachments'`;
    assert.equal(bucket?.public, false, "Provision the starter private attachment bucket first");
    const platformOrigin = `https://${settings.ref}.api.localhost`;
    const transport = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, platformOrigin, "SDK must stay on the tenant Caddy origin");
      return fetch(request, {
        redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      });
    }) as typeof fetch;
    const client = (key: string, token: string) => createClient(platformOrigin, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${token}` }, fetch: transport },
    });
    const service = client(project.service_role_key, project.service_role_key);
    const owner = client(project.anon_key, settings.ownerToken);
    const other = client(project.anon_key, settings.otherToken);
    const artifacts = new SupaCloudArtifactsClient(service);
    const workflows = new SupaCloudWorkflowsClient(service);
    const subjects: string[] = [];
    const storageSubjects: string[] = [];
    for (const [sdk, token] of [[owner, settings.ownerToken], [other, settings.otherToken]] as const) {
      const verified = await sdk.auth.getUser(token);
      assert.ok(!verified.error && verified.data.user, "GoTrue must accept each real user token");
      // Decode only after GoTrue verification; the compiled API independently verifies JWKS.
      const claims = decodeJwt(token);
      assert.equal(claims.role, "authenticated");
      assert.equal(claims.client_id ?? claims.azp, settings.clientId);
      assert.ok(typeof claims.sub === "string" && claims.sub.length > 0);
      const [member]: { subject: string; storage_subject: string; enabled: boolean; can_approve: boolean }[] = await database`
        SELECT subject, storage_subject::text, enabled, can_approve
        FROM public.starter_members WHERE subject = ${claims.sub}
      `;
      assert.ok(member?.enabled && member?.can_approve, "Provision enabled starter approval members first");
      assert.equal(member.storage_subject, verified.data.user.id, "Starter member/GoTrue storage identity mismatch");
      subjects.push(claims.sub);
      storageSubjects.push(member.storage_subject);
    }
    assert.notEqual(subjects[0], subjects[1]);
    assert.notEqual(storageSubjects[0], storageSubjects[1]);
    evidence.realGoTrueIdentity = true;
    evidence.verifiedArchiveInventory = true;
    await database`
      INSERT INTO public.starter_reviews(id, owner_id, state, version)
      VALUES (${reviewId}, ${subjects[0]!}, 'draft', 1)
    `;
    const call = (action: string, token = settings.ownerToken, key = operation) =>
      fetch(`${settings.origin}/reviews/${reviewId}/${action}`, {
        method: "POST", redirect: "error",
        headers: {
          "content-type": "application/json", "idempotency-key": key,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(action === "approve" ? { expectedVersion: 1 } : { artifactId, expectedVersion: 1 }),
        signal: AbortSignal.timeout(15000),
      });
    phase = "authorization";
    for (const action of ["attachment-upload", "attachment-registration", "approve"]) {
      assert.equal((await call(action, "")).status, 401, `${action}: anonymous access`);
      assert.equal((await call(action, settings.otherToken)).status, 403, `${action}: foreign owner access`);
    }
    evidence.httpAuthorization = true;
    phase = "upload";
    const path = `${storageSubjects[0]}/${reviewId}/${artifactId}.txt`;
    const body = new TextEncoder().encode(`business acceptance ${reviewId}`);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const preview = await call("attachment-upload");
    assert.equal(preview.status, 200, "Compiled upload preview failed");
    assert.deepEqual(await preview.json(), { artifactId, bucketId: "review-attachments", objectPath: path });
    evidence.uploadPreview = true;
    const ownerStorage = owner.storage.from("review-attachments");
    const otherStorage = other.storage.from("review-attachments");
    assert.ok((await otherStorage.upload(path, body, { contentType: "text/plain" })).error);
    assert.ok((await otherStorage.upload(`${storageSubjects[1]}/${reviewId}/${artifactId}.txt`, body,
      { contentType: "text/plain" })).error, "Own subject prefix must not bypass review ownership");
    evidence.foreignStorageUploadRejected = true;
    phase = "upload:owner";
    assert.equal((await ownerStorage.upload(path, body, { contentType: "text/plain" })).error, null);
    evidence.ownerStorageUpload = true;
    phase = "upload:readback";
    assert.ok((await otherStorage.download(path)).error, "Private object must reject foreign reads");
    const downloaded = await ownerStorage.download(path);
    assert.equal(downloaded.error, null);
    assert.equal(await downloaded.data?.text(), new TextDecoder().decode(body));
    evidence.ownerStorageUploadAndReadback = true;
    evidence.storageOwnershipFence = true;
    phase = "registration";
    const expectedRegistration = { artifactId, runId: artifactId, objectPath: path, sha256, bytes: body.byteLength };
    for (let replay = 0; replay < 2; replay++) {
      const registered = await call("attachment-registration");
      assert.equal(registered.status, 200, "Compiled attachment registration failed");
      assert.deepEqual(await registered.json(), expectedRegistration);
    }
    const artifact = await artifacts.get(artifactId);
    assert.ok(artifact);
    assert.equal(artifact.objectPath, path);
    assert.equal(artifact.bucketId, "review-attachments");
    assert.equal(artifact.artifactType, "review.attachment");
    assert.equal(artifact.sha256, sha256);
    assert.equal(artifact.sizeBytes, String(body.byteLength));
    assert.equal(await workflows.get(artifactId), null, "Registration alone must not enqueue");
    evidence.registrationAndImmutableReadback = true;
    phase = "approval";
    for (let replay = 0; replay < 2; replay++) {
      const approved = await call("approve");
      assert.equal(approved.status, 200, "Compiled approval/replay failed");
      assert.deepEqual(await approved.json(), { state: "approved", version: 2 });
    }
    assert.equal((await call("approve", settings.ownerToken, crypto.randomUUID())).status, 409,
      "A fresh operation with stale version must conflict");
    evidence.approvalAndIdempotentReplay = true;
    phase = "worker";
    const expected = { reviewId, artifactId, version: 2, sha256, bytes: body.byteLength };
    const deadline = Date.now() + settings.timeoutMs;
    for (;;) {
      const run = await workflows.get(artifactId);
      assert.ok(run, "Approval must durably enqueue its bound Workflow");
      assert.equal(run.workflowName, "review.verify-attachment");
      assert.equal(run.workflowVersion, "1");
      assert.deepEqual(run.input, { reviewId, artifactId, version: 2 });
      if (run.status === "completed") {
        assert.deepEqual(run.output, expected);
        assert.equal(run.steps.length, 1);
        assert.equal(run.steps[0]?.status, "completed");
        assert.equal(run.steps[0]?.claimedBy, settings.workerId);
        break;
      }
      assert.ok(["queued", "running"].includes(run.status), "Compiled worker reached terminal failure");
      assert.ok(Date.now() < deadline, "Compiled worker did not complete within the acceptance deadline");
      await Bun.sleep(250);
    }
    const events = await workflows.events(artifactId);
    assert.equal(events[0]?.eventType, "run_started");
    assert.equal(events.at(-1)?.eventType, "run_completed");
    assert.ok(events.some(event => event.eventType === "step_claimed"));
    assert.ok(events.some(event => event.eventType === "step_completed"));
    evidence.externalWorkerCompletion = true;
    phase = "durable-readback";
    const reviews = await database`SELECT state, version FROM public.starter_reviews WHERE id = ${reviewId}`;
    assert.deepEqual(Array.from(reviews), [{ state: "approved", version: 2 }]);
    const results = await database`
      SELECT result FROM public.starter_attachment_results WHERE review_id = ${reviewId}
    `;
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.result, expected);
    for (const key of [operation, artifactId]) {
      const [receipt]: { count: number }[] = await database`
        SELECT count(*)::int AS count FROM supacloud_commands.execution_receipts WHERE operation_key = ${key}
      `;
      const [audit]: { count: number }[] = await database`
        SELECT count(*)::int AS count FROM supacloud_commands.execution_audit WHERE operation_key = ${key}
      `;
      assert.equal(receipt?.count, 1);
      assert.equal(audit?.count, 1);
    }
    evidence.durableResultAndSingleReceipts = true;
    const [remaining] = await database`SELECT count(*)::int AS count FROM pgmq.q_supacloud_internal_workflows`;
    assert.equal(remaining?.count, 0);
    evidence.queueDrained = true;
    return { status: "PASS", ...ids, durableResult: expected, evidence, retention: "business-and-immutable-evidence-retained",
      runtimeProvenance: "external-launcher-must-attest-archive-object-ids",
      identityScope: "GoTrue-token-and-starter-SupAuth-contract-not-external-SupAuth-provider",
      fullBusinessAcceptance: false };
  } catch {
    // Never print SDK/SQL errors that may contain credentials or request headers.
    const businessEvidence = { status: "FAIL", phase, ...ids, evidence,
      retention: "retain-for-recovery-no-automatic-deletion" };
    throw Object.assign(new Error(JSON.stringify(businessEvidence)), {
      code: "BUSINESS_FIXTURE_FAILED", businessEvidence,
    });
  } finally {
    await database?.close();
    await meta.close();
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runPlatformBusinessWorkflow())); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Business acceptance failed");
    process.exitCode = 1;
  }
}
