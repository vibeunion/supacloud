// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";
import { InvalidSignedUploadError } from "../../src/utils/signed-upload-record";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native signed uploads retain exact values and roll back invalid receipts",
  async () => withNativePostgres(async (database) => {
    const originalDb = await import("../../src/db");
    mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
    const { SignedStore } = await import("../../src/services/storage-store");
    await database.unsafe(`
      CREATE TABLE system_signed_uploads (
        token text PRIMARY KEY, ref varchar(50) NOT NULL, bucket varchar(63) NOT NULL,
        object_name text NOT NULL, upsert boolean DEFAULT false, expires_at bigint NOT NULL,
        created_at timestamptz DEFAULT NOW(), auth_token text
      );
    `);
    const upload = {
      ref: "native-project", bucket: "objects", objectName: "folder/file.txt",
      upsert: false, expiresAt: 4_000_000_000, auth_token: "",
    };
    await SignedStore.set("one-time", upload);
    expect(await SignedStore.get("one-time")).toEqual(upload);
    const consumed = await Promise.all([SignedStore.consume("one-time"), SignedStore.consume("one-time")]);
    expect(consumed.filter(value => value !== null)).toEqual([upload]);
    expect(await SignedStore.get("one-time")).toBeNull();

    await SignedStore.set("corrupt", upload);
    await database`UPDATE system_signed_uploads SET upsert = NULL WHERE token = 'corrupt'`;
    await expect(SignedStore.get("corrupt")).rejects.toBeInstanceOf(InvalidSignedUploadError);
    await expect(SignedStore.consume("corrupt")).rejects.toBeInstanceOf(InvalidSignedUploadError);
    const retained: unknown = await database`SELECT token FROM system_signed_uploads WHERE token = 'corrupt'`;
    expect(retained).toEqual([{ token: "corrupt" }]);

    await SignedStore.set("expired", { ...upload, expiresAt: 0 });
    expect(await SignedStore.consume("expired")).toBeNull();
    await database.unsafe(`
      CREATE FUNCTION change_signed_destination() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.object_name := 'unexpected.txt'; RETURN NEW; END $$;
      CREATE TRIGGER change_signed_destination BEFORE INSERT ON system_signed_uploads
        FOR EACH ROW EXECUTE FUNCTION change_signed_destination();
    `);
    await expect(SignedStore.set("changed", upload)).rejects.toBeInstanceOf(InvalidSignedUploadError);
    const rejected: unknown = await database`SELECT token FROM system_signed_uploads WHERE token = 'changed'`;
    expect(rejected).toEqual([]);
  }),
  40_000,
);
