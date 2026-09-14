import { isRecord } from "../utils/project-config";
import type { AuthRuntimeDescriptor } from "./auth-runtime.service";

type RuntimeAuthority = Pick<AuthRuntimeDescriptor, "mode" | "authority_project_ref">;

export type AuthExecutionPolicy =
  | { mode: "local" | "owner"; localGoTrue: true; authorityRef: string }
  | { mode: "shared"; localGoTrue: false; authorityRef: string }
  | { mode: "external"; localGoTrue: false; upstream: string };

function configurationObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${field}: expected an object`);
  return value;
}

function aliasedString(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const read = (key: string): string | undefined => {
    if (!Object.hasOwn(value, key)) return undefined;
    const raw = value[key];
    if (typeof raw !== "string" || !raw.trim() || /[\r\n\0]/.test(raw)) {
      throw new Error(`Invalid third_party_auth.${key}`);
    }
    return raw.trim();
  };
  const primary = read(snake);
  const alias = read(camel);
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new Error(`Conflicting third_party_auth.${snake} aliases`);
  }
  return primary ?? alias;
}

export function resolveAuthExecutionPolicy(
  authority: RuntimeAuthority,
  rawConfig: unknown,
): AuthExecutionPolicy {
  // Platform ownership cannot be overridden by a child's external Auth settings.
  if (authority.mode === "shared") {
    return { mode: "shared", localGoTrue: false, authorityRef: authority.authority_project_ref };
  }
  if (authority.mode === "owner") {
    return { mode: "owner", localGoTrue: true, authorityRef: authority.authority_project_ref };
  }
  const local: AuthExecutionPolicy = {
    mode: "local", localGoTrue: true, authorityRef: authority.authority_project_ref,
  };
  // Missing legacy configuration means the default local runtime, not malformed JSON.
  if (rawConfig === null || rawConfig === undefined || rawConfig === "") return local;
  let decoded: unknown = rawConfig;
  if (typeof rawConfig === "string") {
    try {
      decoded = JSON.parse(rawConfig);
    } catch {
      throw new Error("Invalid project configuration JSON");
    }
  }
  const project = configurationObject(decoded, "project configuration");
  if (!Object.hasOwn(project, "auth")) return local;
  const auth = configurationObject(project.auth, "auth configuration");
  if (!Object.hasOwn(auth, "third_party_auth")) return local;
  const thirdParty = configurationObject(auth.third_party_auth, "third_party_auth");
  const enabled = Object.hasOwn(thirdParty, "enabled") ? thirdParty.enabled : false;
  if (typeof enabled !== "boolean") {
    throw new Error("Invalid third_party_auth.enabled: expected a boolean");
  }
  const mode = aliasedString(thirdParty, "auth_endpoint_mode", "authEndpointMode") ?? "external";
  if (mode !== "external" && mode !== "local") throw new Error("Invalid third_party_auth.auth_endpoint_mode");
  const upstream = aliasedString(thirdParty, "auth_upstream", "authUpstream");
  if (!enabled || mode === "local") return local;
  if (upstream === undefined) throw new Error("External Auth requires third_party_auth.auth_upstream");
  return { mode: "external", localGoTrue: false, upstream };
}

export function assertLocalGoTrueExecution(policy: AuthExecutionPolicy): void {
  if (!policy.localGoTrue) {
    throw new Error(`Local GoTrue control is disabled for ${policy.mode} Auth`);
  }
}
