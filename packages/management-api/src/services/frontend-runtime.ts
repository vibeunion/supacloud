import { copyFile, lstat, rm, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";

type SvelteKitSystemdUnitInput = {
  serviceName: string;
  runtimeUser: string;
  description: string;
  buildDir: string;
  envFile: string;
  port: number;
};

async function requireFile(path: string, message: string): Promise<void> {
  const entry = await stat(path).catch(() => null);
  if (!entry?.isFile()) throw new Error(message);
}

async function requireDirectory(path: string, message: string): Promise<void> {
  const entry = await stat(path).catch(() => null);
  if (!entry?.isDirectory()) throw new Error(message);
}

export function assertSystemdValue(value: string, label: string): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${label} contains unsupported systemd characters`);
  }
  return value;
}

export async function prepareSvelteKitRuntime(
  sourceDir: string,
  buildDir: string,
): Promise<void> {
  const entrypoint = join(buildDir, "index.js");
  const packageJson = join(sourceDir, "package.json");
  const sourceModules = join(sourceDir, "node_modules");
  const runtimeModules = join(buildDir, "node_modules");

  await requireFile(
    entrypoint,
    "SvelteKit SSR requires @sveltejs/adapter-node output at build/index.js; use framework=sveltekit-static for adapter-static output",
  );
  await requireFile(packageJson, "SvelteKit SSR requires the project package.json");
  await requireDirectory(
    sourceModules,
    "SvelteKit SSR production dependencies are missing; keep install_command enabled",
  );

  await copyFile(packageJson, join(buildDir, "package.json"));
  if (await lstat(runtimeModules).catch(() => null)) {
    await rm(runtimeModules, { recursive: true, force: true });
  }
  await symlink(relative(buildDir, sourceModules), runtimeModules, "dir");
}

export function renderSvelteKitSystemdUnit(input: SvelteKitSystemdUnitInput): string {
  const serviceName = assertSystemdValue(input.serviceName, "Service name");
  const runtimeUser = assertSystemdValue(input.runtimeUser, "Runtime user");
  const description = assertSystemdValue(input.description, "Description");
  const buildDir = assertSystemdValue(input.buildDir, "Build directory");
  const envFile = assertSystemdValue(input.envFile, "Environment file");
  const entrypoint = join(buildDir, "index.js");

  return `[Unit]
Description=SupaCloud Frontend SSR: ${description}
After=network.target

[Service]
Type=simple
User=${runtimeUser}
Group=${runtimeUser}
WorkingDirectory=${buildDir}
NoNewPrivileges=true
Environment="PORT=${input.port}"
Environment="NODE_ENV=production"
Environment="PROTOCOL_HEADER=x-forwarded-proto"
Environment="HOST_HEADER=x-forwarded-host"
Environment="PORT_HEADER=x-forwarded-port"
EnvironmentFile=${envFile}
ExecStart=/usr/bin/env node ${entrypoint}
Restart=always
RestartSec=5
LimitNOFILE=65536
SyslogIdentifier=${serviceName}

[Install]
WantedBy=multi-user.target
`;
}
