import { expect, test } from "bun:test";
import { postgresChangesFilter } from "@supabase/realtime-js";
import {
  matchesRealtimeFilter, parsePostgresChangeSubscriptions, parseRealtimeChange, parseWalChanges,
  bindRealtimeSubscriptionIds, canUseNativeRealtimeSubscriptions, projectRealtimeChangeEvents,
  type RealtimeChange, type PostgresChangeConfig,
} from "../../src/utils/realtime-change";
import { parseRealtimeFilter } from "../../src/utils/realtime-filter-contract";

const change = {
  type: "INSERT", schema: "public", table: "orders",
  record: { id: 1, total: 10 }, columns: [{ name: "id", type: "int4" }],
  commit_timestamp: "2026-09-08T12:00:00Z",
} satisfies RealtimeChange;

test("normalizes direct and wrapped notifications without fabricating an event kind", () => {
  expect(parseRealtimeChange(change)).toEqual(change);
  expect(parseRealtimeChange({ event: "postgres_changes", payload: change })).toEqual(change);
  expect(parseRealtimeChange({ schema: "public", table: "orders", record: {} })).toBeNull();
  expect(parseRealtimeChange({
    event: "UPDATE", schema: "public", table: "orders", new: { total: 1.5 }, old: { total: 1 },
  })).toMatchObject({
    type: "UPDATE", record: { total: 1.5 }, old_record: { total: 1 },
    columns: [{ name: "total", type: "numeric" }],
  });
});

test.each([
  null, [], "data", { payload: null }, { ...change, table: 1 }, { ...change, record: [] },
  { ...change, old_record: "old" }, { ...change, type: "TRUNCATE" },
  { ...change, columns: [{ name: "id", type: "int4" }, null] },
  { ...change, columns: [{ name: "id", type: 1 }] },
  { ...change, columns: { id: true } },
  { ...change, commit_timestamp: "not-a-date" },
  { ...change, type: "DELETE", record: null, old_record: null },
].map((value) => ({ value })))("rejects invalid realtime event %#", ({ value }) => {
  expect(parseRealtimeChange(value)).toBeNull();
});

test("retains DELETE identity without requiring a new record", () => {
  expect(parseRealtimeChange({ ...change, type: "DELETE", record: null, old_record: { id: 1 } }))
    .toEqual({ ...change, type: "DELETE", record: {}, old_record: { id: 1 } });
});

const walEntry = {
  kind: "insert", schema: "public", table: "orders",
  columnnames: ["id", "__proto__"], columntypes: ["integer", "text"], columnvalues: [1, "value"],
};

test("decodes every WAL transaction entry and preserves prototype-named columns as data", () => {
  const result = parseWalChanges({
    timestamp: "2026-09-08 12:00:00+00",
    change: [
      walEntry,
      { kind: "delete", schema: "public", table: "orders", oldkeys: { keynames: ["id"], keyvalues: [2] } },
    ],
  });
  expect(result).toHaveLength(2);
  expect(result?.map((entry) => entry.type)).toEqual(["INSERT", "DELETE"]);
  expect(result?.[0]?.record["__proto__"]).toBe("value");
  expect(Object.getPrototypeOf(result?.[0]?.record)).toBe(Object.prototype);
  expect(result?.[1]?.old_record).toEqual({ id: 2 });
  expect(result?.[0]?.commit_timestamp).toBe("2026-09-08 12:00:00+00");
});

test.each([
  { ...walEntry, columnvalues: [1] },
  { ...walEntry, columnnames: ["id", "id"] },
  { ...walEntry, columntypes: ["integer"] },
  { ...walEntry, columntypes: ["integer", 1] },
  { ...walEntry, oldkeys: { keynames: ["id"], keyvalues: [] } },
  { ...walEntry, kind: "unknown" },
  null,
].map((entry) => ({ entry })))("rejects malformed WAL batches atomically %#", ({ entry }) => {
  expect(parseWalChanges({ change: [walEntry, entry] })).toBeNull();
});

test("filters numbers numerically, booleans strictly and literal strings without coercing objects", () => {
  expect(matchesRealtimeFilter("total=gt.2", { total: 10 })).toBe(true);
  expect(matchesRealtimeFilter("total=lt.2", { total: 10 })).toBe(false);
  expect(matchesRealtimeFilter("total=gte.1e1", { total: 10 })).toBe(true);
  expect(matchesRealtimeFilter("total=gt.2junk", { total: 10 })).toBe(false);
  expect(matchesRealtimeFilter("active=eq.true", { active: true })).toBe(true);
  expect(matchesRealtimeFilter("active=eq.1", { active: true })).toBe(false);
  expect(matchesRealtimeFilter("value=eq.a=b", { value: "a=b" })).toBe(true);
  expect(matchesRealtimeFilter("value=eq.[object Object]", { value: {} })).toBe(false);
  expect(matchesRealtimeFilter("constructor=neq.foo", {})).toBe(false);
});

test("LIKE treats regexp syntax literally, anchors the match and supports SQL wildcards", () => {
  expect(matchesRealtimeFilter("name=like.a.b", { name: "axb" })).toBe(false);
  expect(matchesRealtimeFilter("name=like.a.b", { name: "a.b" })).toBe(true);
  expect(matchesRealtimeFilter("name=like.[", { name: "[" })).toBe(true);
  expect(matchesRealtimeFilter("name=like.foo", { name: "xfoox" })).toBe(false);
  expect(matchesRealtimeFilter("name=ilike.F%_", { name: "foo" })).toBe(true);
  expect(matchesRealtimeFilter("name=like.100\\%", { name: "100%" })).toBe(true);
  expect(matchesRealtimeFilter("name=like.100\\%", { name: "100items" })).toBe(false);
  expect(matchesRealtimeFilter(`name=like.${"%a".repeat(100)}b`, { name: "a".repeat(1000) })).toBe(false);
});

test("IN handles quoted commas, quotes and significant whitespace without partial parsing", () => {
  expect(matchesRealtimeFilter('name=in.("a,b"," x ","a\\"b")', { name: "a,b" })).toBe(true);
  expect(matchesRealtimeFilter('name=in.("a,b"," x ","a\\"b")', { name: " x " })).toBe(true);
  expect(matchesRealtimeFilter('name=in.("a,b"," x ","a\\"b")', { name: 'a"b' })).toBe(true);
  expect(matchesRealtimeFilter("total=in.(1,10,20)", { total: 10 })).toBe(true);
  expect(matchesRealtimeFilter('name=in.("a"b)', { name: "ab" })).toBe(false);
  expect(matchesRealtimeFilter("name=in.a,b", { name: "a" })).toBe(false);
});

test.each([
  null, [], [{}], [{ event: "INSERT", schema: "public", table: "bad\0sql" }],
  [{ event: "*", schema: "public", table: "x".repeat(64) }],
  [{ event: "*", schema: "public", select: ["id", "id"] }],
  [{ event: "bad", schema: "public" }], [{ event: "*", schema: "public", id: {} }],
  [{ event: "*", schema: "public", filter: "id=unknown.1" }],
  [{ event: "*", schema: "public", filter: 'id=in.("broken)' }],
  [{ event: "*", schema: "public", filter: `id=eq.${"x".repeat(512)}` }],
].map((value) => ({ value })))("rejects malformed subscriptions before use %#", ({ value }) => {
  expect(parsePostgresChangeSubscriptions(value)).toBeNull();
});

test("subscription parsing copies fields and preserves numeric zero IDs", () => {
  const source = { event: "*", schema: "public", table: "orders", id: 0 } satisfies PostgresChangeConfig;
  const result = parsePostgresChangeSubscriptions([source]);
  expect(result).toEqual([source]);
  source.table = "changed";
  expect(result?.[0]?.table).toBe("orders");
  expect(Object.hasOwn(result?.[0] ?? {}, "filter")).toBe(false);
});

test("wildcards, quoted identifiers and optional echoes are delegated without SQL interpolation", () => {
  for (const schema of ["*", "public", "quoted schema"]) {
    for (const table of [undefined, null, "", "*", "bad;sql", 'a"b', "表"]) {
      const subscriptions = parsePostgresChangeSubscriptions([{ event: "*", schema, table, filter: null }]);
      expect(subscriptions).not.toBeNull();
      if (!subscriptions) throw new Error("Expected valid subscription");
      expect(canUseNativeRealtimeSubscriptions(subscriptions)).toBe(false);
      expect(subscriptions[0]?.filter).toBeUndefined();
    }
  }
});

test("installed SDK filter strings retain PostgREST quoting rather than JSON escape semantics", () => {
  const values = ["a,b", 'a"b', "\\n", "line\nbreak,", "\ttext\t", "a(b)", " x "];
  for (const value of values) {
    const scalar = postgresChangesFilter().eq("name", value).build();
    const list = postgresChangesFilter().in("name", [value, "other"]).build();
    expect(parseRealtimeFilter(scalar)).toHaveLength(1);
    expect(parseRealtimeFilter(list)).toHaveLength(1);
    expect(matchesRealtimeFilter(list, { name: value })).toBe(true);
    expect(canUseNativeRealtimeSubscriptions([{ event: "*", schema: "public", table: "orders", filter: scalar }])).toBe(false);
  }
  const compound = postgresChangesFilter().eq("id", 1).not("state", "in", ["a,b", "c"])
    .is("deleted", null).match("name", "(a|b)").imatch("owner", "x").isDistinct("total", null).build();
  expect(parseRealtimeFilter(compound)).toHaveLength(6);
  expect(canUseNativeRealtimeSubscriptions([{ event: "*", schema: "public", table: "orders", filter: compound }])).toBe(false);
});

test("acknowledgements preserve projections and reject conflicting subscription ID reuse", () => {
  const subscriptions: PostgresChangeConfig[] = [
    { event: "*", schema: "public", select: ["id"] },
    { event: "*", schema: "public", select: ["total"] },
  ];
  const echo = { event: "*", schema: "public", table: null, filter: "" };
  expect(bindRealtimeSubscriptionIds(subscriptions, [{ ...echo, id: 0 }, { ...echo, id: 1 }]))
    .toEqual(subscriptions.map((sub, id) => ({ ...sub, id })));
  expect(bindRealtimeSubscriptionIds(subscriptions, [{ ...echo, id: 0 }, { ...echo, id: 0 }])).toBeNull();
  expect(bindRealtimeSubscriptionIds(subscriptions, [
    { ...echo, id: 0, select: ["total"] }, { ...echo, id: 1 },
  ])).toBeNull();
  expect(bindRealtimeSubscriptionIds(subscriptions, [{ ...echo, id: 0 }])).toBeNull();
});

test("each projection receives only its own IDs, new and old columns without mutating the event", () => {
  const data = { ...change, old_record: { id: 1, total: 9 }, errors: [] };
  const subscriptions: PostgresChangeConfig[] = [
    { event: "*", schema: "public", id: 0, select: ["id"] },
    { event: "*", schema: "public", id: 1, select: ["total"] },
    { event: "*", schema: "public", id: 2, select: ["id"] },
    { event: "*", schema: "public", id: 3, select: [] },
  ];
  const projected = projectRealtimeChangeEvents({ data, ids: [0, 1, 2, 3] }, subscriptions);
  expect(projected.map((event) => event.ids)).toEqual([[0, 2], [1], [3]]);
  expect(projected[0]?.data).toMatchObject({ record: { id: 1 }, old_record: { id: 1 }, columns: change.columns });
  expect(projected[1]?.data).toMatchObject({ record: { total: 10 }, old_record: { total: 9 }, columns: [] });
  expect(projected[2]?.data).toMatchObject({ record: {}, old_record: {}, columns: [] });
  expect(data.record).toEqual({ id: 1, total: 10 });
  expect(data.old_record).toEqual({ id: 1, total: 9 });
});
