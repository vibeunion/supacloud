import { describe, expect, mock, test } from "bun:test";
import { buildSchemaObject } from "../scripts/capture-snapshots";
import { runCliWithRetry } from "../scripts/run-official-cli-compliance";

function result(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

describe("CLI command result contract", () => {
  test("preserves successful command output without a retry", async () => {
    const output = result(0, "export type Database = {}", "");
    const command = mock(async () => output);
    expect(await runCliWithRetry("fixture", command)).toBe(output);
    expect(command).toHaveBeenCalledTimes(1);
  });

  test("preserves a non-transient failure", async () => {
    const output = result(1, "", "permission denied");
    const command = mock(async () => output);
    expect(await runCliWithRetry("fixture", command)).toBe(output);
    expect(command).toHaveBeenCalledTimes(1);
  });

  test("returns the final transient failure instead of an absent result", async () => {
    const output = result(1, "", "ECONNRESET");
    const command = mock(async () => output);
    expect(await runCliWithRetry("fixture", command, 1)).toBe(output);
    expect(command).toHaveBeenCalledTimes(1);
  });

  test("retries transient bootstrap output and returns the successful result", async () => {
    const output = result(0, "ready");
    const command = mock(async () => output)
      .mockResolvedValueOnce(result(1, "", "fetch failed"));
    expect(await runCliWithRetry("fixture", command, 2)).toBe(output);
    expect(command).toHaveBeenCalledTimes(2);
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid attempt count %s before running a command",
    async (maxAttempts) => {
      const command = mock(async () => result(0));
      await expect(runCliWithRetry("fixture", command, maxAttempts))
        .rejects.toThrow("positive safe integer");
      expect(command).not.toHaveBeenCalled();
    },
  );

  test("propagates command exceptions without fabricating a result", async () => {
    const command = mock(async () => { throw new Error("command unavailable"); });
    await expect(runCliWithRetry("fixture", command)).rejects.toThrow("command unavailable");
    expect(command).toHaveBeenCalledTimes(1);
  });
});

describe("snapshot structural output", () => {
  test("preserves primitive, nested object and array shapes", () => {
    expect(buildSchemaObject({
      users: [{ id: 1, enabled: true }], empty: [], nullable: null, name: "example",
    })).toEqual({
      empty: ["any"], name: "string", nullable: "null",
      users: [{ enabled: "boolean", id: "number" }],
    });
    expect(buildSchemaObject(false)).toBe("boolean");
    expect(buildSchemaObject(undefined)).toBe("undefined");
  });

  test("retains prototype-shaped JSON keys and sorts ordinary keys", () => {
    const input: unknown = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":false}');
    const shape = buildSchemaObject(input);
    if (typeof shape !== "object" || Array.isArray(shape)) throw new Error("Expected an object schema");
    expect(JSON.stringify(shape)).toBe('{"__proto__":{"polluted":"boolean"},"a":"boolean","z":"number"}');
    expect(Object.getPrototypeOf(shape)).toBe(Object.prototype);
    expect(Object.hasOwn(shape, "__proto__")).toBe(true);
  });
});
