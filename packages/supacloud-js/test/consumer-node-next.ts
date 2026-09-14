import {
  createSupaCloudClient,
  createSupaCloudOAuthFetch,
  createSupaCloudWorkflowFetch,
  createSupaCloudCommandFetch,
  createSupaCloudArtifactFetch,
  createSupaCloudTaskFetch,
  SupaCloudTaskSubmitError,
  SupaCloudTaskResponseError,
  SupaCloudTaskAuthenticationError,
  type SupaCloudTaskFetchOptions,
  type SupaCloudTaskReceipt,
  type SupaCloudTaskDetail,
  type SupaCloudTaskSnapshot,
  type SupaCloudTaskResultDecoder,
  type SupaCloudTaskWaitOptions,
  type SupaCloudTaskSubscribeOptions,
  type SupaCloudTaskSubscribeState,
  type SupaCloudTaskSubscription,
  type SupaCloudOAuthFetchOptions,
  type SupaCloudOAuthServerStatus,
  type SupaCloudWorkflowFetchOptions,
  type SupaCloudWorkflowRun,
  type SupaCloudWorkflowEvent,
  type SupaCloudWorkflowClaimResult,
  type SupaCloudWorkflowAttemptRequest,
  type SupaCloudCommandFetchOptions,
  type SupaCloudArtifactFetchOptions,
  type SupaCloudCommandReceipt,
  type SupaCloudArtifact,
  type SupaCloudArtifactRegisterRequest,
  type SupaCloudArtifactLinkRequest,
  type SupaCloudQueueMessage,
  type SupaCloudQueueMutationResult,
} from "@supacloud/js";
import { createClient } from "@supabase/supabase-js";
import type { CommandWorkflowStatus } from "@supacloud/contracts";

const options = {
  clientId: "public-client",
} satisfies SupaCloudOAuthFetchOptions;

void createSupaCloudOAuthFetch(options);

const workflowTransport = {
  fetch: createSupaCloudOAuthFetch(options),
} satisfies SupaCloudWorkflowFetchOptions;

const commandTransport = {
  fetch: createSupaCloudWorkflowFetch(workflowTransport),
} satisfies SupaCloudCommandFetchOptions;
const artifactTransport = {
  fetch: createSupaCloudCommandFetch(commandTransport),
} satisfies SupaCloudArtifactFetchOptions;
const taskTransport = {
  functionUrls: ["https://project.example.com/functions/v1/worker"],
  fetch: createSupaCloudArtifactFetch(artifactTransport),
} satisfies SupaCloudTaskFetchOptions;

const supabase = createClient("https://project.example.com", "anon-key", {
  global: { fetch: createSupaCloudTaskFetch(taskTransport) },
  auth: { persistSession: false, autoRefreshToken: false },
});
const client = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://management.example.com",
  projectRef: "proj_1",
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type TaskTransportContract = Assert<Equal<
  Awaited<ReturnType<ReturnType<typeof createSupaCloudTaskFetch>>>, Response
>>;
type WorkerQueuePortShape<TMessage, TReceipt> = {
  receive(options?: {
    visibilityTimeoutSec?: number;
    sleepSeconds?: number;
    sleep_seconds?: number;
  }): Promise<TMessage | null>;
  ack(messageId: string | number): TReceipt | Promise<TReceipt>;
  fail(messageId: string | number, options?: {
    error?: string;
    deadLetter?: boolean;
  }): TReceipt | Promise<TReceipt>;
};
type QueueWorkerPortContract = Assert<
  ReturnType<typeof client.queue> extends WorkerQueuePortShape<
    SupaCloudQueueMessage,
    SupaCloudQueueMutationResult
  > ? true : false
>;
type TaskSubmitContract = Assert<Equal<
  Awaited<ReturnType<typeof client.tasks.submit>>, SupaCloudTaskReceipt
>>;
type TaskReadContract = Assert<Equal<
  Awaited<ReturnType<typeof client.tasks.get>>, SupaCloudTaskDetail
>>;
type TaskReadSignalContract = Assert<Equal<
  Parameters<typeof client.tasks.get>[1], AbortSignal | undefined
>>;
type TaskWaitOptionsContract = Assert<Equal<
  Parameters<typeof client.tasks.wait>[1], SupaCloudTaskWaitOptions | undefined
>>;
type TaskReceiptWaitContract = Assert<Equal<
  Parameters<SupaCloudTaskReceipt["wait"]>[0], SupaCloudTaskWaitOptions | undefined
>>;
type TaskWaitSignalContract = Assert<Equal<
  SupaCloudTaskWaitOptions["signal"], AbortSignal | undefined
>>;
type TaskRealtimeContract = Assert<Equal<
  SupaCloudTaskSubscribeOptions["realtime"], { schema: string; table: string } | undefined
>>;
type TaskSubscribeOptionsContract = Assert<Equal<
  Parameters<typeof client.tasks.subscribe>[1], SupaCloudTaskSubscribeOptions
>>;
type TaskUpdateContract = Assert<Equal<
  Parameters<SupaCloudTaskSubscribeOptions["onUpdate"]>[0], SupaCloudTaskSnapshot
>>;
type TaskSubscriptionErrorContract = Assert<Equal<
  Parameters<NonNullable<SupaCloudTaskSubscribeOptions["onError"]>>[0], unknown
>>;
type TaskSubscriptionStateContract = Assert<Equal<
  ReturnType<typeof client.tasks.subscribe>["connectionState"], SupaCloudTaskSubscribeState
>>;
type TaskUnsubscribeContract = Assert<Equal<
  ReturnType<ReturnType<typeof client.tasks.subscribe>["unsubscribe"]>, void
>>;
type TaskReceiptSubscribeContract = Assert<Equal<
  ReturnType<SupaCloudTaskReceipt["subscribe"]>, ReturnType<typeof client.tasks.subscribe>
>>;
type TaskSubscriptionContract = Assert<Equal<
  ReturnType<typeof client.tasks.subscribe>, SupaCloudTaskSubscription
>>;
type TaskSubscriptionReadonlyContract = Assert<Equal<
  Pick<SupaCloudTaskSubscription, "connectionState">,
  { readonly connectionState: SupaCloudTaskSubscribeState }
>>;
type TaskProjectContract = Assert<Equal<SupaCloudTaskDetail["project_ref"], string>>;
type TaskListProjectContract = Assert<Equal<
  Awaited<ReturnType<typeof client.tasks.list>>[number]["project_ref"], string
>>;
type TaskSubmitErrorCodeContract = Assert<Equal<SupaCloudTaskSubmitError["code"], "TASK_SUBMIT_UNCONFIRMED">>;
type TaskSubmitMutationContract = Assert<Equal<SupaCloudTaskSubmitError["mutationMayHaveApplied"], true>>;
type TaskAuthMutationContract = Assert<Equal<SupaCloudTaskAuthenticationError["mutationMayHaveApplied"], false>>;
void new SupaCloudTaskSubmitError("Unconfirmed", undefined);
void new SupaCloudTaskResponseError("retry");
void new SupaCloudTaskAuthenticationError("TASK_AUTH_TIMEOUT");

type Result = { value: number };
const decodeResult: SupaCloudTaskResultDecoder<Result> = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("value" in value) || typeof value.value !== "number") {
    throw new Error("Invalid result");
  }
  return { value: value.value };
};
const typedReceiptPromise = client.tasks.submitTyped("worker", decodeResult);
type TypedSubmitContract = Assert<Equal<
  Awaited<typeof typedReceiptPromise>, SupaCloudTaskReceipt<Result>
>>;
type TypedGetContract = Assert<Equal<
  Awaited<ReturnType<typeof client.tasks.getTyped<Result>>>, SupaCloudTaskDetail<Result>
>>;
type TypedWaitContract = Assert<Equal<
  Awaited<ReturnType<typeof client.tasks.waitTyped<Result>>>, SupaCloudTaskDetail<Result>
>>;
type TypedReceiptGetContract = Assert<Equal<
  Awaited<ReturnType<SupaCloudTaskReceipt<Result>["get"]>>, SupaCloudTaskDetail<Result>
>>;
type TypedReceiptWaitContract = Assert<Equal<
  Awaited<ReturnType<SupaCloudTaskReceipt<Result>["wait"]>>, SupaCloudTaskDetail<Result>
>>;
type TypedReceiptCancelContract = Assert<Equal<
  Awaited<ReturnType<SupaCloudTaskReceipt<Result>["cancel"]>>, SupaCloudTaskDetail<Result>
>>;
type TypedReceiptRetryContract = Assert<Equal<
  Awaited<ReturnType<SupaCloudTaskReceipt<Result>["retry"]>>, SupaCloudTaskDetail<Result>
>>;
type TypedSnapshotContract = Assert<Equal<
  Parameters<SupaCloudTaskSubscribeOptions<Result>["onUpdate"]>[0], SupaCloudTaskSnapshot<Result>
>>;
void typedReceiptPromise;

async function consumeTask(taskId: string, receipt: SupaCloudTaskReceipt, signal: AbortSignal): Promise<void> {
  const detail: SupaCloudTaskDetail = await client.tasks.get(taskId, signal);
  await client.tasks.wait(taskId, { signal, intervalMs: 100 });
  await receipt.wait({ signal });
  const options = {
    realtime: { schema: "public", table: "published_tasks" },
    onUpdate(task) {
      const snapshot: SupaCloudTaskSnapshot = task;
      void snapshot;
    },
    onStateChange(state, details) {
      const connection: SupaCloudTaskSubscribeState = state;
      const failure: unknown = details?.error;
      void connection;
      void failure;
    },
    onError(error) {
      const failure: unknown = error;
      void failure;
    },
  } satisfies SupaCloudTaskSubscribeOptions;
  const subscription = client.tasks.subscribe(detail.id, options);
  const receiptSubscription = receipt.subscribe(options);
  subscription.unsubscribe();
  receiptSubscription.unsubscribe();
}
void consumeTask;

type Status = Awaited<ReturnType<typeof client.auth.oauthServer.getStatus>>;
type Migration = Awaited<ReturnType<typeof client.auth.oauthServer.migrateToOidc>>;
type StatusContract = Assert<Equal<Status, SupaCloudOAuthServerStatus>>;
type MigrationContract = Assert<Equal<Migration, Status>>;
type OrganizationContract = Assert<Equal<Status["organization_id"], string | null>>;
type WarningsContract = Assert<Equal<Status["warnings"], string[]>>;
type ReadinessContract = Assert<Equal<Status["oidc_id_token_ready"], boolean>>;
type WorkflowReadContract = Assert<Equal<
  Awaited<ReturnType<typeof client.workflows.get>>, SupaCloudWorkflowRun | null
>>;
type WorkflowEventsContract = Assert<Equal<
  Awaited<ReturnType<typeof client.workflows.events>>, SupaCloudWorkflowEvent[]
>>;
type WorkflowClaimContract = Assert<Equal<
  Awaited<ReturnType<typeof client.workflows.claim>>, SupaCloudWorkflowClaimResult
>>;
type WorkflowMutationContract = Assert<Equal<
  Awaited<ReturnType<typeof client.workflows.start | typeof client.workflows.advance
    | typeof client.workflows.complete | typeof client.workflows.retry
    | typeof client.workflows.fail | typeof client.workflows.cancel>>,
  SupaCloudWorkflowRun
>>;
type WorkflowMessageIdContract = Assert<Equal<SupaCloudWorkflowAttemptRequest["messageId"], string>>;
type WorkflowEventIdContract = Assert<Equal<SupaCloudWorkflowEvent["eventId"], string>>;
type WorkflowRowVersionContract = Assert<Equal<SupaCloudWorkflowRun["rowVersion"], string>>;
type WorkflowTransportContract = Assert<Equal<
  Awaited<ReturnType<ReturnType<typeof createSupaCloudWorkflowFetch>>>, Response
>>;
type CommandReadContract = Assert<Equal<
  Awaited<ReturnType<typeof client.commands.get>>, SupaCloudCommandReceipt | null
>>;
type CommandSubmitContract = Assert<Equal<
  Awaited<ReturnType<typeof client.commands.submit>>, SupaCloudCommandReceipt
>>;
type CommandWorkflowContract = Assert<Equal<SupaCloudCommandReceipt["workflow"], CommandWorkflowStatus | null>>;
type ArtifactReadContract = Assert<Equal<
  Awaited<ReturnType<typeof client.artifacts.get>>, SupaCloudArtifact | null
>>;
type ArtifactMutationContract = Assert<Equal<
  Awaited<ReturnType<typeof client.artifacts.register | typeof client.artifacts.link>>, SupaCloudArtifact
>>;
type ArtifactRegisterContract = Assert<Equal<
  Parameters<typeof client.artifacts.register>[0], SupaCloudArtifactRegisterRequest
>>;
type ArtifactLinkContract = Assert<Equal<
  Parameters<typeof client.artifacts.link>[0], SupaCloudArtifactLinkRequest
>>;
type ArtifactSizeContract = Assert<Equal<SupaCloudArtifact["sizeBytes"], string>>;
type ArtifactMetadataContract = Assert<Equal<SupaCloudArtifact["metadata"], Record<string, unknown>>>;
type CommandTransportContract = Assert<Equal<
  Awaited<ReturnType<ReturnType<typeof createSupaCloudCommandFetch>>>, Response
>>;
type ArtifactTransportContract = Assert<Equal<
  Awaited<ReturnType<ReturnType<typeof createSupaCloudArtifactFetch>>>, Response
>>;

async function consumeClaim(result: SupaCloudWorkflowClaimResult): Promise<void> {
  if (result?.status === "claimed") {
    const attempt = {
      stepId: result.stepId, messageId: result.messageId,
      attempt: result.attempt, workerId: result.workerId,
    } satisfies SupaCloudWorkflowAttemptRequest;
    await client.workflows.complete(attempt);
  } else if (result?.status === "dead_lettered") {
    const maxAttempts: number = result.maxAttempts;
    void maxAttempts;
  } else if (result?.status === "discarded") {
    const reason: string = result.reason;
    void reason;
  }
}
void consumeClaim;
