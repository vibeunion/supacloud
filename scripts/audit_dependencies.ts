import { spawn } from "node:child_process";

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 30_000;

export function isTransientAuditFailure(output: string): boolean {
  return /\b(?:408|425|429|5\d\d)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|network timeout/i.test(output);
}

function runAudit(): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["audit", "--audit-level", "high"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, npm_config_registry: "https://registry.npmjs.org" },
    });
    let output = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      output += "\nnetwork timeout while running bun audit\n";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, ATTEMPT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (error) => {
      output += error.message;
      finish(1);
    });
  });
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await runAudit();
    process.stdout.write(result.output);
    if (result.code === 0) return;
    if (!isTransientAuditFailure(result.output) || attempt === MAX_ATTEMPTS) {
      process.exitCode = result.code;
      return;
    }
    const delayMs = 1_000 * 2 ** (attempt - 1);
    console.error(`bun audit transient service failure; retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    await Bun.sleep(delayMs);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed to run dependency audit:", error);
    process.exitCode = 1;
  });
}
