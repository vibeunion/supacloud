import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareStarterSourceFixture } from "./lib/starter-source-fixture";

const postgresBin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
if (!postgresBin) throw new Error("SUPACLOUD_STARTER_POSTGRES_BIN is required");
const root = await mkdtemp(join(tmpdir(), "starter-browser-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted = false;
const stop = () => { interrupted = true; child?.kill("SIGTERM"); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await prepareStarterSourceFixture(root);
  for (const name of ["starter-browser", "starter-browser-client"]) {
    await copyFile(resolve(import.meta.dir, "fixtures", name + ".fixture"), join(root, "tests", name + ".ts"));
  }
  if (interrupted) throw new Error("Browser fixture setup interrupted");
  const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
  { stdout: "ignore", stderr: "pipe" });
  child = certificate;
  const certificateError = new Response(certificate.stderr).text();
  if (await certificate.exited !== 0) throw new Error(await certificateError);
  await certificateError;
  if (interrupted) throw new Error("Browser fixture setup interrupted");
  child = Bun.spawn([process.execPath, "run", "--no-env-file", "--tsconfig-override", join(root, "tsconfig.json"),
    "tests/starter-browser.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LC_ALL: "C", LANG: "C",
      SUPACLOUD_STARTER_POSTGRES_BIN: postgresBin },
    stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  if (child?.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await rm(root, { recursive: true, force: true });
}
