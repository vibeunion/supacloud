import { readFile } from "node:fs/promises";
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

function processEnvironment(rawEnvironment: Buffer): Record<string, string> {
  return Object.fromEntries(rawEnvironment.toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 1 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
}

async function activeGoTrueEnvironment(authorityProjectRef: string): Promise<Record<string, string> | null> {
  const child = Bun.spawn(
    ["systemctl", "show", `supacloud-gotrue@${authorityProjectRef}`, "--property=MainPID", "--value"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const pid = Number(output.trim());
  if (exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 1) return null;
  return processEnvironment(await readFile(`/proc/${pid}/environ`));
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

async function liveGoTrueEnvironment(authorityRef: string): Promise<Record<string, string> | null> {
  try {
    return await activeGoTrueEnvironment(authorityRef);
  } catch {
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
  const environment = await liveGoTrueEnvironment(authorityRef);
  if (!environment) return authorityStatus(unavailable(hookName, "process_unavailable"), authority);
  const status = await goTrueAuthHookStatusFromRuntime({
    projectRef: authorityRef,
    hookName,
    projectConfig: routing.config,
    environment,
  });
  return authorityStatus(status, authority);
}
