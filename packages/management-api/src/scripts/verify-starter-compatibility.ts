import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyStarterCompatibility, type StarterCompatibilityPolicy } from "../services/application-starter-compatibility";

// Compile this entry as the root-owned "verify" executable. Policy is installed
// beside it, not supplied by an application or read from inherited environment.
export async function runStarterCompatibilityCommand(args = process.argv.slice(2)) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--policy")) throw new Error("Invalid arguments");
  const path = args.length ? resolve(args[1]!) : join(dirname(process.execPath), "starter-policy.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid?.()
    || (info.mode & 0o077) !== 0 || info.size > 262144) throw new Error("Untrusted policy");
  const policy = JSON.parse(await readFile(path, "utf8")) as StarterCompatibilityPolicy;
  if (args.length === 0 && policy.bun_executable !== undefined) {
    throw new Error("STARTER_COMPATIBILITY_NOT_VERIFIED:runtime");
  }
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1048576) throw new Error("Request too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return verifyStarterCompatibility(JSON.parse(Buffer.concat(chunks).toString("utf8")), policy);
}

if (import.meta.main) {
  const timer = setTimeout(() => process.exit(1), 25000);
  try { console.log(JSON.stringify(await runStarterCompatibilityCommand())); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(/^STARTER_COMPATIBILITY_NOT_VERIFIED:[a-z-]+$/.test(message)
      ? message : "STARTER_COMPATIBILITY_NOT_VERIFIED:request");
    process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
