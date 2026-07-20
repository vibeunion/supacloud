import { describe, expect, test } from "bun:test";
import { runBootstrapOrExit, terminateFatalProcess } from "../../src/runtime/bootstrap-fatal";

describe("management API fatal bootstrap handling", () => {
  test("normal bootstrap resolves without invoking fatal exit", async () => {
    let served = false;
    let fatalCalls = 0;
    await runBootstrapOrExit(
      async () => { served = true; },
      () => { fatalCalls += 1; },
    );
    expect(served).toBe(true);
    expect(fatalCalls).toBe(0);
  });

  test("bootstrap rejection invokes the fatal path", async () => {
    let exitCode: number | undefined;
    let message = "";
    await runBootstrapOrExit(
      async () => { throw new Error("bootstrap failed"); },
      (entry, reason) => {
        message = `${entry} ${reason instanceof Error ? reason.message : String(reason)}`;
        exitCode = 1;
      },
    );
    expect(message).toContain("FATAL BOOTSTRAP FAILURE");
    expect(message).toContain("bootstrap failed");
    expect(exitCode).toBe(1);
  });

  test("fatal process logging includes a code location and exits nonzero", () => {
    let exitCode: number | undefined;
    let metadata: Record<string, unknown> | undefined;
    terminateFatalProcess(
      "FATAL TEST:",
      new Error("test failure"),
      (code) => { exitCode = code; },
      (_message, entry) => { metadata = entry; },
    );
    expect(exitCode).toBe(1);
    expect(metadata?.reason).toBe("test failure");
    expect(metadata?.stack).toContain("bootstrap-fatal.test.ts");
  });
});
