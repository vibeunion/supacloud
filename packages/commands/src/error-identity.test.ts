import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CommandError } from "@supacloud/contracts";
import { commandContext, plaintextCommandInput } from "./context";

test("command transaction preserves a protocol failure from another package copy", async () => {
  const build = await Bun.build({ entrypoints: [fileURLToPath(import.meta.resolve("@supacloud/contracts"))], target: "node" });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Missing contracts bundle");
  const copy: typeof import("@supacloud/contracts") = await import(`data:text/javascript;base64,${Buffer.from(await output.text()).toString("base64")}`);
  expect(copy.CommandError).not.toBe(CommandError);
  for (const code of ["COMMAND_REJECTED", "COMMAND_IDEMPOTENCY_CONFLICT", "COMMAND_RECEIPT_INVALID"] as const) {
    const error = new copy.CommandError(code);
    const context = commandContext({
      name: "example", store: { transaction: async () => { throw error; } },
      input: (value: unknown) => value, result: (value: unknown) => value,
      inputCodec: plaintextCommandInput, authorize: () => "allow",
      audit: { event: "example", details: () => ({}) },
    });
    await expect(context.transaction(async () => true)).rejects.toBe(error);
  }
});
