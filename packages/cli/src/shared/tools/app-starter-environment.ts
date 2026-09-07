export const STARTER_ENVIRONMENT = String.raw`import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const targets = ["development", "test", "staging", "production"];
const remoteKeys = ["SUPACLOUD_API_URL", "SUPACLOUD_API_TOKEN", "SUPACLOUD_PROJECT_REF"];
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadEnvironment(
  target: string,
  root = projectRoot,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!targets.includes(target)) throw new Error("Explicit environment required: " + targets.join(", "));
  const platform = target === "production" ? "production" : "test";
  const checkSelectors = (source: Record<string, string | undefined>) => {
    if (source.APP_ENV !== undefined && source.APP_ENV !== target) throw new Error("APP_ENV conflicts with selected target");
    if (source.SUPACLOUD_ENV !== undefined && source.SUPACLOUD_ENV !== platform) throw new Error("SUPACLOUD_ENV conflicts with selected target");
  };
  checkSelectors(inherited);
  // Untagged or partial process credentials must not be completed from another profile.
  if (remoteKeys.some((key) => inherited[key] !== undefined)) {
    if (inherited.SUPACLOUD_ENV !== platform || remoteKeys.some((key) => !inherited[key]?.trim())) {
      throw new Error("Inherited remote context must be complete and tagged with SUPACLOUD_ENV");
    }
  }
  const localPath = join(root, ".env." + target + ".local");
  if (target === "production" && existsSync(localPath)) throw new Error("Production local env files are not allowed");
  const paths = [join(root, ".env." + target)];
  if (target === "development" || target === "staging") paths.push(localPath);
  const values: Record<string, string> = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = parseEnv(readFileSync(path, "utf8"));
    checkSelectors(parsed);
    if (remoteKeys.some((key) => parsed[key] !== undefined) && remoteKeys.some((key) => !parsed[key]?.trim())) {
      throw new Error("Each remote file profile must supply API URL, token and project ref together");
    }
    Object.assign(values, parsed);
  }
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) values[key] = value;
  }
  if (remoteKeys.some((key) => values[key] !== undefined) &&
      remoteKeys.some((key) => !values[key]?.trim())) {
    throw new Error("Remote context requires API URL, token and project ref together");
  }
  // Target selection and runtime optimization are distinct; staging uses production runtime mode.
  values.APP_ENV = target;
  values.SUPACLOUD_ENV = platform;
  values.NODE_ENV = target === "development" ? "development" : target === "test" ? "test" : "production";
  return values;
}

if (import.meta.main) {
  const [target, ...command] = process.argv.slice(2);
  if (!target || !command.length) throw new Error("Usage: environment.ts <target> <command> [args...]");
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    env: loadEnvironment(target),
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const stop = (signal: "SIGINT" | "SIGTERM") => child.kill(signal);
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.exitCode = await child.exited;
}
`;

export const STARTER_ENVIRONMENT_TEST = String.raw`import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../scripts/environment";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "app-env-"));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("only selected files are loaded, with process > local > target precedence", () => {
  const root = fixture();
  writeFileSync(join(root, ".env"), "LEAK=common\n");
  writeFileSync(join(root, ".env.local"), "LEAK=common-local\n");
  writeFileSync(join(root, ".env.production"), "LEAK=production\n");
  writeFileSync(join(root, ".env.development"), "BASE=base\nVALUE=base\n");
  writeFileSync(join(root, ".env.development.local"), "VALUE=local\nLOCAL=local\nLITERAL='$untouched'\n");
  expect(loadEnvironment("development", root, { VALUE: "process" })).toEqual({
    BASE: "base", VALUE: "process", LOCAL: "local", LITERAL: "$untouched",
    APP_ENV: "development", SUPACLOUD_ENV: "test", NODE_ENV: "development",
  });
});

test("test ignores local overrides and staging uses production runtime optimization", () => {
  const root = fixture();
  writeFileSync(join(root, ".env.test.local"), "LEAK=local\n");
  expect(loadEnvironment("test", root, {}).LEAK).toBeUndefined();
  expect(loadEnvironment("staging", root, {})).toEqual({
    APP_ENV: "staging", SUPACLOUD_ENV: "test", NODE_ENV: "production",
  });
});

test("production local files, unknown targets and selector conflicts are rejected", () => {
  const root = fixture();
  expect(() => loadEnvironment("", root, {})).toThrow("Explicit environment");
  expect(() => loadEnvironment("development", root, { APP_ENV: "production" })).toThrow("conflicts");
  expect(() => loadEnvironment("test", root, { SUPACLOUD_ENV: "production" })).toThrow("conflicts");
  writeFileSync(join(root, ".env.staging"), "APP_ENV=production\n");
  expect(() => loadEnvironment("staging", root, {})).toThrow("conflicts");
  writeFileSync(join(root, ".env.production.local"), "SECRET=synthetic\n");
  expect(() => loadEnvironment("production", root, {})).toThrow("not allowed");
});

test("partial and untagged inherited remote profiles cannot mix with selected files", () => {
  const root = fixture();
  writeFileSync(join(root, ".env.staging"), "SUPACLOUD_API_URL=https://example.invalid\nSUPACLOUD_API_TOKEN=fixture\nSUPACLOUD_PROJECT_REF=fixture\n");
  expect(() => loadEnvironment("staging", root, { SUPACLOUD_API_TOKEN: "other-fixture" })).toThrow("complete and tagged");
  expect(() => loadEnvironment("staging", root, { SUPACLOUD_ENV: "test", SUPACLOUD_API_TOKEN: "" })).toThrow("complete and tagged");
  expect(loadEnvironment("staging", root, {
    SUPACLOUD_ENV: "test", SUPACLOUD_API_URL: "https://ci.invalid",
    SUPACLOUD_API_TOKEN: "ci-fixture", SUPACLOUD_PROJECT_REF: "ci-fixture",
  }).SUPACLOUD_API_URL).toBe("https://ci.invalid");
  writeFileSync(join(root, ".env.staging.local"), "SUPACLOUD_API_URL=https://other.invalid\n");
  expect(() => loadEnvironment("staging", root, {})).toThrow("Each remote file profile");
});
`;
