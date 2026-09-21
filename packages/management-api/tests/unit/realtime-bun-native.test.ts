// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { jwtVerify, SignJWT } from "jose";
import { RealtimeBunService } from "../../src/services/realtime-bun.service";
import type { ChangeEvent } from "../../src/utils/realtime-change";
import { withNativePostgres, waitForPostgresFixture as until } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native subscriptions filter INSERT rows through RLS, share one listener and clean up",
  async () => withNativePostgres(async (database) => {
    await database.unsafe(`
      CREATE SCHEMA realtime;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE TABLE public.orders (id integer PRIMARY KEY, owner text NOT NULL, body text NOT NULL);
      ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.orders TO anon, authenticated;
      CREATE POLICY orders_visible ON public.orders FOR SELECT TO authenticated
        USING (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));
    `);
    const key = new TextEncoder().encode("synthetic-realtime-fixture-signing-key");
    const token = (role: string, sub: string) => new SignJWT({ role })
      .setProtectedHeader({ alg: "HS256" }).setSubject(sub).setJti(crypto.randomUUID())
      .setIssuedAt().setExpirationTime("5m").sign(key);
    const [tokenA, tokenB, serviceToken] = await Promise.all([
      token("authenticated", "a"), token("authenticated", "b"), token("service_role", "service"),
    ]);
    const databasePending = Promise.withResolvers<void>();
    const databaseStarted = Promise.withResolvers<void>();
    const abort = new AbortController();
    const cancelledService = new RealtimeBunService({
      resolveDatabase: async () => { databaseStarted.resolve(); await databasePending.promise; return database; },
      verifyJwt: async (_ref, token) => ({ ...await jwtVerify(token, key), isServiceRole: false }),
    });
    const cancelled = cancelledService.subscribeTenant("fixture", [
      { event: "*", schema: "public", table: "orders" },
    ], tokenA, { signal: abort.signal });
    await databaseStarted.promise;
    abort.abort();
    databasePending.resolve();
    expect(await cancelled).toBeNull();
    const functions: unknown = await database`
      SELECT 1 FROM pg_proc WHERE proname = 'realtime_supacloud_notify'
    `;
    expect(Array.isArray(functions) && functions.length === 0).toBe(true);
    await cancelledService.unsubscribeTenant("fixture");
    const pendingToken = await token("authenticated", "b");
    const verification = Promise.withResolvers<void>();
    const service = new RealtimeBunService({
      resolveDatabase: async () => database,
      verifyJwt: async (_ref, token) => {
        if (token === pendingToken) await verification.promise;
        const result = await jwtVerify(token, key, { algorithms: ["HS256"] });
        return { ...result, isServiceRole: token === serviceToken };
      },
    });
    const a: ChangeEvent[] = [];
    const b: ChangeEvent[] = [];
    const all: ChangeEvent[] = [];
    try {
      const [idA, idB, idService] = await Promise.all([
        service.subscribeTenant("fixture", [{ event: "INSERT", schema: "public", table: "orders", filter: "id=gte.2" }], tokenA),
        service.subscribeTenant("fixture", [{ event: "INSERT", schema: "public", table: "orders" }], tokenB),
        service.subscribeTenant("fixture", [{ event: "*", schema: "public", table: "orders" }], serviceToken),
      ]);
      if (!idA || !idB || !idService) throw new Error("Native subscription setup failed");
      service.events.on(`change:${idA}`, (event) => a.push(event));
      service.events.on(`change:${idB}`, (event) => b.push(event));
      service.events.on(`change:${idService}`, (event) => all.push(event));
      const listeners: unknown = await database`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND query ILIKE 'LISTEN %'
      `;
      expect(Array.isArray(listeners) ? listeners.length : 0).toBe(1);

      await database.unsafe("INSERT INTO public.orders VALUES (1, 'a', 'filtered'), (10, 'a', 'visible a'), (20, 'b', 'visible b')");
      await until(async () => all.length === 3 && a.length === 1 && b.length === 1);
      expect(a.map((event) => event.data.record)).toEqual([{ id: 10, owner: "a", body: "visible a" }]);
      expect(b.map((event) => event.data.record)).toEqual([{ id: 20, owner: "b", body: "visible b" }]);
      expect(all.map((event) => event.data.record.id).sort()).toEqual([1, 10, 20]);
      await database.notify("realtime_changes", "null");
      await database.notify("realtime_changes", JSON.stringify({ payload: { ...all[0]?.data, columns: [null] } }));
      await database.unsafe("INSERT INTO public.orders VALUES (30, 'a', 'still usable')");
      await until(async () => all.length === 4 && a.length === 2);
      expect(b).toHaveLength(1);

      service.unsubscribeSubscription("fixture", idA);
      await database.unsafe("INSERT INTO public.orders VALUES (40, 'a', 'after unsubscribe')");
      await until(async () => all.length === 5);
      expect(a).toHaveLength(2);
      expect(await service.subscribeTenant("fixture", [
        { event: "*", schema: "public", table: "orders" },
      ], await token("service_role", "unprivileged"))).toBeNull();

      const pending = service.subscribeTenant("fixture", [{ event: "*", schema: "public", table: "orders" }], pendingToken);
      service.unsubscribeSubscription("fixture", idB);
      service.unsubscribeSubscription("fixture", idService);
      verification.resolve();
      const replacement = await pending;
      if (!replacement) throw new Error("Last unsubscribe cancelled another connection's authentication");
      const next: ChangeEvent[] = [];
      service.events.on(`change:${replacement}`, (event) => next.push(event));
      await database.unsafe("INSERT INTO public.orders VALUES (50, 'b', 'pending connection survived')");
      await until(async () => next.length === 1);
      expect(next[0]?.data.record.id).toBe(50);
    } finally {
      await service.unsubscribeTenant("fixture");
    }
    await until(async () => {
      const listeners: unknown = await database`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND query ILIKE 'LISTEN %'
      `;
      return Array.isArray(listeners) && listeners.length === 0;
    });
  }),
  40_000,
);

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native realtime hides unreadable columns and historical owner data",
  async () => withNativePostgres(async (database) => {
    await database.unsafe(`
      CREATE SCHEMA realtime;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE TABLE public.orders (id integer, owner text, body text, secret text, PRIMARY KEY (id) INCLUDE (secret));
      ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
      GRANT SELECT (id, owner, body) ON public.orders TO authenticated;
      CREATE POLICY visible_orders ON public.orders FOR SELECT TO authenticated
        USING (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub'));
    `);
    const key = new TextEncoder().encode("synthetic-realtime-column-signing-key");
    const token = await new SignJWT({ role: "authenticated" }).setSubject("b")
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key);
    const observerToken = await new SignJWT({ role: "service_role" }).setSubject("observer")
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key);
    const service = new RealtimeBunService({
      resolveDatabase: async () => database,
      verifyJwt: async (_ref, token) => ({ ...await jwtVerify(token, key), isServiceRole: token === observerToken }),
    });
    const received: ChangeEvent[] = [];
    const filtered: ChangeEvent[] = [];
    const observed: ChangeEvent[] = [];
    try {
      const id = await service.subscribeTenant("fixture", [{ event: "*", schema: "public", table: "orders" }], token);
      const filterId = await service.subscribeTenant("fixture", [{
        event: "*", schema: "public", table: "orders", filter: "secret=eq.secret-b",
      }], token);
      if (!id || !filterId) throw new Error("Native fixture subscription failed");
      const observer = await service.subscribeTenant("fixture", [{ event: "*", schema: "public", table: "orders" }], observerToken);
      if (!observer) throw new Error("Missing observer");
      service.events.on(`change:${id}`, (event) => received.push(event));
      service.events.on(`change:${filterId}`, (event) => filtered.push(event));
      service.events.on(`change:${observer}`, (event) => observed.push(event));
      await database.unsafe("INSERT INTO public.orders VALUES (1, 'a', 'private-a', 'secret-a')");
      await database.unsafe("UPDATE public.orders SET owner = 'b', body = 'visible-b', secret = 'secret-b' WHERE id = 1");
      await until(async () => observed.length === 2);
      expect(received).toHaveLength(1);
      expect(received[0]?.data.record).toEqual({ id: 1, owner: "b", body: "visible-b" });
      expect(received[0]?.data.old_record).toEqual({ id: 1 });
      expect(received[0]?.data.columns.map((column) => column.name)).toEqual(["id", "owner", "body"]);
      expect(filtered).toEqual([]);
      await database.begin(async (tx) => {
        await tx`DELETE FROM public.orders WHERE id = 1`;
        await tx`INSERT INTO public.orders VALUES (1, 'b', 'replacement-b', 'secret-replacement')`;
      });
      await until(async () => observed.length === 4);
      expect(received.map((event) => event.data.type)).toEqual(["UPDATE", "INSERT"]);
      expect(received[1]?.data.record).toEqual({ id: 1, owner: "b", body: "replacement-b" });
    } finally {
      await service.unsubscribeTenant("fixture");
    }
  }),
  40_000,
);
