import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { CommandError } from "./command_error";

const directory = await mkdtemp(join(tmpdir(), "command-error-identity-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

// Build independently, as happens with duplicate installed packages and dual
// entrypoints. Importing the same source twice can hide identity regressions.
for (const format of ["esm", "cjs"] as const) {
  test(`CommandError recognizes independently bundled ${format} errors`, async () => {
    const file = `copy.${format === "esm" ? "mjs" : "cjs"}`;
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./command_error.ts", import.meta.url))],
      outdir: directory, naming: file, format, target: "node",
    });
    expect(build.success).toBe(true);
    const copy: typeof import("./command_error") = format === "esm"
      ? await import(pathToFileURL(join(directory, file)).href)
      : createRequire(import.meta.url)(join(directory, file));
    expect(copy.CommandError).not.toBe(CommandError);
    const error = new copy.CommandError("COMMAND_REJECTED");
    expect(error instanceof CommandError).toBe(true);
    expect(new CommandError("COMMAND_IDEMPOTENCY_CONFLICT") instanceof copy.CommandError).toBe(true);
    expect(error.metadata.outcome).toBe("confirmed-failure");
  });
}

test("CommandError preserves subclass semantics and rejects lookalikes", () => {
  class SpecializedError extends CommandError {}
  expect(new SpecializedError("COMMAND_REJECTED") instanceof CommandError).toBe(true);
  expect(new SpecializedError("COMMAND_REJECTED") instanceof SpecializedError).toBe(true);
  expect(new CommandError("COMMAND_REJECTED") instanceof SpecializedError).toBe(false);
  const brand = Symbol.for("@supacloud/contracts/CommandError/v1");
  for (const value of [null, undefined, "COMMAND_REJECTED",
    { name: "CommandError", code: "COMMAND_REJECTED" },
    { [brand]: true, code: "COMMAND_REJECTED" },
    Object.assign(new Error("secret SQL"), { name: "CommandError", code: "COMMAND_REJECTED" }),
    Object.assign(new Error(), { [brand]: true, code: "NOT_A_PROTOCOL_CODE" }),
  ]) expect(value instanceof CommandError).toBe(false);
  const hostile = new Proxy(new Error(), { getOwnPropertyDescriptor() { throw new Error("private cause"); } });
  expect(hostile instanceof CommandError).toBe(false);
  const revoked = Proxy.revocable(new Error(), {});
  revoked.revoke();
  expect(revoked.proxy instanceof CommandError).toBe(false);
  const accessor = Object.defineProperty(new Error(), "code", { get() { throw new Error("must not run"); } });
  Object.defineProperty(accessor, brand, { value: true });
  expect(accessor instanceof CommandError).toBe(false);
  expect(Object.keys(new CommandError("COMMAND_REJECTED"))).toEqual(["code", "name"]);
});
