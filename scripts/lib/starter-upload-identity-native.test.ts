import { expect, test } from "bun:test";
import { SQL } from "bun";
import { STARTER_REVIEW_SCHEMA } from "../../packages/cli/src/shared/tools/app-starter-postgres";
import { STARTER_UPLOAD_SCHEMA } from "../../packages/cli/src/shared/tools/app-starter-upload";
import { startStarterPostgres } from "./starter-postgres";

const postgresBin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

test.skipIf(!postgresBin)("starter upload RLS accepts native sub, mapped external_sub, and denies another subject", async () => {
  const postgres = await startStarterPostgres(postgresBin!);
  let database: SQL | undefined;
  const nativeSubject = "11111111-1111-4111-8111-111111111111";
  const mappedStorageSubject = "22222222-2222-4222-8222-222222222222";
  const outsiderStorageSubject = "33333333-3333-4333-8333-333333333333";
  const nativeReview = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const mappedReview = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const nativeArtifact = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
  const mappedArtifact = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
  try {
    database = await postgres.withConnection(async url => new SQL({ url, max: 4 }));
    await database.unsafe(`
      CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA auth;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (
        id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL,
        file_size_limit integer, allowed_mime_types text[]
      );
      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL, owner_id uuid
      );
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
        SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb
      $$ LANGUAGE SQL STABLE;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
        SELECT nullif(COALESCE(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ), '')::uuid
      $$ LANGUAGE SQL STABLE;
      GRANT USAGE ON SCHEMA auth, storage TO authenticated;
      GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO authenticated;
      GRANT INSERT, SELECT ON storage.objects TO authenticated;
      ${STARTER_REVIEW_SCHEMA}
      INSERT INTO public.starter_members(subject, enabled, can_approve)
        VALUES ('${nativeSubject}', true, true), ('mapped-owner', true, true), ('other-owner', true, true);
      INSERT INTO public.starter_reviews(id, owner_id, state, version)
        VALUES ('${nativeReview}', '${nativeSubject}', 'draft', 1),
               ('${mappedReview}', 'mapped-owner', 'draft', 1);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      ${STARTER_UPLOAD_SCHEMA}
      UPDATE public.starter_members SET storage_subject='${nativeSubject}' WHERE subject='${nativeSubject}';
      UPDATE public.starter_members SET storage_subject='${mappedStorageSubject}' WHERE subject='mapped-owner';
      UPDATE public.starter_members SET storage_subject='${outsiderStorageSubject}' WHERE subject='other-owner';
    `);

    async function asClaims<T>(claims: Record<string, string>, run: (connection: {
      unsafe: (text: string, parameters?: unknown[]) => Promise<unknown>;
    }) => Promise<T>): Promise<T> {
      const connection = await database!.reserve();
      try {
        await connection.unsafe("BEGIN");
        await connection.unsafe("SET ROLE authenticated");
        await connection.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        return await run(connection);
      } finally {
        await connection.unsafe("ROLLBACK");
        connection.release();
      }
    }

    const nativeMembers = await asClaims({ sub: nativeSubject, role: "authenticated" }, connection =>
      connection.unsafe("SELECT subject FROM public.starter_members ORDER BY subject"));
    expect(nativeMembers).toEqual([{ subject: nativeSubject }]);

    await asClaims({ sub: nativeSubject, role: "authenticated" }, connection =>
      connection.unsafe(
        "INSERT INTO storage.objects(id,bucket_id,name,owner_id) VALUES($1,'review-attachments',$2,$3)",
        [nativeArtifact, "11111111-1111-4111-8111-111111111111/" + nativeReview + "/" + nativeArtifact + ".txt", nativeSubject],
      ));

    const mappedReviews = await asClaims({
      sub: mappedStorageSubject, external_sub: "mapped-owner", role: "authenticated",
    }, connection => connection.unsafe(
      "SELECT id, owner_id FROM public.starter_reviews ORDER BY id",
    ));
    expect(mappedReviews).toEqual([{ id: mappedReview, owner_id: "mapped-owner" }]);

    await asClaims({
      sub: mappedStorageSubject, external_sub: "mapped-owner", role: "authenticated",
    }, connection => connection.unsafe(
      "INSERT INTO storage.objects(id,bucket_id,name,owner_id) VALUES($1,'review-attachments',$2,$3)",
      [mappedArtifact, mappedStorageSubject + "/" + mappedReview + "/" + mappedArtifact + ".txt", mappedStorageSubject],
    ));

    await expect(asClaims({
      sub: outsiderStorageSubject, external_sub: "other-owner", role: "authenticated",
    }, connection => connection.unsafe(
      "INSERT INTO storage.objects(id,bucket_id,name,owner_id) VALUES($1,'review-attachments',$2,$3)",
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        outsiderStorageSubject + "/" + mappedReview + "/" + mappedArtifact + ".txt", outsiderStorageSubject],
    ))).rejects.toThrow();
  } finally {
    await database?.close({ timeout: 1 });
    await postgres.close();
  }
}, 60_000);
