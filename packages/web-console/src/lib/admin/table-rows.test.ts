import { expect, test } from "bun:test";
import { parseTableColumnsResponse, type TableColumnMetadata } from "./resources";
import { formatTableValue, loadTableRowsResource, matchingTableTenant } from "./table-rows";

const identity = { projectRef: "a", schema: "public", tableName: "users" };
const column: TableColumnMetadata = {
  column_name: "id", data_type: "uuid", udt_name: "uuid", is_nullable: "NO",
  column_default: null, is_primary_key: true, primary_key_position: 1,
};

test("table metadata preserves exact required values and rejects incomplete or contradictory fields", () => {
  expect(parseTableColumnsResponse({ data: [column] })).toEqual([column]);
  for (const patch of [
    { column_default: undefined }, { column_default: {} }, { is_nullable: "maybe" }, { is_nullable: false },
    { is_primary_key: undefined }, { is_primary_key: "false" }, { udt_name: 1 },
    { primary_key_position: 0 }, { primary_key_position: 1.5 }, { primary_key_position: null },
    { primary_key_position: 2 }, { is_nullable: "YES" },
    { column_name: "" }, { column_name: "a\0b" }, { column_name: "界".repeat(22) },
  ]) expect(() => parseTableColumnsResponse({ data: [{ ...column, ...patch }] })).toThrow();
  expect(() => parseTableColumnsResponse({ data: [column, column] })).toThrow();
  expect(() => parseTableColumnsResponse({ data: [{ ...column, is_primary_key: false }] })).toThrow();
  expect(() => parseTableColumnsResponse({ data: Array(1601).fill(column) })).toThrow();
  expect(parseTableColumnsResponse({ data: [] })).toEqual([]);
});

test("composite primary keys are complete and columns retain native case and quoted names", () => {
  const columns: TableColumnMetadata[] = [
    column, { ...column, column_name: 'A "/ B', primary_key_position: 2 },
    { ...column, column_name: "data", is_primary_key: false, primary_key_position: null, is_nullable: "YES" },
  ];
  expect(parseTableColumnsResponse({ data: columns })).toEqual(columns);
  expect(() => parseTableColumnsResponse({ data: [columns[0], { ...columns[1], primary_key_position: 1 }] })).toThrow();
});

test("missing and mismatched project contexts cannot start metadata reads", () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({ data: [column] }); };
  for (const tenant of [undefined, { tenantId: "b" }, { tenantId: 1 }]) {
    expect(matchingTableTenant(tenant, identity)).toBeNull();
    expect(() => loadTableRowsResource(identity, tenant, request, new AbortController().signal)).toThrow("Project context unavailable");
  }
  for (const target of [{ ...identity, schema: "" }, { ...identity, tableName: "a\0b" }, { ...identity, projectRef: "a/b" }]) {
    expect(() => loadTableRowsResource(target, { tenantId: target.projectRef }, request, new AbortController().signal)).toThrow();
  }
  expect(calls).toBe(0);
});

test("metadata transport is project-bound, cancellable and does not turn errors into empty resources", async () => {
  const urls: string[] = [];
  const resource = await loadTableRowsResource(
    identity, { tenantId: "a" }, async (url, options) => {
      urls.push(url);
      expect(options.redirect).toBe("error");
      return Response.json({ data: [column] });
    }, new AbortController().signal,
  );
  expect(urls).toEqual(["/v1/projects/a/database/tables/public/users/columns"]);
  expect(resource.primaryKey).toBe("id");
  expect(resource.canEdit).toBe(false);
  await expect(loadTableRowsResource(identity, { tenantId: "a" },
    async () => Response.json({ data: [] }, { status: 500 }), new AbortController().signal)).rejects.toThrow();
  const pending = Promise.withResolvers<Response>();
  const controller = new AbortController();
  const read = loadTableRowsResource(identity, { tenantId: "a" }, () => pending.promise, controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  let cancelled = false;
  pending.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancelled).toBe(true);
});

test("table cells format JSON without trusting object string coercion", () => {
  expect(formatTableValue({ toString: null, valueOf: null })).toBe('{"toString":null,"valueOf":null}');
  expect(formatTableValue(["a", null, true])).toBe('["a",null,true]');
  expect(formatTableValue(null)).toBe("null");
  expect(formatTableValue(0)).toBe("0");
  expect(formatTableValue(false)).toBe("false");
  expect(formatTableValue(10n)).toBe("10");
  expect(formatTableValue(undefined)).toBe("[Unsupported value]");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(formatTableValue(circular)).toBe("[Unsupported value]");
});

test("metadata responses retain the identity captured before a pending request", async () => {
  const target = { ...identity };
  const pending = Promise.withResolvers<Response>();
  const urls: string[] = [];
  const resource = loadTableRowsResource(target, { tenantId: "a" }, url => {
    urls.push(url);
    return pending.promise;
  }, new AbortController().signal);
  target.projectRef = "b";
  target.schema = "private";
  target.tableName = "secrets";
  pending.resolve(Response.json({ data: [column] }));
  expect((await resource).name).toBe("v1/projects/a/database/tables/public/users/rows");
  expect(urls).toEqual(["/v1/projects/a/database/tables/public/users/columns"]);
});

test("invalid metadata transport cannot yield a table resource or retry a request", async () => {
  const responses = [
    () => new Response(null, { status: 204 }),
    () => Response.json({ data: [column] }, { status: 500 }),
    () => new Response(new Uint8Array([0xff])),
    () => new Response("{"),
    () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    () => new Response("{}", { headers: { "content-length": "8388609" } }),
    () => new Response("{}", { headers: { "content-length": "invalid" } }),
  ];
  for (const response of responses) {
    let calls = 0;
    await expect(loadTableRowsResource(identity, { tenantId: "a" }, async () => {
      calls++;
      return response();
    }, new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
