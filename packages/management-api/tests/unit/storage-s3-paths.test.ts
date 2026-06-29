import { describe, expect, test } from "bun:test";
import { isS3DataPlanePath } from "../../src/utils/storage-s3-paths";

describe("storage S3 path classification", () => {
  test("classifies S3 object and bucket operations as data-plane requests", () => {
    expect(isS3DataPlanePath("/v1/storage/testproj/s3")).toBe(true);
    expect(isS3DataPlanePath("/v1/storage/testproj/s3/")).toBe(true);
    expect(isS3DataPlanePath("/v1/storage/testproj/s3/mybucket")).toBe(true);
    expect(isS3DataPlanePath("/v1/storage/testproj/s3/mybucket/path/to/file.txt")).toBe(true);
  });

  test("keeps credential and generic storage requests under platform auth", () => {
    expect(isS3DataPlanePath("/v1/storage/testproj/s3/credentials")).toBe(false);
    expect(isS3DataPlanePath("/v1/storage/testproj/s3/credentials/")).toBe(false);
    expect(isS3DataPlanePath("/v1/storage/testproj/buckets")).toBe(false);
    expect(isS3DataPlanePath("/storage/v1/object/testproj/mybucket/file.txt")).toBe(false);
  });
});
