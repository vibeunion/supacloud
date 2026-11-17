import { expect, test } from "bun:test";

test("Bun-native tenant sandbox blocks subprocess and out-of-project filesystem access", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    const { disableSubprocessApis, initializeProjectRootControl } = await import("./runtime-sandbox.ts");
    const setProjectRoot = initializeProjectRootControl();
    disableSubprocessApis();
    setProjectRoot(import.meta.dir);
    const checks = {
      spawn: (() => { try { Bun.spawn(["true"]); return false; } catch { return true; } })(),
      file: (() => { try { Bun.file("/etc/hosts"); return false; } catch { return true; } })(),
    };
    console.log("RESULT=" + JSON.stringify(checks));
  `], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT="));
  expect(line).toBeDefined();
  expect(JSON.parse(line!.slice("RESULT=".length))).toEqual({ spawn: true, file: true });
});
