import { beforeEach, expect, mock, test } from "bun:test";
import { InvalidSignedUploadError } from "../../src/utils/signed-upload-record";

let rows: unknown = [];
let queries: string[] = [];
let commits = 0;
let rollbacks = 0;
const query = async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> => {
  queries.push(strings.join("?"));
  return rows;
};
const database = Object.assign(query, {
  begin: async (operation: (tx: typeof query) => Promise<unknown>): Promise<unknown> => {
    try {
      const result = await operation(query);
      commits++;
      return result;
    } catch (error) {
      rollbacks++;
      throw error;
    }
  },
});
const originalDb = await import("../../src/db");
mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
const { SignedStore } = await import("../../src/services/storage-store");
const upload = {
  ref: "project-one", bucket: "objects", objectName: "file.txt", upsert: false, expiresAt: 4_000_000_000,
};
const row = {
  token: "signed-token", ref: upload.ref, bucket: upload.bucket, object_name: upload.objectName,
  upsert: upload.upsert, expires_at: upload.expiresAt, auth_token: null,
};

beforeEach(() => {
  rows = [row];
  queries = [];
  commits = 0;
  rollbacks = 0;
});

test("invalid inputs fail before a database write", async () => {
  await expect(SignedStore.set("", upload)).rejects.toBeInstanceOf(InvalidSignedUploadError);
  const malformed = { ...upload };
  Reflect.set(malformed, "upsert", "false");
  await expect(SignedStore.set(row.token, malformed)).rejects.toBeInstanceOf(InvalidSignedUploadError);
  expect(queries).toEqual([]);
});

test("a malformed read cannot become an overwrite permission", async () => {
  rows = [{ ...row, upsert: "false" }];
  await expect(SignedStore.get(row.token)).rejects.toBeInstanceOf(InvalidSignedUploadError);
  expect(queries).toHaveLength(1);
});

test.each([
  { receipt: [] }, { receipt: [{ ...row, object_name: "other.txt" }] },
  { receipt: [{ ...row, ref: "other-project" }] },
])(
  "rejects an invalid creation receipt within the transaction without retry",
  async ({ receipt }) => {
    rows = receipt;
    await expect(SignedStore.set(row.token, upload)).rejects.toBeInstanceOf(InvalidSignedUploadError);
    expect(queries).toHaveLength(1);
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
  },
);

test("consumption validates the token before committing its deletion", async () => {
  rows = [{ ...row, token: "another-token" }];
  await expect(SignedStore.consume(row.token)).rejects.toBeInstanceOf(InvalidSignedUploadError);
  expect(queries).toHaveLength(1);
  expect(rollbacks).toBe(1);
  rows = [row];
  expect(await SignedStore.consume(row.token)).toEqual(upload);
  expect(commits).toBe(1);
});
