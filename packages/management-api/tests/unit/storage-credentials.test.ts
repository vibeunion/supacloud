// @supacloud-test-isolate
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { S3Driver } from "../../src/services/storage.adapter";
import { shellService } from "../../src/services/shell.service";

const keys = ["NODE_ENV", "CI", "GITHUB_ACTIONS", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const shell = spyOn(shellService, "execute");
afterAll(() => shell.mockRestore());

beforeEach(() => {
  process.env.NODE_ENV = "production";
  for (const key of keys) if (key !== "NODE_ENV") delete process.env[key];
  shell.mockReset();
});

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.each([
  "ACCESS_KEY=access",
  "SECRET_KEY=secret",
  "ACCESS_KEY=\nSECRET_KEY=secret",
  "NOT_ACCESS_KEY=access\nSECRET_KEY=secret",
  "ACCESS_KEY=access\nNOT_SECRET_KEY=secret",
])("rejects incomplete or misnamed credential output before S3 access", async (output) => {
  shell.mockResolvedValue({ success: true, output });
  await expect(new S3Driver().isBucketEmpty("project-one", "objects"))
    .rejects.toThrow("credentials are unavailable");
  expect(shell).toHaveBeenCalledTimes(1);
});

test.each(["S3_ACCESS_KEY", "S3_SECRET_KEY"] as const)(
  "does not construct a client from only %s after a credentials command failure",
  async (key) => {
    process.env[key] = "only-one-credential";
    shell.mockResolvedValue({ success: false, output: "" });
    await expect(new S3Driver().isBucketEmpty("project-one", "objects"))
      .rejects.toThrow("credentials are unavailable");
  },
);
