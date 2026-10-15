import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import { startStarterPostgres, type StarterPostgres } from "../../../scripts/lib/starter-postgres";

const sdk = resolve(import.meta.dir, "..");
const bin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
if (!bin && process.env["SUPACLOUD_REQUIRE_RUNTIME_SAFETY"] === "1") {
  throw new Error("SUPACLOUD_STARTER_POSTGRES_BIN is required");
}
const files = appStarterFiles("review-query-test");
let root: string;
let listReviews: (client: SupabaseClient, options?: {
  page?: number; pageSize?: number; signal?: AbortSignal;
}) => Promise<{ data: unknown[]; total: number; page: number; pageSize: number; hasNextPage: boolean }>;

beforeAll(async () => {
  root = await mkdtemp(join(sdk, ".starter-query-"));
  for (const path of ["src/review/list-reviews.ts", "db/schema.ts"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), files[path]!);
  }
  await mkdir(join(root, "node_modules"));
  await symlink(resolve(sdk, "../db/node_modules/drizzle-orm"), join(root, "node_modules/drizzle-orm"));
  const loaded: { listReviews: typeof listReviews } = await import(join(root, "src/review/list-reviews.ts"));
  listReviews = loaded.listReviews;
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function client(fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return createClient("https://query.test.invalid", "public-test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: Object.assign(fetcher, { preconnect: fetch.preconnect }),
      headers: { Authorization: "Bearer existing-user-token" },
    },
  });
}

test("generated query preserves session, projection, ordered page and RLS count", async () => {
  const data = [{ id: "review-26", state: "approved", version: 2 }];
  const queries: URL[] = [];
  const db = client(async (input, init) => {
    const url = new URL(String(input));
    queries.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer existing-user-token");
    expect(new Headers(init?.headers).get("prefer")).toBe("count=exact");
    return Response.json(data, { headers: { "content-range": "25-25/26" } });
  });
  expect(await listReviews(db, { page: 2 })).toEqual({
    data, total: 26, page: 2, pageSize: 25, hasNextPage: false,
  });
  expect(queries[0]!.pathname).toBe("/rest/v1/starter_reviews");
  expect(Object.fromEntries(queries[0]!.searchParams)).toEqual({
    select: "id,state,version", order: "id.asc", offset: "25", limit: "25",
  });
  expect(files["README.md"]).toContain("listReviews");
});

test("invalid pages and pre-cancelled reads never reach the transport", async () => {
  let requests = 0;
  const db = client(async () => { requests++; return Response.json([]); });
  for (const options of [
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: NaN }, { page: Infinity },
    { pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 100 },
  ]) await expect(listReviews(db, options)).rejects.toBeInstanceOf(RangeError);
  await expect(listReviews(db, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(requests).toBe(0);
});

test("empty and partial pages retain exact totals; cancellation reaches fetch", async () => {
  const controller = new AbortController();
  const db = client(async (_input, init) => {
    expect(init?.signal).toBe(controller.signal);
    return Response.json([], { headers: { "content-range": "*/0" } });
  });
  expect(await listReviews(db, { signal: controller.signal })).toEqual({
    data: [], total: 0, page: 1, pageSize: 25, hasNextPage: false,
  });
  const partial = client(async () => Response.json([{ id: "a", state: "draft", version: 1 }], {
    headers: { "content-range": "0-0/2" },
  }));
  expect((await listReviews(partial, { pageSize: 1 })).hasNextPage).toBe(true);
});

test("database errors and missing totals never become empty successful pages", async () => {
  const db = client(async () => Response.json({
    code: "42501", message: "permission denied", details: null, hint: null,
  }, { status: 403 }));
  await expect(listReviews(db)).rejects.toMatchObject({ code: "42501", message: "permission denied" });
  await expect(listReviews(client(async () => Response.json([])))).rejects.toThrow("Incomplete");
});

test("generated response types follow the database source and flag stale business consumers", async () => {
  await writeFile(join(root, "consumer.ts"), `import { createClient } from "@supabase/supabase-js";
import { listReviews, type ReviewReadDatabase } from "./src/review/list-reviews";
const result = await listReviews(createClient<ReviewReadDatabase>("https://test.invalid", "public-key"));
const version: number | undefined = result.data[0]?.version;
const state: "draft" | "approved" | undefined = result.data[0]?.state;
void version; void state;
`);
  async function check() {
    const child = Bun.spawn([process.execPath, join(sdk, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "ESNext",
      "--moduleResolution", "bundler", "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes",
      "consumer.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, output: out + err };
  }
  const first = await check();
  expect(first.output).toBe("");
  expect(first.code).toBe(0);
  const schema = files["db/schema.ts"]!;
  try {
    await writeFile(join(root, "db/schema.ts"), schema.replace(
      'version: integer().notNull()', 'version: text().notNull()'));
    const changed = await check();
    expect(changed.code).not.toBe(0);
    expect(changed.output).toContain("consumer.ts");
    expect(changed.output).toContain("string");
  } finally { await writeFile(join(root, "db/schema.ts"), schema); }
}, 30_000);

describe.skipIf(!bin)("existing starter RLS on disposable PostgreSQL (not a JWT gateway)", () => {
  let database: StarterPostgres;
  const owner = "11111111-1111-4111-8111-111111111111";
  const mapped = "22222222-2222-4222-8222-222222222222";
  beforeAll(async () => {
    database = await startStarterPostgres(bin!);
    await database.exec(`
      CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA auth;
      CREATE SCHEMA storage;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb
      $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT (auth.jwt()->>'sub')::uuid
      $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE TABLE storage.buckets (id text PRIMARY KEY,name text,public boolean,
        file_size_limit integer,allowed_mime_types text[]);
      CREATE TABLE storage.objects (bucket_id text,name text);
      ${files["migrations/001-review.sql"]}
      ${files["migrations/003-review-uploads.sql"]}
      INSERT INTO public.starter_members(subject,storage_subject,can_approve)
        VALUES ('${owner}','${owner}',true),('external-owner','${mapped}',true);
      INSERT INTO public.starter_reviews(id,owner_id,state,version)
        VALUES ('a','${owner}','draft',1),('c','${owner}','approved',2),
               ('b','external-owner','draft',1);
    `);
  }, 30_000);
  afterAll(async () => { await database?.close(); }, 30_000);
  async function page(claims: Record<string, string>, offset = 0) {
    return database.transaction(async tx => {
      await tx.query("SET LOCAL ROLE authenticated");
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      return tx.query(`SELECT id,state,version,count(*) OVER()::integer AS total
        FROM public.starter_reviews ORDER BY id LIMIT 1 OFFSET $1::integer`, [String(offset)]);
    });
  }
  test("counts and pages exclude other owners for native and mapped identities", async () => {
    expect(await page({ sub: owner })).toEqual([{ id: "a", state: "draft", version: 1, total: 2 }]);
    expect(await page({ sub: owner }, 1)).toEqual([{ id: "c", state: "approved", version: 2, total: 2 }]);
    expect(await page({ sub: mapped, external_sub: "external-owner" }))
      .toEqual([{ id: "b", state: "draft", version: 1, total: 1 }]);
    expect(await page({ sub: mapped, external_sub: owner })).toEqual([]);
    expect(await page({})).toEqual([]);
  });
  test("disabled membership and revoked approval permission take effect on the next query", async () => {
    try {
      await database.exec(`UPDATE public.starter_members SET enabled=false WHERE subject='${owner}'`);
      expect(await page({ sub: owner })).toEqual([]);
      await database.exec(`UPDATE public.starter_members SET enabled=true,can_approve=false WHERE subject='${owner}'`);
      expect(await page({ sub: owner })).toEqual([]);
    } finally {
      await database.exec(`UPDATE public.starter_members SET enabled=true,can_approve=true WHERE subject='${owner}'`);
    }
  });
});
