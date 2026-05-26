import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createSupaCloudClient, SupaCloudApiError, SupaCloudTaskSubmitError } from "./index";

function createFakeSupabase() {
  const removeChannel = mock(async () => "ok");
  type FakeChannel = {
    on: ReturnType<typeof mock>;
    subscribe: ReturnType<typeof mock>;
  };

  let channelInstance: FakeChannel;
  channelInstance = {
    on: mock(function () {
      return channelInstance;
    }),
    subscribe: mock(function () {
      return channelInstance;
    }),
  };

  const supabase = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "token-123" } },
        error: null,
      }),
    },
    functions: {
      invoke: mock(),
    },
    channel: mock(() => channelInstance),
    removeChannel,
  };

  return { supabase, channelInstance, removeChannel };
}

describe("@supacloud/js", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("submit preserves plain invoke options and returns a receipt", async () => {
    const { supabase } = createFakeSupabase();
    supabase.functions.invoke.mockResolvedValue({
      data: { task_id: "tsk_123", status: "enqueued" },
      error: null,
    });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const receipt = await client.tasks.submit("aorist-ai/generate/crop", {
      body: { image_id: "img_1" },
      retries: 2,
      timeoutSec: 300,
      idempotencyKey: "crop-img_1-v1",
    });

    expect(receipt.taskId).toBe("tsk_123");
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
    expect(supabase.functions.invoke.mock.calls[0]?.[1]).toMatchObject({
      body: { image_id: "img_1" },
      headers: {
        "x-supacloud-idempotency-key": "crop-img_1-v1",
      },
    });
  });

  test("submit throws a dedicated error when the task was not enqueued", async () => {
    const { supabase } = createFakeSupabase();
    supabase.functions.invoke.mockResolvedValue({
      data: { prediction: { image: "https://example.com/image.png" } },
      error: null,
    });

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
    });

    await expect(
      client.tasks.submit("aorist-ai/generate/crop"),
    ).rejects.toBeInstanceOf(SupaCloudTaskSubmitError);
  });

  test("get/list/cancel/retry build management-api requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "tsk_123", status: "running" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    await client.tasks.get("tsk_123");
    await client.tasks.list({ status: ["running", "failed"], functionSlug: "aorist-ai", limit: 5 });
    await client.tasks.cancel("tsk_123");
    await client.tasks.retry("tsk_123");
    await client.tasks.listDlq(10);

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123");
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks?status=running%2Cfailed&function_slug=aorist-ai&limit=5");
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123/cancel");
    expect(calls[2]?.init?.method).toBe("POST");
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/tsk_123/retry");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/dlq?limit=10");
    expect((calls[0]?.init?.headers as Record<string, string>)?.authorization).toBe("Bearer token-123");
  });

  test("queue client builds management-api requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "msg_123", status: "leased", payload: { hello: "world" } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });
    const queue = client.queue("emails");

    await queue.send({ hello: "world" }, {
      delayMs: 1000,
      maxAttempts: 5,
      idempotencyKey: "email-1",
      correlationId: "corr-1",
      businessTaskId: "biz-1",
      metadata: { tenant: "acme" },
    });
    await queue.receive({ visibilityTimeoutSec: 60 });
    await queue.list({ status: ["pending", "leased"], limit: 10 });
    await queue.stats();
    await queue.getSettings();
    await queue.updateSettings({ max_in_flight: 20 });
    await queue.get("msg_123");
    await queue.ack("msg_123", { ok: true });
    await queue.release("msg_123", { delayMs: 5000, error: "retry later" });
    await queue.fail("msg_123", { error: "boom" });
    await queue.retry("msg_123");
    await queue.delete("msg_123");

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages");
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/receive");
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages?status=pending%2Cleased&limit=10");
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/stats");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/settings");
    expect(calls[5]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/settings");
    expect(calls[5]?.init?.method).toBe("PATCH");
    expect(calls[6]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123");
    expect(calls[7]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/ack");
    expect(calls[8]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/release");
    expect(calls[9]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/fail");
    expect(calls[10]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123/retry");
    expect(calls[11]?.url).toBe("https://admin.example.com/v1/projects/proj_1/tasks/queues/emails/messages/msg_123");
    expect(calls[11]?.init?.method).toBe("DELETE");
    expect((calls[0]?.init?.headers as Record<string, string>)?.authorization).toBe("Bearer token-123");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      payload: { hello: "world" },
      delayMs: 1000,
      maxAttempts: 5,
      idempotencyKey: "email-1",
      correlationId: "corr-1",
      businessTaskId: "biz-1",
      metadata: { tenant: "acme" },
    });
  });

  test("management-api errors preserve status, code, and response body", async () => {
    const { supabase } = createFakeSupabase();
    const errorBody = {
      message: "Queue message cannot be replayed from its current state",
      code: "409",
    };

    globalThis.fetch = mock(() => Promise.resolve(
      new Response(JSON.stringify(errorBody), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    try {
      await client.queue("emails").retry("msg_123");
      throw new Error("Expected retry to fail");
    } catch (error) {
      expect(error instanceof SupaCloudApiError).toBe(true);
      expect((error as SupaCloudApiError).status).toBe(409);
      expect((error as SupaCloudApiError).code).toBe("409");
      expect((error as SupaCloudApiError).responseBody).toMatchObject(errorBody);
      expect((error as Error).message).toBe(errorBody.message);
    }
  });

  test("queue receive returns null when no message is available", async () => {
    const { supabase } = createFakeSupabase();
    globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const message = await client.queue("emails").receive();
    expect(message).toBe(null);
  });

  test("oauth helpers call management api and build authorize urls", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const statusPayload = {
      project_ref: "proj_1",
      organization_id: "org_1",
      account_isolated: true,
      enabled: true,
      allow_dynamic_registration: true,
      issuer: "https://proj.example.com/auth/v1",
      discovery_url: "https://proj.example.com/auth/v1/.well-known/openid-configuration",
      jwks_url: "https://proj.example.com/auth/v1/.well-known/jwks.json",
      authorization_endpoint: "https://proj.example.com/auth/v1/oauth/authorize",
      token_endpoint: "https://proj.example.com/auth/v1/oauth/token",
      registration_endpoint: "https://proj.example.com/auth/v1/oauth/clients/register",
      signing_alg: "ES256",
      oidc_id_token_ready: true,
      migration_status: "oidc_es256_migrated",
      warnings: [],
    };

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });

      if (
        url.endsWith("/auth/oauth-server")
        || url.endsWith("/auth/oauth-server/migrate")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(statusPayload), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url === statusPayload.discovery_url) {
        return Promise.resolve(
          new Response(JSON.stringify({ issuer: statusPayload.issuer, authorization_endpoint: statusPayload.authorization_endpoint }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url === statusPayload.jwks_url) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith("/auth/oauth-clients")) {
        if ((init?.method ?? "GET") === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({ client_id: "client_1", client_name: "App" }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ clients: [{ client_id: "client_1" }] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith("/auth/oauth-clients/client_1/regenerate-secret")) {
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: "client_1", client_secret: "secret_2" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith("/auth/oauth-clients/client_1")) {
        if ((init?.method ?? "GET") === "PUT") {
          return Promise.resolve(
            new Response(JSON.stringify({ client_id: "client_1", client_name: "App 2" }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if ((init?.method ?? "GET") === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: "client_1", client_name: "App" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    const status = await client.auth.oauthServer.getStatus();
    await client.auth.oauthServer.migrateToOidc({ allowDynamicRegistration: true });
    const discovery = await client.auth.oauthServer.getDiscovery();
    const jwks = await client.auth.oauthServer.getJwks();
    const authorizeUrl = await client.auth.oauthServer.buildAuthorizeUrl({
      clientId: "client_1",
      redirectUri: "https://app.example.com/callback",
      scope: ["openid", "email"],
      state: "state_1",
      codeChallenge: "challenge_1",
      codeChallengeMethod: "S256",
      nonce: "nonce_1",
      resource: "https://api.example.com",
    });
    await client.auth.oauthClients.list();
    await client.auth.oauthClients.create({
      redirect_uris: ["https://app.example.com/callback"],
      client_name: "App",
      client_type: "public",
      token_endpoint_auth_method: "none",
    });
    await client.auth.oauthClients.get("client_1");
    await client.auth.oauthClients.update("client_1", { client_name: "App 2" });
    await client.auth.oauthClients.regenerateSecret("client_1");
    await client.auth.oauthClients.delete("client_1");

    expect(status.account_isolated).toBe(true);
    expect(status.signing_alg).toBe("ES256");
    expect(status.oidc_id_token_ready).toBe(true);
    expect(discovery.issuer).toBe(statusPayload.issuer);
    expect(jwks).toMatchObject({ keys: [] });

    const authUrl = new URL(authorizeUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(statusPayload.authorization_endpoint);
    expect(authUrl.searchParams.get("client_id")).toBe("client_1");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(authUrl.searchParams.get("scope")).toBe("openid email");
    expect(authUrl.searchParams.get("state")).toBe("state_1");
    expect(authUrl.searchParams.get("code_challenge")).toBe("challenge_1");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("nonce")).toBe("nonce_1");
    expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com");

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/auth/oauth-server");
    expect(calls[0]?.init?.headers instanceof Headers || typeof calls[0]?.init?.headers === "object").toBe(true);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer token-123");
    expect(calls.some((call) => call.url.endsWith("/auth/oauth-server/migrate"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/auth/oauth-clients"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/auth/oauth-clients/client_1"))).toBe(true);
  });

  test("supauth builds management-api provisioning requests with bearer auth", async () => {
    const { supabase } = createFakeSupabase();
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });

      if (url.endsWith("/client-config")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projectRef: "proj_1",
              supabaseUrl: "https://api.example.com",
              authUrl: "https://api.example.com/auth/v1",
              restUrl: "https://api.example.com/rest/v1",
              storageUrl: "https://api.example.com/storage/v1",
              realtimeUrl: "wss://api.example.com/realtime/v1",
              functionsUrl: "https://api.example.com/functions/v1",
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }

      if (url.endsWith("/verify")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projectRef: "proj_1",
              healthy: true,
              checks: [{ name: "gotrue", status: "pass" }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({ projectRef: "proj_1", status: "succeeded", changed: true }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com/",
      projectRef: "proj_1",
    });

    await client.supauth.provision({
      authDomain: "auth.example.com",
      apiDomain: "api.example.com",
      adminMode: "sso",
      storageBuckets: [{ id: "avatars", public: true }],
    });
    await client.supauth.reconcile({ dryRun: true });
    await client.supauth.rollback();
    await client.supauth.getClientConfig();
    await client.supauth.verify();

    expect(calls[0]?.url).toBe("https://admin.example.com/v1/projects/proj_1/supauth/provision");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      authDomain: "auth.example.com",
      apiDomain: "api.example.com",
      adminMode: "sso",
      storageBuckets: [{ id: "avatars", public: true }],
    });
    expect(calls[1]?.url).toBe("https://admin.example.com/v1/projects/proj_1/supauth/reconcile");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ dryRun: true });
    expect(calls[2]?.url).toBe("https://admin.example.com/v1/projects/proj_1/supauth/rollback");
    expect(calls[2]?.init?.method).toBe("POST");
    expect(calls[2]?.init?.body).toBe(undefined);
    expect(calls[3]?.url).toBe("https://admin.example.com/v1/projects/proj_1/supauth/client-config");
    expect(calls[3]?.init?.method).toBe("GET");
    expect(calls[4]?.url).toBe("https://admin.example.com/v1/projects/proj_1/supauth/verify");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer token-123");
  });

  test("wait polls until a terminal task status is reached", async () => {
    const { supabase } = createFakeSupabase();
    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running" })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed" });

    const task = await client.tasks.wait("tsk_123");

    expect(task.status).toBe("completed");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  test("subscribe falls back to polling on channel error", async () => {
    const { supabase, channelInstance, removeChannel } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: string[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10 })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", progress: 100 });

    let subscribeHandler:
      | ((status: string, error?: unknown) => void | Promise<void>)
      | undefined;

    channelInstance.subscribe.mockImplementation((...args: unknown[]) => {
      const [handler] = args as [((status: string, error?: unknown) => void | Promise<void>)?];
      subscribeHandler = handler;
      return channelInstance;
    });

    const subscription = client.tasks.subscribe("tsk_123", {
      onUpdate(snapshot) {
        snapshots.push(String(snapshot.status));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await subscribeHandler?.("CHANNEL_ERROR", new Error("realtime down"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("polling");
    expect(snapshots).toContain("completed");
    expect(removeChannel).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    expect(getSpy).toHaveBeenCalled();
  });

  test("subscribe falls back to polling when realtime does not connect in time", async () => {
    const { supabase, channelInstance, removeChannel } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: string[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10 })
      .mockResolvedValueOnce({ id: "tsk_123", status: "completed", progress: 100 });

    channelInstance.subscribe.mockImplementation(() => channelInstance);

    const subscription = client.tasks.subscribe("tsk_123", {
      realtimeTimeoutMs: 1,
      onUpdate(snapshot) {
        snapshots.push(String(snapshot.status));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("polling");
    expect(snapshots).toContain("completed");
    expect(removeChannel).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    expect(getSpy).toHaveBeenCalled();
  });

  test("subscribe reconciles while realtime is connected", async () => {
    const { supabase, channelInstance } = createFakeSupabase();
    const states: string[] = [];
    const snapshots: number[] = [];

    const client = createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj_1",
      pollingIntervalMs: 1,
    });

    const getSpy = spyOn(client.tasks, "get")
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 10 })
      .mockResolvedValueOnce({ id: "tsk_123", status: "running", progress: 20 });

    let subscribeHandler:
      | ((status: string, error?: unknown) => void | Promise<void>)
      | undefined;

    channelInstance.subscribe.mockImplementation((...args: unknown[]) => {
      const [handler] = args as [((status: string, error?: unknown) => void | Promise<void>)?];
      subscribeHandler = handler;
      return channelInstance;
    });

    const subscription = client.tasks.subscribe("tsk_123", {
      reconcileIntervalMs: 1,
      stopOnTerminal: false,
      onUpdate(snapshot) {
        snapshots.push(Number(snapshot.progress));
      },
      onStateChange(state) {
        states.push(state);
      },
    });

    await subscribeHandler?.("SUBSCRIBED");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(states).toContain("realtime");
    expect(snapshots).toContain(10);
    expect(snapshots).toContain(20);
    expect(getSpy.mock.calls.length >= 2).toBe(true);

    subscription.unsubscribe();
  });
});
