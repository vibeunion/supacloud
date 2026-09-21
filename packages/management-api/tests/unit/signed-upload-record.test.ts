import { describe, expect, test } from "bun:test";
import {
  copySignedUpload,
  InvalidSignedUploadError,
  readSignedUploadRows,
} from "../../src/utils/signed-upload-record";

const row = {
  token: "signed-token",
  ref: "project-one",
  bucket: "objects",
  object_name: "folder/file.txt",
  upsert: false,
  expires_at: 4_000_000_000,
  auth_token: null,
};

describe("signed upload records", () => {
  test.each([4_000_000_000, 4_000_000_000n, "4000000000"])(
    "decodes a precise native bigint representation %s without changing permissions",
    (expires_at) => {
      const upload = readSignedUploadRows([{ ...row, expires_at }], row.token);
      expect(upload).toEqual({
        ref: row.ref, bucket: row.bucket, objectName: row.object_name,
        upsert: false, expiresAt: 4_000_000_000,
      });
      expect(upload).not.toHaveProperty("auth_token");
    },
  );

  test.each([
    ["upsert", "false"], ["upsert", 0], ["upsert", null],
    ["ref", undefined], ["bucket", ""], ["object_name", 123],
    ["auth_token", false], ["auth_token", undefined],
    ["expires_at", true], ["expires_at", null], ["expires_at", ""],
    ["expires_at", " 4000000000"], ["expires_at", "4e9"], ["expires_at", "04000000000"],
    ["expires_at", 1.5], ["expires_at", Infinity], ["expires_at", -1],
    ["expires_at", Number.MAX_SAFE_INTEGER + 1], ["expires_at", 9_007_199_254_740_993n],
    ["expires_at", "9007199254740993"], ["token", "another-token"],
  ])("rejects malformed %s without fabricated values", (field, value) => {
    expect(() => readSignedUploadRows([{ ...row, [field]: value }], row.token))
      .toThrow(InvalidSignedUploadError);
  });

  test("only an empty result means no upload and duplicate rows cannot be consumed", () => {
    expect(readSignedUploadRows([], row.token)).toBeNull();
    for (const rows of [null, {}, [null], [row, row]]) {
      expect(() => readSignedUploadRows(rows, row.token)).toThrow(InvalidSignedUploadError);
    }
  });

  test("preserves empty authentication text and makes a detached input snapshot", () => {
    const upload = readSignedUploadRows([{ ...row, upsert: true, auth_token: "" }], row.token);
    if (!upload) throw new Error("Missing signed upload fixture");
    expect(upload).toMatchObject({ upsert: true, auth_token: "" });
    const snapshot = copySignedUpload(upload);
    expect(snapshot).toEqual(upload);
    expect(snapshot).not.toBe(upload);
  });
});
