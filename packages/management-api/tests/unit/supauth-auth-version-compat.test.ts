import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Configuration coverage only; live SupAuth/GoTrue acceptance is a separate gate.
const GOTRUE_COMPATIBILITY_VERSION = "v2.197.0";
const root = resolve(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

type AuthServices = {
  gotrue: { image: string; environment?: Record<string, string> };
};

const compatibilityTargets = [
  { name: "development", path: "docker/dev/docker-compose.yml" },
  { name: "self-hosted", path: "docker/self-host/docker-compose.yml" },
] as const;

for (const target of compatibilityTargets) {
  test(`SupAuth/Supabase Auth ${target.name} baseline is GoTrue ${GOTRUE_COMPATIBILITY_VERSION}`, () => {
    const compose = Bun.YAML.parse(read(target.path)) as { services: AuthServices };
    expect(compose.services.gotrue.image).toBe(`supabase/gotrue:${GOTRUE_COMPATIBILITY_VERSION}`);
    expect(compose.services.gotrue.environment?.GOTRUE_JWT_ISSUER).toEndWith("/auth/v1");
    expect(compose.services.gotrue.environment?.GOTRUE_JWT_AUD).toBe("authenticated");
  });
}

test("Auth integration tests use the same GoTrue compatibility baseline", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/management-api.yml")) as {
    jobs: Record<string, { services: AuthServices }>;
  };
  expect(workflow.jobs["integration-test"]?.services.gotrue.image)
    .toBe(`supabase/gotrue:${GOTRUE_COMPATIBILITY_VERSION}`);
});

test("Auth runtime and upgrade constants match the compatibility baseline", () => {
  for (const [path, constant] of [
    ["scripts/lib/tenant_runtime.sh", "GOTRUE_DEFAULT_VERSION"],
    ["scripts/lib/gotrue_upgrade.sh", "SUPACLOUD_GOTRUE_DEFAULT_VERSION"],
  ]) {
    const version = read(path!).match(new RegExp(`^${constant}="([^"]+)"$`, "m"))?.[1];
    expect(version).toBe(GOTRUE_COMPATIBILITY_VERSION);
  }
});
