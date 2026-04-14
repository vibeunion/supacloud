import { describe, expect, test } from "bun:test";

import {
  normalizeCiS3Endpoint,
  resolveRealtimeTenantHost,
} from "../../src/utils/sdk-parity";

describe("SDK parity regression guards", () => {
  test("normalizes CI MinIO host endpoint from published port 9001 to container port 9000", () => {
    expect(
      normalizeCiS3Endpoint("http://127.0.0.1:9001", {
        CI: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("http://127.0.0.1:9000");

    expect(
      normalizeCiS3Endpoint("http://localhost:9001/some/path", {
        GITHUB_ACTIONS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("http://localhost:9000/some/path");
  });

  test("does not rewrite non-CI S3 endpoints", () => {
    expect(
      normalizeCiS3Endpoint("http://127.0.0.1:9001", {} as NodeJS.ProcessEnv),
    ).toBe("http://127.0.0.1:9001");

    expect(
      normalizeCiS3Endpoint("http://127.0.0.1:9000", {
        CI: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("http://127.0.0.1:9000");
  });

  test("resolves realtime proxy host to tenant domain when ref is known", () => {
    expect(resolveRealtimeTenantHost("projref123", "127.0.0.1:9090", "localhost")).toBe(
      "projref123.api.localhost",
    );

    expect(resolveRealtimeTenantHost("", "127.0.0.1:9090", "localhost")).toBe(
      "127.0.0.1:9090",
    );
  });
});