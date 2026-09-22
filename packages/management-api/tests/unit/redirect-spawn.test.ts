import { describe, expect, test } from "bun:test";
import { redirectSpawn, type SpawnInvocation } from "../helpers/redirect-spawn";

describe("real subprocess redirection", () => {
  test("preserves piped stdin, stdout, stderr and environment for command-array calls", async () => {
    const invocations: SpawnInvocation[] = [];
    const redirected = redirectSpawn((invocation) => {
      invocations.push(invocation);
      return [process.execPath, "-e", `
        import { readFileSync, writeFileSync } from "node:fs";
        writeFileSync(1, readFileSync(0));
        writeFileSync(2, process.env.FIXTURE_MARKER);
      `];
    });
    try {
      const child = redirected.spawn(["fixture-command", "argument"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FIXTURE_MARKER: "redirect-environment" },
      });
      child.stdin.write("real input");
      child.stdin.end();
      expect(await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])).toEqual(["real input", "redirect-environment", 0]);
      expect(child.pid).toBeGreaterThan(0);
      expect(invocations.map(({ cmd }) => cmd)).toEqual([["fixture-command", "argument"]]);
    } finally {
      await redirected.close();
    }
  });

  test("preserves exit callbacks and nonzero exit status for options-object calls", async () => {
    const exit = Promise.withResolvers<{ pid: number; code: number | null }>();
    const redirected = redirectSpawn(() => [process.execPath, "-e", "process.exit(9)"]);
    try {
      const child = redirected.spawn({
        cmd: ["fixture-command"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        onExit(process, code) {
          exit.resolve({ pid: process.pid, code });
        },
      });
      expect(await child.exited).toBe(9);
      expect(await exit.promise).toEqual({ pid: child.pid, code: 9 });
    } finally {
      await redirected.close();
    }
  });

  test("closes and reaps a still-running subprocess", async () => {
    const redirected = redirectSpawn(() => [process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    const child = redirected.spawn(["fixture-command"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    try {
      await redirected.close();
      expect(child.killed).toBe(true);
      expect(await child.exited).not.toBe(0);
      await redirected.close();
    } finally {
      await redirected.close();
    }
  });

  test("rejects an unexpected invocation before starting a subprocess", async () => {
    const redirected = redirectSpawn(() => { throw new Error("Unexpected command"); });
    try {
      expect(() => redirected.spawn(["not-a-real-command"])).toThrow("Unexpected command");
    } finally {
      await redirected.close();
    }
  });
});
