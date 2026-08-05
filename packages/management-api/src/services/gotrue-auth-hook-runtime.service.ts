import { existsSync } from "node:fs";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";
import { projectRepository } from "../repositories/project.repository";
import { normalizeProjectConfig } from "../utils/project-config";
import {
  StandardWebhookVerificationError,
  buildStandardWebhookHeaders,
  standardWebhookSigningKeys,
} from "./standard-webhooks.service";
import {
  normalizeProjectRoutingConfig,
  resolveProjectApiHosts,
  resolveProjectAuthHost,
  type ProjectRoutingConfig,
} from "../utils/project-routing";

export const GOTRUE_HTTP_HOOK_NAMES = [
  "before-user-created",
  "custom-access-token",
] as const;

export type GoTrueHttpHookName = (typeof GOTRUE_HTTP_HOOK_NAMES)[number];

export type GoTrueAuthHookStatus = {
  hook_name: GoTrueHttpHookName;
  registered: boolean;
  verified: boolean;
  protocol: "standard-webhooks-v1";
  version: string | null;
  reason_code: string | null;
  authority_project_ref?: string;
  managed_by_owner?: boolean;
};

type RuntimeEvidenceInput = {
  projectRef: string;
  hookName: GoTrueHttpHookName;
  projectConfig?: ProjectRoutingConfig;
  environment: Record<string, string>;
};

type HookRuntimeConfiguration = {
  uri: string;
  configuredSecrets: string;
};

type RuntimeCommandOutput = {
  exitCode: number;
  stdout: Buffer;
};

export type GoTrueEnvironmentRuntime = {
  setprivPath: string | null;
  systemctlPath: string | null;
  sedPath: string | null;
  run: (command: string[]) => Promise<RuntimeCommandOutput>;
};

type GoTrueProcessIdentity = {
  pid: number;
  uid: number;
  gid: number;
};

const HOOK_CONFIGURATION: Record<GoTrueHttpHookName, { envPrefix: string; endpoint: string }> = {
  "before-user-created": {
    envPrefix: "BEFORE_USER_CREATED",
    endpoint: "/v1/auth-hooks/before-user-created",
  },
  "custom-access-token": {
    envPrefix: "CUSTOM_ACCESS_TOKEN",
    endpoint: "/v1/auth-hooks/custom-access-token",
  },
};
const PROBE_FIELD = "supaoauth_hook_probe";
const PROBE_TIMEOUT_MS = 3_000;
const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,20}$/;

class RuntimeInspectionUnavailableError extends Error {
  constructor(cause: unknown) {
    super("GoTrue runtime inspection command is unavailable", { cause });
    this.name = "RuntimeInspectionUnavailableError";
  }
}

async function runRuntimeCommand(command: string[]): Promise<RuntimeCommandOutput> {
  try {
    const child = Bun.spawn(command, {
      env: { LANG: "C" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    return { exitCode, stdout: Buffer.from(stdout) };
  } catch (cause) {
    throw new RuntimeInspectionUnavailableError(cause);
  }
}

const HOST_ENVIRONMENT_RUNTIME: GoTrueEnvironmentRuntime = {
  setprivPath: ["/usr/bin/setpriv", "/bin/setpriv"].find(existsSync) ?? null,
  systemctlPath: ["/usr/bin/systemctl", "/bin/systemctl"].find(existsSync) ?? null,
  sedPath: ["/usr/bin/sed", "/bin/sed"].find(existsSync) ?? null,
  run: runRuntimeCommand,
};

function reasonCode(hookName: GoTrueHttpHookName, reason: string): string {
  return `gotrue_${hookName.replaceAll("-", "_")}_hook_${reason}`;
}

function unverifiedStatus(input: {
  hookName: GoTrueHttpHookName;
  reason: string;
  registered: boolean;
}): GoTrueAuthHookStatus {
  return {
    hook_name: input.hookName,
    registered: input.registered,
    verified: false,
    protocol: "standard-webhooks-v1",
    version: null,
    reason_code: reasonCode(input.hookName, input.reason),
  };
}

function unavailable(hookName: GoTrueHttpHookName, reason: string): GoTrueAuthHookStatus {
  return unverifiedStatus({ hookName, reason, registered: false });
}

function registeredButUnverified(hookName: GoTrueHttpHookName, reason: string): GoTrueAuthHookStatus {
  return unverifiedStatus({ hookName, reason, registered: true });
}

function verified(hookName: GoTrueHttpHookName): GoTrueAuthHookStatus {
  return {
    hook_name: hookName,
    registered: true,
    verified: true,
    protocol: "standard-webhooks-v1",
    version: "gotrue-standard-webhooks-v1",
    reason_code: null,
  };
}

function hookTargetsProject(
  projectRef: string,
  projectConfig: ProjectRoutingConfig | undefined,
  hookName: GoTrueHttpHookName,
  uri: string,
): boolean {
  try {
    const hookUrl = new URL(uri);
    const allowedHosts = new Set([
      ...resolveProjectApiHosts(projectRef, projectConfig),
      resolveProjectAuthHost(projectRef, projectConfig),
    ].map((host) => host.toLowerCase()));
    const endpoint = HOOK_CONFIGURATION[hookName].endpoint;
    return hookUrl.pathname.replace(/\/+$/, "").endsWith(endpoint)
      && allowedHosts.has(hookUrl.host.toLowerCase());
  } catch {
    return false;
  }
}

function runtimeConfiguration(input: RuntimeEvidenceInput): HookRuntimeConfiguration | GoTrueAuthHookStatus {
  const { envPrefix } = HOOK_CONFIGURATION[input.hookName];
  const enabled = input.environment[`GOTRUE_HOOK_${envPrefix}_ENABLED`]?.toLowerCase();
  if (enabled !== "true") return unavailable(input.hookName, "not_enabled");
  const uri = input.environment[`GOTRUE_HOOK_${envPrefix}_URI`] || "";
  if (!uri) return unavailable(input.hookName, "uri_missing");
  if (!hookTargetsProject(input.projectRef, input.projectConfig, input.hookName, uri)) {
    return unavailable(input.hookName, "target_mismatch");
  }
  const encodedSecrets = input.environment[`GOTRUE_HOOK_${envPrefix}_SECRETS`] || "";
  if (!encodedSecrets) return unavailable(input.hookName, "secret_missing");
  try {
    standardWebhookSigningKeys(encodedSecrets);
  } catch (error) {
    if (!(error instanceof StandardWebhookVerificationError)) throw error;
    return unavailable(input.hookName, "secret_invalid");
  }
  return { uri, configuredSecrets: encodedSecrets };
}

function probeBody(projectRef: string, hookName: GoTrueHttpHookName): string {
  return JSON.stringify({
    [PROBE_FIELD]: {
      version: 1,
      hook_name: hookName,
      project_ref: projectRef,
    },
  });
}

function validProbeResponse(
  payload: unknown,
  projectRef: string,
  hookName: GoTrueHttpHookName,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const probe = (payload as Record<string, unknown>)[PROBE_FIELD];
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) return false;
  const fields = probe as Record<string, unknown>;
  return fields.verified === true
    && fields.protocol === "standard-webhooks-v1"
    && fields.hook_name === hookName
    && fields.project_ref === projectRef;
}

async function probeRuntimeHook(
  input: RuntimeEvidenceInput,
  configuration: HookRuntimeConfiguration,
  fetcher: typeof fetch,
): Promise<GoTrueAuthHookStatus> {
  const body = probeBody(input.projectRef, input.hookName);
  const response = await sendProbe(configuration, body, fetcher);
  if (!response) return registeredButUnverified(input.hookName, "probe_unreachable");
  if (!response.ok) return registeredButUnverified(input.hookName, "probe_rejected");
  const payload = await probeResponsePayload(response);
  if (!payload) return registeredButUnverified(input.hookName, "probe_response_invalid");
  return validProbeResponse(payload, input.projectRef, input.hookName)
    ? verified(input.hookName)
    : registeredButUnverified(input.hookName, "probe_response_invalid");
}

async function sendProbe(
  configuration: HookRuntimeConfiguration,
  body: string,
  fetcher: typeof fetch,
): Promise<Response | null> {
  try {
    return await fetcher(configuration.uri, {
      method: "POST",
      headers: buildStandardWebhookHeaders({
        configuredSecrets: configuration.configuredSecrets,
        rawBody: Buffer.from(body),
      }),
      body,
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function probeResponsePayload(response: Response): Promise<unknown | null> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

export async function goTrueAuthHookStatusFromRuntime(
  input: RuntimeEvidenceInput,
  fetcher: typeof fetch = fetch,
): Promise<GoTrueAuthHookStatus> {
  const configuration = runtimeConfiguration(input);
  return "uri" in configuration
    ? probeRuntimeHook(input, configuration, fetcher)
    : configuration;
}

function systemdProperties(rawProperties: Buffer): Record<string, string> {
  return Object.fromEntries(rawProperties.toString("utf8")
    .split(/\r?\n/)
    .filter((property) => property.includes("="))
    .map((property) => {
      const separator = property.indexOf("=");
      return [property.slice(0, separator), property.slice(separator + 1)];
    }));
}

function positiveSystemdInteger(rawInteger: string | undefined): number | null {
  if (!rawInteger || !/^\d+$/.test(rawInteger)) return null;
  const parsedInteger = Number(rawInteger);
  return Number.isSafeInteger(parsedInteger) && parsedInteger > 1 ? parsedInteger : null;
}

function goTrueProcessIdentity(
  authorityProjectRef: string,
  properties: Record<string, string>,
): GoTrueProcessIdentity | null {
  const expectedIdentity = `supacloud-${authorityProjectRef}`;
  if (properties.User !== expectedIdentity || properties.Group !== expectedIdentity) return null;
  const pid = positiveSystemdInteger(properties.MainPID);
  const uid = positiveSystemdInteger(properties.UID);
  const gid = positiveSystemdInteger(properties.GID);
  return pid && uid && gid ? { pid, uid, gid } : null;
}

async function activeGoTrueIdentity(
  authorityProjectRef: string,
  runtime: GoTrueEnvironmentRuntime,
): Promise<GoTrueProcessIdentity | null> {
  if (!runtime.systemctlPath) return null;
  const unit = `supacloud-gotrue@${authorityProjectRef}`;
  const commandOutput = await runtime.run([
    runtime.systemctlPath, "show", unit, "--property=MainPID,User,Group,UID,GID", "--no-pager",
  ]);
  return commandOutput.exitCode === 0
    ? goTrueProcessIdentity(authorityProjectRef, systemdProperties(commandOutput.stdout))
    : null;
}

function hookEnvironment(rawEnvironment: Buffer, hookName: GoTrueHttpHookName): Record<string, string> {
  const envPrefix = HOOK_CONFIGURATION[hookName].envPrefix;
  const allowedNames = new Set(["ENABLED", "URI", "SECRETS"].map(
    (suffix) => `GOTRUE_HOOK_${envPrefix}_${suffix}`,
  ));
  const environment: Record<string, string> = {};
  for (const entry of rawEnvironment.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator) : "";
    if (allowedNames.has(name)) environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

export async function readActiveGoTrueHookEnvironment(
  authorityProjectRef: string,
  hookName: GoTrueHttpHookName,
  runtime: GoTrueEnvironmentRuntime = HOST_ENVIRONMENT_RUNTIME,
): Promise<Record<string, string> | null> {
  if (!PROJECT_REF_PATTERN.test(authorityProjectRef)
    || !runtime.setprivPath || !runtime.systemctlPath || !runtime.sedPath) return null;
  const identity = await activeGoTrueIdentity(authorityProjectRef, runtime);
  if (!identity) return null;
  const envPrefix = HOOK_CONFIGURATION[hookName].envPrefix;
  const commandOutput = await runtime.run([
    runtime.setprivPath, "--reuid", String(identity.uid), "--regid", String(identity.gid),
    "--clear-groups", "--", runtime.sedPath, "-z", "-n", "-E",
    `/^GOTRUE_HOOK_${envPrefix}_(ENABLED|URI|SECRETS)=/p`, `/proc/${identity.pid}/environ`,
  ]);
  return commandOutput.exitCode === 0 ? hookEnvironment(commandOutput.stdout, hookName) : null;
}

async function authorityRoutingConfig(
  projectRef: string,
  authorityRef: string,
  projectConfig: ProjectRoutingConfig | undefined,
): Promise<{ found: true; config?: ProjectRoutingConfig } | { found: false }> {
  if (authorityRef === projectRef) return { found: true, config: projectConfig };
  try {
    const authorityProject = await projectRepository.findByRef(authorityRef);
    if (!authorityProject) return { found: false };
    return {
      found: true,
      config: normalizeProjectRoutingConfig(normalizeProjectConfig(authorityProject.config)),
    };
  } catch {
    return { found: false };
  }
}

async function liveGoTrueEnvironment(
  authorityRef: string,
  hookName: GoTrueHttpHookName,
): Promise<Record<string, string> | null> {
  try {
    return await readActiveGoTrueHookEnvironment(authorityRef, hookName);
  } catch (error) {
    if (!(error instanceof RuntimeInspectionUnavailableError)) throw error;
    return null;
  }
}

function authorityStatus(
  status: GoTrueAuthHookStatus,
  authority: { ref: string; managedByOwner: boolean },
): GoTrueAuthHookStatus {
  return {
    ...status,
    authority_project_ref: authority.ref,
    managed_by_owner: authority.managedByOwner,
  };
}

export async function detectGoTrueAuthHookStatus(
  projectRef: string,
  hookName: GoTrueHttpHookName,
  projectConfig?: ProjectRoutingConfig,
): Promise<GoTrueAuthHookStatus> {
  const runtime = getAuthRuntimeDescriptor(projectRef);
  const authorityRef = runtime.authority_project_ref;
  const managedByOwner = runtime.mode === "shared";
  const authority = { ref: authorityRef, managedByOwner };
  const routing = await authorityRoutingConfig(projectRef, authorityRef, projectConfig);
  if (!routing.found) {
    return authorityStatus(unavailable(hookName, "authority_project_unavailable"), authority);
  }
  const environment = await liveGoTrueEnvironment(authorityRef, hookName);
  if (!environment) return authorityStatus(unavailable(hookName, "process_unavailable"), authority);
  const status = await goTrueAuthHookStatusFromRuntime({
    projectRef: authorityRef,
    hookName,
    projectConfig: routing.config,
    environment,
  });
  return authorityStatus(status, authority);
}
