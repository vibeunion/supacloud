import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { firstValueFrom } from "rxjs";
import { createSupaCloudClient, type SupaCloudTaskSubscribeOptions, type SupaCloudTaskSnapshot } from "./index";
import { observeQuery, observeTask } from "./reactive";

test("query factory is lazy, each subscription is fresh, and the response envelope is preserved", async () => {
  let calls = 0;
  const response = { data: [{ id: "one" }], error: null, count: 1, status: 200 };
  const source = observeQuery(() => { calls++; return Promise.resolve(response); });
  expect(calls).toBe(0);
  expect(await firstValueFrom(source)).toBe(response);
  expect(await firstValueFrom(source)).toBe(response);
  expect(calls).toBe(2);
});

test("real SupaCloud client retains its native Supabase builder and PromiseLike transport", async () => {
  type Database = { public: { Tables: { widgets: {
    Row: { id: string; label: string }; Insert: { id: string; label: string };
    Update: { label?: string }; Relationships: [];
  } }; Views: {}; Functions: {}; Enums: {}; CompositeTypes: {} } };
  let calls = 0;
  const supabase = createClient<Database>("https://project.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      calls++;
      expect(String(input).includes("/rest/v1/widgets")).toBe(true);
      if (calls === 1) expect(init?.signal instanceof AbortSignal).toBe(true);
      return Response.json([{ id: "one", label: "first" }], {
        headers: { "content-range": "0-0/1" },
      });
    } },
  });
  const client = createSupaCloudClient({ supabase, projectRef: "project-a", managementApiUrl: "https://management.example.test" });
  expect(client.supabase).toBe(supabase);
  const source = observeQuery(signal => client.supabase.from("widgets").select("id,label", { count: "exact" }).abortSignal(signal));
  expect(calls).toBe(0);
  const result = await firstValueFrom(source);
  // Compile-time proof: selected database rows were not widened to unknown/any by the bridge.
  const typed: { id: string; label: string }[] | null = result.data;
  expect(typed).toEqual([{ id: "one", label: "first" }]);
  expect(result.count).toBe(1);
  const original = await client.supabase.from("widgets").select("id,label");
  expect(original.error).toBe(null);
  expect(calls).toBe(2);
});

test("resolved SDK error envelopes and rejected/synchronously thrown errors keep identity without retry", async () => {
  const failure = { message: "not authorized", code: "42501" };
  let calls = 0;
  const source = observeQuery(() => { calls++; return Promise.resolve({ data: null, error: failure }); });
  let actual: unknown;
  try { await firstValueFrom(source); } catch (error) { actual = error; }
  expect(actual).toBe(failure);
  expect(calls).toBe(1);
  for (const query of [
    () => Promise.reject(failure),
    () => { throw failure; },
  ]) {
    actual = undefined;
    try { await firstValueFrom(observeQuery(query)); } catch (error) { actual = error; }
    expect(actual).toBe(failure);
  }
});

test("unsubscribe aborts cooperative I/O and suppresses late results", async () => {
  let signal: AbortSignal | undefined;
  let settle: ((value: { data: number; error: null }) => void) | undefined;
  let values = 0;
  const source = observeQuery(current => {
    signal = current;
    return new Promise<{ data: number; error: null }>(resolve => { settle = resolve; });
  });
  const sub = source.subscribe({ next: () => { values++; } });
  sub.unsubscribe();
  expect(signal?.aborted).toBe(true);
  settle?.({ data: 1, error: null });
  await Promise.resolve();
  expect(values).toBe(0);
});

test("an aborted owner does not invoke the query and abort after start completes once", () => {
  const owner = new AbortController();
  let calls = 0, completes = 0;
  const source = observeQuery(() => {
    calls++;
    return new Promise<{ error: null }>(() => {});
  }, { signal: owner.signal });
  source.subscribe({ complete: () => { completes++; } });
  owner.abort();
  source.subscribe();
  expect(calls).toBe(1);
  expect(completes).toBe(1);
});

test("task observation preserves result typing, completes on SDK close and never mutates the task", () => {
  type Result = { total: number };
  let callbacks: SupaCloudTaskSubscribeOptions<Result> | undefined;
  let starts = 0, stops = 0, mutations = 0, completes = 0;
  const task = {
    cancel: () => { mutations++; }, retry: () => { mutations++; },
    subscribe(options: SupaCloudTaskSubscribeOptions<Result>) {
      starts++; callbacks = options;
      return { connectionState: "polling" as const, unsubscribe: () => { stops++; } };
    },
  };
  const values: SupaCloudTaskSnapshot<Result>[] = [];
  const source = observeTask(task);
  expect(starts).toBe(0);
  source.subscribe({ next: value => values.push(value), complete: () => { completes++; } });
  const snapshot: SupaCloudTaskSnapshot<Result> = {
    id: "task-1", status: "completed", raw: { id: "task-1", project_ref: "project-a", status: "completed", result: { total: 7 } },
  };
  callbacks?.onUpdate(snapshot);
  callbacks?.onStateChange?.("closed");
  expect(values[0]?.raw.result?.total).toBe(7);
  expect(completes).toBe(1);
  expect(stops).toBe(1);
  expect(mutations).toBe(0);
});

test("task handles returned after synchronous close or error are still released once", () => {
  for (const fail of [false, true]) {
    let stops = 0;
    const failure = new Error("decoder failed");
    let actual: unknown;
    const task = {
      subscribe(options: SupaCloudTaskSubscribeOptions) {
        if (fail) options.onError?.(failure);
        else options.onStateChange?.("closed");
        return { connectionState: "closed" as const, unsubscribe: () => { stops++; } };
      },
    };
    observeTask(task).subscribe({ error: error => { actual = error; } });
    expect(stops).toBe(1);
    expect(actual).toBe(fail ? failure : undefined);
  }
});

test("task owner cancellation releases only its own subscription; pre-aborted owners do not subscribe", () => {
  let starts = 0, stops = 0;
  const task = { subscribe(_options: SupaCloudTaskSubscribeOptions) {
    starts++;
    return { connectionState: "polling" as const, unsubscribe: () => { stops++; } };
  } };
  const first = new AbortController(), second = new AbortController();
  observeTask(task, { signal: first.signal }).subscribe();
  const other = observeTask(task, { signal: second.signal }).subscribe();
  first.abort();
  observeTask(task, { signal: first.signal }).subscribe();
  expect(starts).toBe(2);
  expect(stops).toBe(1);
  expect(other.closed).toBe(false);
  other.unsubscribe();
  expect(stops).toBe(2);
});

test("Realtime fallback is not treated as a task failure", () => {
  let stops = 0;
  const task = { subscribe(options: SupaCloudTaskSubscribeOptions) {
    options.onStateChange?.("polling", { error: new Error("Realtime unavailable") });
    return { connectionState: "polling" as const, unsubscribe: () => { stops++; } };
  } };
  const sub = observeTask(task).subscribe();
  expect(sub.closed).toBe(false);
  sub.unsubscribe();
  expect(stops).toBe(1);
});

test("SDK reactive entry is browser-safe; ordinary SDK entry does not import RxJS", async () => {
  for (const reactive of [true, false]) {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL(reactive ? "./reactive.ts" : "./index.ts", import.meta.url))],
      target: "browser", metafile: true, external: ["@supabase/supabase-js", "@supacloud/contracts"],
    });
    expect(build.success).toBe(true);
    if (!build.metafile) throw new Error("Missing dependency graph");
    const inputs = Object.keys(build.metafile.inputs);
    expect(inputs.some(path => /rxjs/.test(path))).toBe(reactive);
    expect(inputs.some(path => /angular|node:async_hooks|\/compiler\//.test(path))).toBe(false);
    if (reactive) expect(inputs.some(path => path.endsWith("supacloud-js/src/index.ts"))).toBe(false);
  }
});
