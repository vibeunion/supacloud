import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import {
  normalizeBaseDomain,
  resolveProjectApiHost,
  resolveProjectBaseHost,
  resolveProjectStudioHost,
} from "../../src/utils/project-routing";

const originalBaseDomain = config.baseDomain;

afterEach(() => {
  config.baseDomain = originalBaseDomain;
});

describe("project routing", () => {
  test("normalizes api/studio-prefixed base domains", () => {
    expect(normalizeBaseDomain("api.82.157.196.165.sslip.io")).toBe("82.157.196.165.sslip.io");
    expect(normalizeBaseDomain("studio.82.157.196.165.sslip.io")).toBe("82.157.196.165.sslip.io");
  });

  test("does not generate api.api host when BASE_DOMAIN includes api prefix", () => {
    config.baseDomain = "api.82.157.196.165.sslip.io";

    expect(resolveProjectBaseHost("77az24zz7p")).toBe("77az24zz7p.82.157.196.165.sslip.io");
    expect(resolveProjectApiHost("77az24zz7p", null)).toBe("77az24zz7p.api.82.157.196.165.sslip.io");
    expect(resolveProjectStudioHost("77az24zz7p", null)).toBe("studio-77az24zz7p.82.157.196.165.sslip.io");
  });
});
