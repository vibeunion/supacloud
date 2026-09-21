// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createClient } from "@supabase/supabase-js";
import { jwtVerify, SignJWT } from "jose";
import { RealtimeBunService } from "../../src/services/realtime-bun.service";
import { wsRoutes, realtimeProxyDependencies, connectRealtimeUpstream } from "../../src/routes/ws";
import { parsePhoenixMessage, encodePhoenixMessage } from "../../src/utils/phoenix-message";
import { parsePostgresChangeSubscriptions } from "../../src/utils/realtime-change";
import { withNativePostgres, waitForPostgresFixture as until } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "official SDK crosses real WebSockets, binds subscription IDs and refreshes native PostgreSQL RLS identity",
  async () => withNativePostgres(async (database) => {
    await database.unsafe(`
      CREATE SCHEMA realtime;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE TABLE public.orders (id integer PRIMARY KEY, owner text NOT NULL);
      ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.orders TO authenticated;
      CREATE POLICY visible_orders ON public.orders FOR SELECT TO authenticated
        USING (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));
    `);
    const key = new TextEncoder().encode("synthetic-websocket-integration-signing-key");
    const sign = (sub: string) => new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(key);
    const [tokenA, tokenB] = await Promise.all([sign("a"), sign("b")]);
    const backend = new RealtimeBunService({
      resolveDatabase: async () => database,
      verifyJwt: async (_ref, token) => ({ ...await jwtVerify(token, key), isServiceRole: false }),
    });
    const upstreamRequests: Array<{ host: string | null; ref: string | null; apikey: string | null }> = [];
    const forwardedTokens: unknown[] = [];
    const delegatedDeliveries: Array<() => void> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        upstreamRequests.push({
          host: request.headers.get("host"), ref: request.headers.get("x-project-ref"),
          apikey: new URL(request.url).searchParams.get("apikey"),
        });
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        message(socket, raw) {
          const message = parsePhoenixMessage(raw);
          if (!message) return;
          if (message.event === "access_token") { forwardedTokens.push(message.payload.access_token); return; }
          const config = message.payload.config;
          const changes = config && typeof config === "object" && "postgres_changes" in config
            ? parsePostgresChangeSubscriptions(config.postgres_changes) : null;
          const mappings = changes?.map(({ select: _select, ...subscription }, index) => ({
            ...subscription, table: subscription.table ?? null, filter: subscription.filter ?? "", id: index + 101,
          }));
          socket.send(encodePhoenixMessage({
            ...message, event: "phx_reply",
            payload: { status: "ok", response: mappings ? { postgres_changes: mappings } : {} },
          }, "2.0.0"));
          if (message.event === "phx_join" && changes?.some((subscription) => subscription.table === undefined)) {
            delegatedDeliveries.push(() => socket.send(encodePhoenixMessage({
              ...message, ref: null, event: "postgres_changes", payload: {
                ids: mappings?.map((mapping) => mapping.id),
                data: { type: "INSERT", schema: "public", table: "orders", record: { id: 99, owner: "fixture" },
                  columns: [{ name: "id", type: "int4" }, { name: "owner", type: "text" }],
                  commit_timestamp: "2026-09-08T00:00:00Z", errors: [] },
              },
            }, "2.0.0")));
          }
        },
      },
    });
    const originalBackend = realtimeProxyDependencies.backend;
    realtimeProxyDependencies.backend = backend;
    const keySpy = spyOn(realtimeProxyDependencies, "resolveKey").mockResolvedValue({
      ref: "fixture", kind: "publishable", role: "anon", upstreamKey: tokenA,
    });
    const connectSpy = spyOn(realtimeProxyDependencies, "connect").mockImplementation((ref, token, vsn, callbacks) => {
      const url = new URL(`ws://127.0.0.1:${upstream.port}/socket/websocket`);
      url.searchParams.set("apikey", token);
      url.searchParams.set("vsn", vsn);
      return connectRealtimeUpstream(url, { host: `${ref}.api.example.test`, "x-project-ref": ref }, callbacks);
    });
    const app = new Elysia().use(wsRoutes).listen({ hostname: "127.0.0.1", port: 0 });
    const port = app.server?.port;
    if (!port) throw new Error("Missing fixture port");
    const client = createClient(`http://127.0.0.1:${port}/ws`, "opaque-fixture-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const received: unknown[] = [];
    const idsOnly: unknown[] = [];
    const ownersOnly: unknown[] = [];
    let subscribed = false;
    const failures: string[] = [];
    try {
      const channel = client.channel("orders")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => received.push(payload))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders", select: ["id"] }, (payload) => idsOnly.push(payload.new))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders", select: ["owner"] }, (payload) => ownersOnly.push(payload.new))
        .subscribe((status, error) => {
          if (status === "SUBSCRIBED") subscribed = true;
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") failures.push(`${status}: ${error?.message ?? ""}`);
        });
      await until(async () => subscribed || failures.length > 0);
      expect(failures).toEqual([]);
      expect(upstreamRequests).toEqual([{ host: "fixture.api.example.test", ref: "fixture", apikey: tokenA }]);
      await database.unsafe("INSERT INTO public.orders VALUES (1, 'a'), (2, 'b')");
      await until(async () => received.length === 1 && idsOnly.length === 1 && ownersOnly.length === 1);
      expect(received).toMatchObject([{ eventType: "INSERT", new: { id: 1, owner: "a" } }]);
      expect(idsOnly).toEqual([{ id: 1 }]);
      expect(ownersOnly).toEqual([{ owner: "a" }]);
      await client.realtime.setAuth(tokenB);
      await until(async () => forwardedTokens.includes(tokenB));
      await database.unsafe("INSERT INTO public.orders VALUES (3, 'a'), (4, 'b')");
      await until(async () => received.length === 2 && idsOnly.length === 2 && ownersOnly.length === 2);
      expect(received[1]).toMatchObject({ eventType: "INSERT", new: { id: 4, owner: "b" } });
      expect(idsOnly[1]).toEqual({ id: 4 });
      expect(ownersOnly[1]).toEqual({ owner: "b" });
      expect(await client.removeChannel(channel)).toBe("ok");
      await until(async () => {
        const rows: unknown = await database`SELECT 1 FROM pg_stat_activity WHERE query ILIKE 'LISTEN %'`;
        return Array.isArray(rows) && rows.length === 0;
      });

      const delegated: unknown[] = [];
      let delegatedReady = false;
      const wildcard = client.channel("all-orders")
        .on("postgres_changes", { event: "INSERT", schema: "public", select: ["id"] }, (payload) => delegated.push(payload.new))
        .subscribe((status, error) => {
          if (status === "SUBSCRIBED") delegatedReady = true;
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") failures.push(`${status}: ${error?.message ?? ""}`);
        });
      await until(async () => delegatedReady || failures.length > 0);
      expect(failures).toEqual([]);
      expect(delegatedDeliveries).toHaveLength(1);
      delegatedDeliveries[0]?.();
      await until(async () => delegated.length === 1);
      expect(delegated).toEqual([{ id: 99 }]);
      expect(await client.removeChannel(wildcard)).toBe("ok");
    } finally {
      client.realtime.disconnect();
      await app.stop(true);
      upstream.stop(true);
      await backend.unsubscribeTenant("fixture");
      keySpy.mockRestore();
      connectSpy.mockRestore();
      realtimeProxyDependencies.backend = originalBackend;
    }
  }),
  40_000,
);
