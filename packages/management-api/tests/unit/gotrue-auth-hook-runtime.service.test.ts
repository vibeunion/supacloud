import { createHmac } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import {
  goTrueAuthHookStatusFromRuntime,
  readActiveGoTrueHookEnvironment,
  type GoTrueEnvironmentRuntime,
} from "../../src/services/gotrue-auth-hook-runtime.service";

const firstKey = Buffer.from("standard-webhooks-first-key");
const secondKey = Buffer.from("standard-webhooks-second-key");
const projectConfig = {
  api_domain: "api.project.example",
  auth_domain: "auth.project.example",
};

function secret(key: Buffer): string {
  return `v1,whsec_${key.toString("base64")}`;
}

function beforeUserCreatedEnvironment() {
  return {
    GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true",
    GOTRUE_HOOK_BEFORE_USER_CREATED_URI:
      "https://auth.project.example/functions/v1/supauth/api/v1/auth-hooks/before-user-created",
    GOTRUE_HOOK_BEFORE_USER_CREATED_SECRETS: `${secret(firstKey)}|${secret(secondKey)}`,
  };
}

function commandOutput(stdout: string, exitCode = 0) {
  return { exitCode, stdout: Buffer.from(stdout) };
}

function processIdentity(overrides: Record<string, string> = {}) {
  return Object.entries({
    MainPID: "4321",
    User: "supacloud-proj-1",
    Group: "supacloud-proj-1",
    UID: "980",
    GID: "980",
    ...overrides,
  }).map(([name, setting]) => `${name}=${setting}`).join("\n");
}

function inspectionRuntime(
  run: GoTrueEnvironmentRuntime["run"],
  setprivPath: string | null = "/usr/bin/setpriv",
): GoTrueEnvironmentRuntime {
  return {
    run,
    setprivPath,
    systemctlPath: "/usr/bin/systemctl",
    sedPath: "/usr/bin/sed",
  };
}

describe("live GoTrue HTTP Auth Hook verification", () => {
  test("signs the before-user-created probe with every active GoTrue rotation key", async () => {
    const fetcher = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const webhookId = headers.get("webhook-id") || "";
      const timestamp = headers.get("webhook-timestamp") || "";
      const signatures = [firstKey, secondKey].map((key) => (
        `v1,${createHmac("sha256", key).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`
      ));
      expect(headers.get("webhook-signature")).toBe(signatures.join(", "));
      return new Response(JSON.stringify({
        supaoauth_hook_probe: {
          verified: true,
          protocol: "standard-webhooks-v1",
          hook_name: "before-user-created",
          project_ref: "proj_1",
        },
      }), { status: 200 });
    }) as typeof fetch;

    expect(await goTrueAuthHookStatusFromRuntime({
      projectRef: "proj_1",
      hookName: "before-user-created",
      projectConfig,
      environment: beforeUserCreatedEnvironment(),
    }, fetcher)).toEqual({
      hook_name: "before-user-created",
      registered: true,
      verified: true,
      protocol: "standard-webhooks-v1",
      version: "gotrue-standard-webhooks-v1",
      reason_code: null,
    });
  });

  test("distinguishes registered configuration from a verified endpoint", async () => {
    const invalidResponse = mock(async () => new Response("{}", { status: 200 })) as typeof fetch;
    expect(await goTrueAuthHookStatusFromRuntime({
      projectRef: "proj_1",
      hookName: "before-user-created",
      projectConfig,
      environment: beforeUserCreatedEnvironment(),
    }, invalidResponse)).toMatchObject({
      registered: true,
      verified: false,
      reason_code: "gotrue_before_user_created_hook_probe_response_invalid",
    });
  });

  test("reads only active hook keys through the GoTrue tenant identity", async () => {
    const run = mock(async (command: string[]) => command[0] === "/usr/bin/systemctl"
      ? commandOutput(processIdentity())
      : commandOutput([
          "JWT_SECRET=must-not-be-returned",
          ...Object.entries(beforeUserCreatedEnvironment()).map(
            ([name, setting]) => `${name}=${setting}`,
          ),
          "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true",
        ].join("\0")));

    const environment = await readActiveGoTrueHookEnvironment(
      "proj-1", "before-user-created", inspectionRuntime(run),
    );

    expect(environment).toEqual(beforeUserCreatedEnvironment());
    expect(run).toHaveBeenNthCalledWith(1, [
      "/usr/bin/systemctl", "show", "supacloud-gotrue@proj-1",
      "--property=MainPID,User,Group,UID,GID", "--no-pager",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, [
      "/usr/bin/setpriv", "--reuid", "980", "--regid", "980", "--clear-groups", "--",
      "/usr/bin/sed", "-z", "-n", "-E",
      "/^GOTRUE_HOOK_BEFORE_USER_CREATED_(ENABLED|URI|SECRETS)=/p", "/proc/4321/environ",
    ]);
    expect(environment).not.toHaveProperty("JWT_SECRET");
    expect(environment).not.toHaveProperty("GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED");
  });

  test("returns unavailable when the GoTrue unit has no active MainPID", async () => {
    const run = mock(async () => commandOutput(processIdentity({ MainPID: "0" })));

    expect(await readActiveGoTrueHookEnvironment(
      "proj-1", "before-user-created", inspectionRuntime(run),
    )).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("rejects a GoTrue unit whose runtime identity does not match the project", async () => {
    const run = mock(async () => commandOutput(processIdentity({ User: "root", Group: "root" })));

    expect(await readActiveGoTrueHookEnvironment(
      "proj-1", "before-user-created", inspectionRuntime(run),
    )).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("returns unavailable when tenant-scoped process environment reading fails", async () => {
    const run = mock(async (command: string[]) => command[0] === "/usr/bin/systemctl"
      ? commandOutput(processIdentity())
      : commandOutput("", 1));

    expect(await readActiveGoTrueHookEnvironment(
      "proj-1", "before-user-created", inspectionRuntime(run),
    )).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("treats a readable process with no target hook keys as not enabled", async () => {
    const run = mock(async (command: string[]) => command[0] === "/usr/bin/systemctl"
      ? commandOutput(processIdentity())
      : commandOutput(""));

    expect(await readActiveGoTrueHookEnvironment(
      "proj-1", "before-user-created", inspectionRuntime(run),
    )).toEqual({});
  });

  test("rejects invalid project refs and unavailable privilege separation", async () => {
    const run = mock(async () => commandOutput(processIdentity()));

    expect(await readActiveGoTrueHookEnvironment(
      "../proj-1", "before-user-created", inspectionRuntime(run),
    )).toBeNull();
    expect(await readActiveGoTrueHookEnvironment(
      "proj-1", "before-user-created", inspectionRuntime(run, null),
    )).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
