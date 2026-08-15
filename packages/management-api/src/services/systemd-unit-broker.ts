import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";

const REQUEST_DIR = "/run/supacloud-unit-requests";
const MANAGED_UNIT_PATTERN = /^(?:supacloud-(?:pgrst|gotrue)@\.service|supacloud-frontend-[a-z0-9-]{1,64}\.service)$/;
const MANAGED_IDENTITY_PATTERN = /^supacloud-(?:%i|[a-z0-9-]{1,20})$/;
const MAX_UNIT_BYTES = 16 * 1024;
const UNIT_DIRECTIVES = new Set(["After", "Description", "Documentation", "Wants"]);
const SERVICE_DIRECTIVES = new Set([
  "CPUWeight", "Environment", "EnvironmentFile", "ExecReload", "ExecStart",
  "Group", "LimitNOFILE", "MemoryMax", "NoNewPrivileges", "ProtectHome",
  "ProtectSystem", "ReadOnlyPaths", "Restart", "RestartSec", "StartLimitBurst",
  "StartLimitIntervalSec", "SyslogIdentifier", "Type", "User", "WorkingDirectory",
]);
const INSTALL_DIRECTIVES = new Set(["WantedBy"]);

async function runSystemctl(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn({ cmd: ["systemctl", ...args], stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr };
}

function assertManagedUnitName(unitName: string): void {
  if (!MANAGED_UNIT_PATTERN.test(unitName)) {
    throw new Error(`Systemd unit ${unitName} is outside the SupaCloud allow-list`);
  }
}

function allowedDirectives(section: string): ReadonlySet<string> | undefined {
  if (section === "Unit") return UNIT_DIRECTIVES;
  if (section === "Service") return SERVICE_DIRECTIVES;
  if (section === "Install") return INSTALL_DIRECTIVES;
  return undefined;
}

type UnitPolicyState = {
  section: string;
  sections: Set<string>;
  user: string;
  group: string;
  noNewPrivileges: boolean;
  environmentFile: string;
};

function enterSection(unitName: string, state: UnitPolicyState, section: string): void {
  if (state.sections.has(section)) throw new Error(`Systemd unit ${unitName} repeats [${section}]`);
  state.sections.add(section);
  state.section = section;
}

function recordIdentity(unitName: string, state: UnitPolicyState, key: string, value: string): void {
  if (key !== "User" && key !== "Group") return;
  const existing = key === "User" ? state.user : state.group;
  if (existing || !MANAGED_IDENTITY_PATTERN.test(value)) throw new Error(`Systemd unit ${unitName} has an invalid ${key}`);
  if (key === "User") state.user = value;
  else state.group = value;
}

function isAllowedEnvironmentFile(unitName: string, value: string): boolean {
  if (unitName === "supacloud-pgrst@.service") {
    return /^\/etc\/supabase\/[A-Za-z0-9_-]{1,64}\/%i\.env$/.test(value);
  }
  if (unitName === "supacloud-gotrue@.service") {
    return /^\/etc\/supabase\/[A-Za-z0-9_-]{1,64}\/%i_gotrue\.env$/.test(value);
  }
  const match = value.match(/^\/var\/supacloud\/frontends\/([a-z0-9-]{1,20})\/([a-f0-9]{8})\/\.env$/);
  return !!match && unitName === `supacloud-frontend-${match[1]}-${match[2]}.service`;
}

function recordEnvironmentFile(unitName: string, state: UnitPolicyState, key: string, value: string): void {
  if (key !== "EnvironmentFile") return;
  if (state.environmentFile || !isAllowedEnvironmentFile(unitName, value)) {
    throw new Error(`Systemd unit ${unitName} has an invalid EnvironmentFile`);
  }
  state.environmentFile = value;
}

function validateDirective(unitName: string, state: UnitPolicyState, line: string): void {
  const match = line.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/);
  if (!match || !allowedDirectives(state.section)?.has(match[1]!)) {
    throw new Error(`Systemd unit ${unitName} contains an unsupported directive`);
  }
  const key = match[1]!;
  const value = match[2]!;
  if ((key === "ExecStart" || key === "ExecReload") && /^[-+!:@|]/.test(value)) {
    throw new Error(`Systemd unit ${unitName} uses a privileged execution prefix`);
  }
  if (key === "NoNewPrivileges") {
    if (state.noNewPrivileges || value !== "true") throw new Error(`Systemd unit ${unitName} must enforce NoNewPrivileges`);
    state.noNewPrivileges = true;
  }
  recordIdentity(unitName, state, key, value);
  recordEnvironmentFile(unitName, state, key, value);
}

function validateUnitIdentity(unitName: string, state: UnitPolicyState): void {
  const requiresEnvironmentFile = unitName !== "supacloud-pgrst@.service";
  if (!["Unit", "Service", "Install"].every((required) => state.sections.has(required))
    || !state.user || state.user !== state.group || !state.noNewPrivileges
    || (requiresEnvironmentFile && !state.environmentFile)) {
    throw new Error(`Systemd unit ${unitName} is missing its non-root runtime identity`);
  }
  if (unitName.includes("@") && state.user !== "supacloud-%i") {
    throw new Error(`Systemd template ${unitName} must use the tenant instance identity`);
  }
  if (unitName.startsWith("supacloud-frontend-") && !unitName.startsWith(`supacloud-frontend-${state.user.slice(10)}-`)) {
    throw new Error(`Systemd unit ${unitName} does not match its tenant identity`);
  }
}

export function assertManagedSystemdUnitContent(unitName: string, content: string): void {
  if (!content || Buffer.byteLength(content, "utf8") > MAX_UNIT_BYTES || /[\x00-\x09\x0b-\x1f\x7f]/.test(content)) {
    throw new Error(`Systemd unit ${unitName} has invalid content`);
  }
  const state: UnitPolicyState = {
    section: "", sections: new Set(), user: "", group: "", noNewPrivileges: false, environmentFile: "",
  };
  for (const line of content.split("\n")) {
    if (!line || /^\s*[#;]/.test(line)) continue;
    if (line.endsWith("\\")) throw new Error(`Systemd unit ${unitName} uses a line continuation`);
    const section = line.match(/^\[(Unit|Service|Install)\]$/)?.[1];
    if (section) enterSection(unitName, state, section);
    else validateDirective(unitName, state, line);
  }
  validateUnitIdentity(unitName, state);
}

async function executeBrokerRequest(operation: "install" | "remove", unitName: string, content?: string): Promise<void> {
  assertManagedUnitName(unitName);
  await mkdir(REQUEST_DIR, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const requestPath = `${REQUEST_DIR}/${token}.request`;
  const sourcePath = `${REQUEST_DIR}/${token}.unit`;
  try {
    if (content !== undefined) {
      assertManagedSystemdUnitContent(unitName, content);
      await writeFile(sourcePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    await writeFile(
      requestPath,
      `operation=${operation}\nunit_name=${unitName}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const result = await runSystemctl(["--wait", "start", `supacloud-systemd-unit@${token}.service`]);
    if (result.exitCode !== 0) {
      throw new Error(`Systemd unit broker failed for ${unitName}: ${result.stderr.trim().slice(0, 300)}`);
    }
  } finally {
    await rm(requestPath, { force: true });
    await rm(sourcePath, { force: true });
  }
}

export function installManagedSystemdUnit(unitName: string, content: string): Promise<void> {
  return executeBrokerRequest("install", unitName, content);
}

export function removeManagedSystemdUnit(unitName: string): Promise<void> {
  return executeBrokerRequest("remove", unitName);
}
