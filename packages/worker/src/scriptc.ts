import { access, constants, stat } from "node:fs/promises";

export interface ScriptcBuildOptions {
  source: string;
  output: string;
  cwd?: string;
  dynamic?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
}

function executable(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error("WORKER_SCRIPTC_INVALID");
  return value;
}

export function resolveScriptcPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const configured = environment.SUPACLOUD_SCRIPTC_PATH;
  if (configured !== undefined) return executable(configured);
  return Bun.which("scriptc");
}

export async function requireScriptcPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const path = resolveScriptcPath(environment);
  if (path === null) throw new Error("WORKER_SCRIPTC_UNAVAILABLE");
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error("WORKER_SCRIPTC_UNAVAILABLE");
  }
  return path;
}

export async function buildScriptcWorker(options: ScriptcBuildOptions): Promise<void> {
  const compiler = await requireScriptcPath(options.environment);
  const args = ["build", executable(options.source), ...(options.dynamic ? ["--dynamic"] : []),
    "-o", executable(options.output)];
  const child = Bun.spawn([compiler, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.environment === undefined ? {} : { env: { ...options.environment } }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(detail ? `WORKER_SCRIPTC_BUILD_FAILED: ${detail}` : "WORKER_SCRIPTC_BUILD_FAILED");
  }
  try {
    const output = await stat(options.output);
    if (!output.isFile() || output.size === 0) throw new Error("WORKER_SCRIPTC_BUILD_FAILED");
  } catch {
    throw new Error("WORKER_SCRIPTC_BUILD_FAILED");
  }
}
