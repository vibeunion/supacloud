import pkg from "../package.json";

function writeStandaloneIdentity(identity: string): void {
  process.stdout.write(`${identity}\n`);
}

export function isStandaloneVersionCommand(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

export function isSystemdUnitBrokerDigestCommand(args: string[]): boolean {
  return args.length === 1 && args[0] === "--systemd-unit-helper-sha256";
}

export function isPostgrestLauncherDigestCommand(args: string[]): boolean {
  return args.length === 1 && args[0] === "--postgrest-launcher-sha256";
}

export function isPostgrestProcessIdentityProbeCommand(args: string[]): boolean {
  return args.length === 4 && args[0] === "--postgrest-process-identity-probe-v1";
}

export function isPostgrestProcessIdentityTerminationCommand(args: string[]): boolean {
  return args.length === 5 && args[0] === "--postgrest-process-identity-terminate-v1";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (isStandaloneVersionCommand(args)) {
    writeStandaloneIdentity(`SupaCloud Version: ${pkg.version}`);
  } else if (isSystemdUnitBrokerDigestCommand(args)) {
    const { EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256 } = await import("./embedded-systemd-unit-broker");
    writeStandaloneIdentity(`SupaCloud systemd-unit helper SHA-256: ${EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256}`);
  } else if (isPostgrestLauncherDigestCommand(args)) {
    const { EMBEDDED_POSTGREST_LAUNCHER_SHA256 } = await import("./embedded-postgrest-launcher");
    writeStandaloneIdentity(`SupaCloud PostgREST launcher SHA-256: ${EMBEDDED_POSTGREST_LAUNCHER_SHA256}`);
  } else if (isPostgrestProcessIdentityProbeCommand(args)) {
    const { runPostgrestProcessIdentityProbe } = await import("./services/postgrest-process-identity");
    process.exitCode = await runPostgrestProcessIdentityProbe(args.slice(1));
  } else if (isPostgrestProcessIdentityTerminationCommand(args)) {
    const { runPostgrestProcessIdentityTermination } = await import("./services/postgrest-process-identity");
    process.exitCode = await runPostgrestProcessIdentityTermination(args.slice(1));
  } else {
    const { startManagementApi } = await import("./index");
    startManagementApi();
  }
}
